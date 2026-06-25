"""Structure extraction + execution tracing for LangGraph.

Two complementary data sources, correlated by a single ``run_id``:

* ``VisualizerCallbackHandler`` (a ``BaseCallbackHandler``) — timing, tokens,
  cost and errors, captured live as the graph runs.
* ``graph.stream(stream_mode=["updates", "values"])`` — the reliable source of
  per-step ``full_state`` snapshots.

The high-level entry point is :func:`watch`, which wraps a compiled graph so a
single ``watch(graph).invoke(inputs)`` call streams events to the backend with
zero changes to the user's graph definition.
"""

from __future__ import annotations

import time
import traceback
import uuid
from collections import defaultdict, deque
from typing import Any, Optional

from langchain_core.callbacks import BaseCallbackHandler

from .client import EventClient

# ---------------------------------------------------------------------------
# Cost table: USD per 1M tokens (input, output). Unknown models -> cost = None.
# ---------------------------------------------------------------------------
DEFAULT_COST_TABLE: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4.1": {"input": 2.00, "output": 8.00},
    "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
    "gpt-3.5-turbo": {"input": 0.50, "output": 1.50},
}


def _to_jsonable(obj: Any, _depth: int = 0) -> Any:
    """Best-effort conversion of arbitrary state values to JSON-safe data."""
    if _depth > 8:
        return str(obj)
    if obj is None or isinstance(obj, (bool, int, float, str)):
        return obj
    if isinstance(obj, dict):
        return {str(k): _to_jsonable(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_to_jsonable(v, _depth + 1) for v in obj]
    # LangChain messages and similar objects expose .content / .type
    content = getattr(obj, "content", None)
    if content is not None and hasattr(obj, "type"):
        return {
            "type": getattr(obj, "type", obj.__class__.__name__),
            "content": _to_jsonable(content, _depth + 1),
        }
    model_dump = getattr(obj, "model_dump", None)
    if callable(model_dump):
        try:
            return _to_jsonable(model_dump(), _depth + 1)
        except Exception:
            pass
    return str(obj)


def extract_structure(compiled_graph: Any) -> dict:
    """Auto-extract ``{"nodes": [...], "links": [...]}`` from a compiled graph."""
    g = compiled_graph.get_graph()
    nodes = [
        {"id": n.id, "label": getattr(n, "name", None) or n.id}
        for n in g.nodes.values()
    ]
    links = [
        {"source": e.source, "target": e.target} for e in g.edges
    ]
    return {"nodes": nodes, "links": links}


def _is_graph_node(tags: Optional[list], metadata: Optional[dict]) -> bool:
    """True only for genuine graph node executions (not nested seq/internal)."""
    if not (metadata or {}).get("langgraph_node"):
        return False
    return any(str(t).startswith("graph:step:") for t in (tags or []))


class VisualizerCallbackHandler(BaseCallbackHandler):
    """Captures timing / tokens / cost / errors for a single run.

    ``full_state`` is NOT captured here — it comes from the stream loop in
    :class:`WatchedGraph`. This handler exposes :meth:`pop_completed` so the
    stream loop can enrich its ``node_end`` events with timing/token data.
    """

    def __init__(
        self,
        client: EventClient,
        run_id: str,
        cost_table: Optional[dict] = None,
    ):
        self._client = client
        self._run_id = run_id
        self._cost_table = cost_table if cost_table is not None else DEFAULT_COST_TABLE
        self._step = 0
        # run_id(str) -> {"node", "step", "start", "tokens", "cost"}
        self._active: dict[str, dict] = {}
        # node_name -> FIFO of finished execution records
        self._completed: dict[str, deque] = defaultdict(deque)
        self._current_run_id: Optional[str] = None  # for LLM token attribution

    # -- node lifecycle ----------------------------------------------------
    def on_chain_start(self, serialized, inputs, **kwargs):
        if not _is_graph_node(kwargs.get("tags"), kwargs.get("metadata")):
            return
        node = kwargs["metadata"]["langgraph_node"]
        run_id = str(kwargs.get("run_id"))
        self._step += 1
        self._active[run_id] = {
            "node": node,
            "step": self._step,
            "start": time.perf_counter(),
            "tokens": {"input": 0, "output": 0, "total": 0},
            "cost": 0.0,
            "has_tokens": False,
        }
        self._current_run_id = run_id
        self._client.post_event(
            {
                "event_type": "node_start",
                "run_id": self._run_id,
                "step": self._step,
                "node_name": node,
                "ts": time.time(),
            }
        )

    def on_chain_end(self, outputs, **kwargs):
        run_id = str(kwargs.get("run_id"))
        rec = self._active.pop(run_id, None)
        if rec is None:
            return
        if self._current_run_id == run_id:
            self._current_run_id = None
        duration_ms = (time.perf_counter() - rec["start"]) * 1000.0
        self._completed[rec["node"]].append(
            {
                "step": rec["step"],
                "duration_ms": duration_ms,
                "tokens": rec["tokens"] if rec["has_tokens"] else None,
                "cost_usd": rec["cost"] if rec["has_tokens"] else None,
            }
        )

    # -- token / cost ------------------------------------------------------
    def on_llm_end(self, response, **kwargs):
        rec = self._active.get(self._current_run_id) if self._current_run_id else None
        if rec is None:
            return
        input_tokens, output_tokens, total_tokens = self._extract_usage(response)
        if input_tokens == output_tokens == total_tokens == 0:
            return
        rec["has_tokens"] = True
        rec["tokens"]["input"] += input_tokens
        rec["tokens"]["output"] += output_tokens
        rec["tokens"]["total"] += total_tokens or (input_tokens + output_tokens)
        model = self._extract_model(response)
        price = self._cost_table.get(model) if model else None
        if price:
            rec["cost"] += (
                input_tokens / 1_000_000 * price["input"]
                + output_tokens / 1_000_000 * price["output"]
            )

    @staticmethod
    def _extract_usage(response) -> tuple[int, int, int]:
        inp = out = tot = 0
        # Preferred: usage_metadata on the generated AIMessage(s)
        for gens in getattr(response, "generations", []) or []:
            for gen in gens:
                msg = getattr(gen, "message", None)
                um = getattr(msg, "usage_metadata", None)
                if um:
                    inp += um.get("input_tokens", 0) or 0
                    out += um.get("output_tokens", 0) or 0
                    tot += um.get("total_tokens", 0) or 0
        if inp or out or tot:
            return inp, out, tot
        # Fallback: llm_output.token_usage (OpenAI-style)
        llm_output = getattr(response, "llm_output", None) or {}
        usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
        inp = usage.get("prompt_tokens", 0) or usage.get("input_tokens", 0) or 0
        out = usage.get("completion_tokens", 0) or usage.get("output_tokens", 0) or 0
        tot = usage.get("total_tokens", 0) or 0
        return inp, out, tot

    @staticmethod
    def _extract_model(response) -> Optional[str]:
        llm_output = getattr(response, "llm_output", None) or {}
        model = llm_output.get("model_name") or llm_output.get("model")
        if model:
            return model
        for gens in getattr(response, "generations", []) or []:
            for gen in gens:
                msg = getattr(gen, "message", None)
                meta = getattr(msg, "response_metadata", None) or {}
                if meta.get("model_name"):
                    return meta["model_name"]
        return None

    # -- errors ------------------------------------------------------------
    def _emit_error(self, error: BaseException, run_id: Optional[str]):
        rec = self._active.pop(str(run_id), None) if run_id else None
        node = rec["node"] if rec else (
            self._active.get(self._current_run_id, {}).get("node", "")
            if self._current_run_id
            else ""
        )
        step = rec["step"] if rec else self._step
        self._client.post_event(
            {
                "event_type": "node_error",
                "run_id": self._run_id,
                "step": step,
                "node_name": node,
                "ts": time.time(),
                "error": {
                    "type": type(error).__name__,
                    "message": str(error),
                    "traceback": "".join(
                        traceback.format_exception(
                            type(error), error, error.__traceback__
                        )
                    ),
                },
            }
        )

    def on_chain_error(self, error, **kwargs):
        run_id = kwargs.get("run_id")
        # Only emit for genuine graph nodes we are tracking.
        if str(run_id) in self._active:
            self._emit_error(error, run_id)

    def on_tool_error(self, error, **kwargs):
        self._emit_error(error, None)

    def on_llm_error(self, error, **kwargs):
        self._emit_error(error, None)

    # -- consumed by the stream loop --------------------------------------
    def pop_completed(self, node: str) -> Optional[dict]:
        q = self._completed.get(node)
        if q:
            return q.popleft()
        return None


class WatchedGraph:
    """Wraps a compiled LangGraph so execution streams events to the backend."""

    def __init__(
        self,
        compiled_graph: Any,
        client: EventClient,
        cost_table: Optional[dict] = None,
    ):
        self._graph = compiled_graph
        self._client = client
        self._cost_table = cost_table
        self._structure = extract_structure(compiled_graph)

    # Transparent passthrough for anything we don't override.
    def __getattr__(self, name):
        return getattr(self._graph, name)

    def get_graph(self, *a, **k):
        return self._graph.get_graph(*a, **k)

    def _merge_callbacks(self, config, handler) -> dict:
        config = dict(config or {})
        callbacks = config.get("callbacks")
        if callbacks is None:
            config["callbacks"] = [handler]
        elif isinstance(callbacks, list):
            config["callbacks"] = callbacks + [handler]
        else:  # BaseCallbackManager
            callbacks.add_handler(handler, inherit=True)
            config["callbacks"] = callbacks
        return config

    def _emit_graph_init(self, run_id, initial_state):
        # Carry the initial state so the backend has a baseline to diff against.
        self._client.post_event(
            {
                "event_type": "graph_init",
                "run_id": run_id,
                "step": 0,
                "ts": time.time(),
                "structure": self._structure,
                "full_state": _to_jsonable(initial_state),
            }
        )

    def _emit_node_ends(self, handler, run_id, pending_nodes, full_state):
        state = _to_jsonable(full_state)
        for node in pending_nodes:
            rec = handler.pop_completed(node) or {}
            self._client.post_event(
                {
                    "event_type": "node_end",
                    "run_id": run_id,
                    "step": rec.get("step", 0),
                    "node_name": node,
                    "ts": time.time(),
                    "duration_ms": rec.get("duration_ms"),
                    "full_state": state,
                    "tokens": rec.get("tokens"),
                    "cost_usd": rec.get("cost_usd"),
                }
            )

    # -- shared streaming helpers (used by both stream() and ainvoke()) ----
    def _begin_run(self, config):
        run_id = str(uuid.uuid4())
        handler = VisualizerCallbackHandler(self._client, run_id, self._cost_table)
        return run_id, handler, self._merge_callbacks(config, handler)

    def _on_updates(self, st, data):
        if isinstance(data, dict):
            st["pending"] = [n for n in data if not str(n).startswith("__")]

    def _on_values(self, run_id, handler, st, data):
        if not st["init_sent"]:
            # First values snapshot is the initial state (pre-execution).
            self._emit_graph_init(run_id, data)
            st["init_sent"] = True
        else:
            self._emit_node_ends(handler, run_id, st["pending"], data)
        st["pending"] = []

    def _finalize_run(self, run_id):
        # Signal run completion (backend keeps 'error' if a node failed), then
        # flush so node_error + run_end reach the backend before exit.
        self._client.post_event(
            {"event_type": "run_end", "run_id": run_id, "step": 0, "ts": time.time()}
        )
        self._client.flush()

    def invoke(self, inputs, config=None, **kwargs):
        final_state: Any = None
        for state in self.stream(inputs, config=config, stream_mode="values", **kwargs):
            final_state = state
        return final_state

    def stream(self, inputs, config=None, stream_mode=None, **kwargs):
        run_id, handler, config = self._begin_run(config)
        user_mode = stream_mode or "values"
        st = {"pending": [], "init_sent": False}
        try:
            for mode, data in self._graph.stream(
                inputs, stream_mode=["updates", "values"], config=config, **kwargs
            ):
                if mode == "updates":
                    self._on_updates(st, data)
                    if user_mode == "updates":
                        yield data
                elif mode == "values":
                    self._on_values(run_id, handler, st, data)
                    if user_mode == "values":
                        yield data
        finally:
            self._finalize_run(run_id)

    async def ainvoke(self, inputs, config=None, **kwargs):
        run_id, handler, config = self._begin_run(config)
        final_state: Any = None
        st = {"pending": [], "init_sent": False}
        try:
            async for mode, data in self._graph.astream(
                inputs, stream_mode=["updates", "values"], config=config, **kwargs
            ):
                if mode == "updates":
                    self._on_updates(st, data)
                elif mode == "values":
                    final_state = data
                    self._on_values(run_id, handler, st, data)
        finally:
            self._finalize_run(run_id)
        return final_state


def watch(
    compiled_graph: Any,
    backend_url: Optional[str] = None,
    cost_table: Optional[dict] = None,
) -> WatchedGraph:
    """Wrap a compiled LangGraph for live visualization.

    Usage::

        graph = watch(builder.compile())
        graph.invoke(inputs)   # events stream to the backend automatically
    """
    from .client import DEFAULT_BACKEND_URL

    client = EventClient(backend_url or DEFAULT_BACKEND_URL)
    return WatchedGraph(compiled_graph, client, cost_table)
