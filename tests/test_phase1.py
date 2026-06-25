"""Phase 1 tests: state diff correctness, backend baseline, error events."""

from typing import TypedDict

import pytest
from langgraph.graph import END, START, StateGraph

from backend.diff import diff_state
from backend.main import GraphEvent, _prev_state, compute_delta
from langgraph_visualizer.tracer import WatchedGraph


# --- diff_state -----------------------------------------------------------

def test_diff_added_key():
    d = diff_state({"a": 1}, {"a": 1, "b": 2})
    assert d["added"] == {"b": 2}
    assert d["changed"] == {} and d["removed"] == {}


def test_diff_changed_key():
    d = diff_state({"a": 1}, {"a": 2})
    assert d["changed"] == {"a": {"old": 1, "new": 2}}
    assert d["added"] == {} and d["removed"] == {}


def test_diff_removed_key():
    d = diff_state({"a": 1, "b": 2}, {"a": 1})
    assert d["removed"] == {"b": 2}
    assert d["added"] == {} and d["changed"] == {}


def test_diff_nested_dict_change():
    d = diff_state(
        {"user": {"name": "alice", "age": 30}},
        {"user": {"name": "bob", "age": 30}},
    )
    assert d["changed"] == {"user.name": {"old": "alice", "new": "bob"}}


def test_diff_nested_add_and_remove():
    d = diff_state(
        {"cfg": {"a": 1, "drop": 9}},
        {"cfg": {"a": 1, "added": 2}},
    )
    assert d["added"] == {"cfg.added": 2}
    assert d["removed"] == {"cfg.drop": 9}


def test_diff_no_change():
    d = diff_state({"a": [1, 2], "b": {"c": 3}}, {"a": [1, 2], "b": {"c": 3}})
    assert d == {"added": {}, "changed": {}, "removed": {}}


# --- backend baseline flow ------------------------------------------------

def test_backend_computes_delta_against_baseline():
    run_id = "run-test-1"
    _prev_state.pop(run_id, None)

    init = GraphEvent(event_type="graph_init", run_id=run_id,
                      full_state={"x": 1, "y": 0})
    compute_delta(init)  # sets baseline

    e1 = GraphEvent(event_type="node_end", run_id=run_id, step=1,
                    full_state={"x": 1, "y": 5})
    compute_delta(e1)
    assert e1.state_delta["changed"] == {"y": {"old": 0, "new": 5}}

    e2 = GraphEvent(event_type="node_end", run_id=run_id, step=2,
                    full_state={"x": 1, "y": 5, "z": "new"})
    compute_delta(e2)
    assert e2.state_delta["added"] == {"z": "new"}
    _prev_state.pop(run_id, None)


# --- node_error emission --------------------------------------------------

class S(TypedDict):
    n: int


def _ok(state):
    return {"n": state.get("n", 0) + 1}


def _boom(state):
    raise ValueError("kaboom")


def _build_failing():
    b = StateGraph(S)
    b.add_node("ok", _ok)
    b.add_node("boom", _boom)
    b.add_edge(START, "ok")
    b.add_edge("ok", "boom")
    b.add_edge("boom", END)
    return b.compile()


class Rec:
    def __init__(self):
        self.events = []

    def post_event(self, e):
        self.events.append(e)

    def flush(self, timeout=5.0):
        pass


def test_node_error_event_emitted():
    client = Rec()
    wg = WatchedGraph(_build_failing(), client)
    with pytest.raises(ValueError):
        wg.invoke({"n": 0})

    errors = [e for e in client.events if e["event_type"] == "node_error"]
    assert errors, "expected a node_error event"
    err = errors[0]
    assert err["node_name"] == "boom"
    assert err["error"]["type"] == "ValueError"
    assert "kaboom" in err["error"]["message"]
    assert "Traceback" in err["error"]["traceback"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
