"""Phase 2 tests: SQLite persistence + replay query layer."""

import importlib

import pytest

from backend.main import GraphEvent


@pytest.fixture
def storage(tmp_path):
    """Fresh storage module bound to a temp DB file."""
    import backend.storage as st
    st._conn = None
    st.DB_PATH = tmp_path / "test.db"
    yield st
    if st._conn:
        st._conn.close()
    st._conn = None


def _ev(**kw):
    return GraphEvent(**kw)


def test_persist_and_list_runs(storage):
    rid = "r1"
    storage.persist_event(_ev(event_type="graph_init", run_id=rid, ts=100.0,
                              structure={"nodes": [{"id": "a"}], "links": []},
                              full_state={"x": 0}))
    storage.persist_event(_ev(event_type="node_start", run_id=rid, step=1,
                              node_name="a", ts=101.0))
    storage.persist_event(_ev(event_type="node_end", run_id=rid, step=1,
                              node_name="a", ts=102.0, duration_ms=12.5,
                              full_state={"x": 1}, state_delta={"changed": {"x": {"old": 0, "new": 1}}},
                              tokens={"input": 3, "output": 5, "total": 8}, cost_usd=0.001))
    storage.persist_event(_ev(event_type="run_end", run_id=rid, ts=103.0))

    runs = storage.list_runs()
    assert len(runs) == 1
    run = runs[0]
    assert run["run_id"] == rid
    assert run["status"] == "completed"
    assert run["total_tokens"] == 8
    assert abs(run["total_cost"] - 0.001) < 1e-9


def test_get_run_includes_structure(storage):
    rid = "r2"
    storage.persist_event(_ev(event_type="graph_init", run_id=rid, ts=1.0,
                              structure={"nodes": [{"id": "n"}], "links": []},
                              full_state={}))
    run = storage.get_run(rid)
    assert run["structure"]["nodes"] == [{"id": "n"}]
    assert storage.get_run("missing") is None


def test_events_ordered_by_step(storage):
    rid = "r3"
    storage.persist_event(_ev(event_type="graph_init", run_id=rid, ts=1.0, full_state={}))
    # Insert out of order; query must return ascending by step.
    storage.persist_event(_ev(event_type="node_end", run_id=rid, step=2,
                              node_name="b", ts=3.0, full_state={"k": 2}))
    storage.persist_event(_ev(event_type="node_end", run_id=rid, step=1,
                              node_name="a", ts=2.0, full_state={"k": 1}))
    events = storage.get_events(rid)
    steps = [e["step"] for e in events]
    assert steps == sorted(steps)
    # Stored JSON columns are re-hydrated into the flat event shape.
    end_events = [e for e in events if e["event_type"] == "node_end"]
    assert end_events[0]["full_state"] == {"k": 1}


def test_error_run_status(storage):
    rid = "r4"
    storage.persist_event(_ev(event_type="graph_init", run_id=rid, ts=1.0, full_state={}))
    storage.persist_event(_ev(event_type="node_error", run_id=rid, step=1, node_name="a",
                              ts=2.0, error={"type": "ValueError", "message": "x",
                                             "traceback": "..."}))
    storage.persist_event(_ev(event_type="run_end", run_id=rid, ts=3.0))
    # run_end must NOT downgrade an errored run to "completed".
    assert storage.get_run(rid)["status"] == "error"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
