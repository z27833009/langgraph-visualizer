"""Phase 0 tests: structure extraction + event protocol via watch()."""

import json
from typing import TypedDict

import pytest
from langgraph.graph import END, START, StateGraph

from langgraph_visualizer import extract_structure, watch
from langgraph_visualizer.tracer import WatchedGraph, _to_jsonable


class State(TypedDict):
    query: str
    iterations: int
    items: list


def _node_a(state):
    return {"iterations": state.get("iterations", 0) + 1}


def _node_b(state):
    return {"items": state.get("items", []) + ["x"]}


def _route(state):
    return "node_a" if state["iterations"] < 2 else END


def build():
    b = StateGraph(State)
    b.add_node("node_a", _node_a)
    b.add_node("node_b", _node_b)
    b.add_edge(START, "node_a")
    b.add_edge("node_a", "node_b")
    b.add_conditional_edges("node_b", _route, {"node_a": "node_a", END: END})
    return b.compile()


class RecordingClient:
    """Stand-in for EventClient that captures emitted events."""

    def __init__(self):
        self.events = []

    def post_event(self, event):
        # Force a serialization round-trip to prove events are JSON-safe.
        self.events.append(json.loads(json.dumps(event)))

    def flush(self, timeout=5.0):
        pass


def test_extract_structure_matches_get_graph():
    graph = build()
    structure = extract_structure(graph)
    node_ids = {n["id"] for n in structure["nodes"]}
    expected = set(graph.get_graph().nodes.keys())
    assert node_ids == expected
    assert {"__start__", "node_a", "node_b", "__end__"} <= node_ids
    # links match edges
    links = {(l["source"], l["target"]) for l in structure["links"]}
    edges = {(e.source, e.target) for e in graph.get_graph().edges}
    assert links == edges


def test_to_jsonable_handles_messages_and_objects():
    from langchain_core.messages import AIMessage

    out = _to_jsonable({"msg": AIMessage("hi"), "n": 3, "nested": {"a": [1, 2]}})
    # Must be JSON-serializable
    json.dumps(out)
    assert out["n"] == 3
    assert out["msg"]["content"] == "hi"
    assert out["nested"]["a"] == [1, 2]


def _run_and_capture():
    client = RecordingClient()
    wg = WatchedGraph(build(), client)
    final = wg.invoke({"query": "q", "iterations": 0, "items": []})
    return client.events, final


def test_event_protocol_fields():
    events, final = _run_and_capture()
    assert final["iterations"] >= 2  # cycle actually ran

    types = [e["event_type"] for e in events]
    assert types[0] == "graph_init"
    assert "node_start" in types and "node_end" in types

    # graph_init carries the structure
    init = events[0]
    assert init["structure"]["nodes"]
    assert init["run_id"]

    # every event shares one run_id
    run_ids = {e["run_id"] for e in events}
    assert len(run_ids) == 1

    node_ends = [e for e in events if e["event_type"] == "node_end"]
    assert node_ends, "expected at least one node_end"
    for e in node_ends:
        assert e["full_state"], "node_end must carry non-empty full_state"
        assert e["duration_ms"] is not None
        assert e["run_id"]
        assert isinstance(e["step"], int)

    # steps are monotonically increasing across node_start/node_end emissions
    steps = [e["step"] for e in events if e["event_type"] in ("node_start", "node_end")]
    assert steps == sorted(steps)


def test_cycle_relights_a_node():
    events, _ = _run_and_capture()
    started = [e["node_name"] for e in events if e["event_type"] == "node_start"]
    # node_a runs at least twice because of the cycle
    assert started.count("node_a") >= 2


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
