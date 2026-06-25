"""Local SQLite persistence (stdlib sqlite3, zero heavy deps).

Two tables:
  runs    — one row per run (summary + structure)
  events  — every event, ordered by step, for replay / time travel

The DB lives next to the project (``visualizer.db``) and is gitignored.
Everything stays on the local machine — no external calls.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "visualizer.db"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                started_at REAL,
                status TEXT,
                structure_json TEXT,
                total_tokens INTEGER DEFAULT 0,
                total_cost REAL DEFAULT 0
            )
            """
        )
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT,
                step INTEGER,
                event_type TEXT,
                node_name TEXT,
                ts REAL,
                duration_ms REAL,
                tokens_json TEXT,
                cost_usd REAL,
                state_json TEXT,
                delta_json TEXT,
                error_json TEXT
            )
            """
        )
        _conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, step, id)"
        )
        _conn.commit()
    return _conn


def _dumps(obj) -> str | None:
    return json.dumps(obj) if obj else None


def persist_event(event) -> None:
    """Persist one event and keep the run summary up to date."""
    with _lock:
        conn = _connect()
        et = event.event_type

        if et == "graph_init":
            conn.execute(
                """INSERT OR REPLACE INTO runs
                   (run_id, started_at, status, structure_json, total_tokens, total_cost)
                   VALUES (?, ?, 'running', ?,
                           COALESCE((SELECT total_tokens FROM runs WHERE run_id=?), 0),
                           COALESCE((SELECT total_cost   FROM runs WHERE run_id=?), 0))""",
                (event.run_id, event.ts, _dumps(event.structure),
                 event.run_id, event.run_id),
            )
        elif et == "run_end":
            # Keep an 'error' status if any node already failed.
            conn.execute(
                """UPDATE runs SET status =
                       CASE WHEN status='error' THEN 'error' ELSE ? END
                   WHERE run_id=?""",
                (event.error.get("status", "completed") if event.error else "completed",
                 event.run_id),
            )
            conn.commit()
            return  # run_end is a control event; not stored in events table

        # Store the event row (skip the control event above).
        conn.execute(
            """INSERT INTO events
               (run_id, step, event_type, node_name, ts, duration_ms,
                tokens_json, cost_usd, state_json, delta_json, error_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                event.run_id, event.step, et, event.node_name, event.ts,
                event.duration_ms, _dumps(event.tokens), event.cost_usd,
                _dumps(event.full_state), _dumps(event.state_delta),
                _dumps(event.error),
            ),
        )

        if et == "node_end":
            tokens = (event.tokens or {}).get("total", 0) or 0
            cost = event.cost_usd or 0
            conn.execute(
                """UPDATE runs SET total_tokens = total_tokens + ?,
                                   total_cost   = total_cost + ?
                   WHERE run_id=?""",
                (tokens, cost, event.run_id),
            )
        elif et == "node_error":
            conn.execute(
                "UPDATE runs SET status='error' WHERE run_id=?", (event.run_id,)
            )
        conn.commit()


def list_runs() -> list[dict]:
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_run(run_id: str) -> dict | None:
    with _lock:
        conn = _connect()
        row = conn.execute(
            "SELECT * FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if row is None:
            return None
        run = dict(row)
        run["structure"] = json.loads(run["structure_json"]) if run["structure_json"] else None
        return run


def get_events(run_id: str) -> list[dict]:
    """All events for a run, ordered by step then insertion order."""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM events WHERE run_id=? ORDER BY step ASC, id ASC",
            (run_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        # Re-hydrate JSON columns into the flat event shape the frontend uses.
        out.append(
            {
                "id": d["id"],
                "run_id": d["run_id"],
                "step": d["step"],
                "event_type": d["event_type"],
                "node_name": d["node_name"],
                "ts": d["ts"],
                "duration_ms": d["duration_ms"],
                "tokens": json.loads(d["tokens_json"]) if d["tokens_json"] else None,
                "cost_usd": d["cost_usd"],
                "full_state": json.loads(d["state_json"]) if d["state_json"] else {},
                "state_delta": json.loads(d["delta_json"]) if d["delta_json"] else {},
                "error": json.loads(d["error_json"]) if d["error_json"] else None,
            }
        )
    return out
