"""A real, runnable LangGraph example wired to the visualizer.

Topology (contains a cycle so the visualizer shows a node lighting twice):

    START -> supervisor -> rag_agent --(needs search)--> web_tool
                              ^                              |
                              +------------------------------+
    rag_agent --(has results / max iters)--> END

Run it::

    uv run backend/main.py      # terminal 1: the visualizer backend
    uv run example_agent.py     # terminal 2: this agent

No code change is needed to your graph — only the single ``watch(...)`` wrap.

Environment:
  OPENAI_API_KEY   if set (and langchain-openai installed), uses a real LLM;
                   otherwise falls back to a deterministic fake model so the
                   demo always runs.
  RAISE_AT=<node>  intentionally raise inside that node (e.g. RAISE_AT=web_tool)
                   to demo error visualization.
"""

from __future__ import annotations

import os
from typing import TypedDict

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import END, START, StateGraph

from langgraph_visualizer import watch

MAX_ITERATIONS = 3
RAISE_AT = os.environ.get("RAISE_AT")


class AgentState(TypedDict):
    query: str
    iterations: int
    search_results: list
    answer: str


def _get_llm():
    """Return a chat model: real ChatOpenAI if configured, else a fake one."""
    if os.environ.get("OPENAI_API_KEY"):
        try:
            from langchain_openai import ChatOpenAI

            return ChatOpenAI(model="gpt-4o-mini", temperature=0)
        except ImportError:
            print("[example] OPENAI_API_KEY set but langchain-openai not "
                  "installed; using fake LLM.")
    from langchain_core.language_models.fake_chat_models import (
        GenericFakeChatModel,
    )

    return GenericFakeChatModel(
        messages=iter(
            [
                AIMessage("I need to search the web to answer this."),
                AIMessage(
                    "Based on the search results, here are 2 relevant AI "
                    "startups: Tacto (Cherry Ventures) and Sensmore "
                    "(Point Nine Capital)."
                ),
            ]
            * 10  # plenty for any number of cycles
        )
    )


LLM = _get_llm()


def _maybe_raise(node_name: str) -> None:
    if RAISE_AT == node_name:
        raise RuntimeError(
            f"Intentional failure injected at node '{node_name}' (RAISE_AT)."
        )


def supervisor(state: AgentState) -> dict:
    _maybe_raise("supervisor")
    return {"iterations": state.get("iterations", 0)}


def rag_agent(state: AgentState) -> dict:
    _maybe_raise("rag_agent")
    has_results = bool(state.get("search_results"))
    prompt = (
        f"Question: {state['query']}\n"
        + (
            f"Search results: {state['search_results']}\nWrite the final answer."
            if has_results
            else "You have no search results yet."
        )
    )
    response = LLM.invoke([HumanMessage(prompt)])
    return {
        "iterations": state.get("iterations", 0) + 1,
        "answer": response.content,
    }


def web_tool(state: AgentState) -> dict:
    _maybe_raise("web_tool")
    return {
        "search_results": [
            {"company": "Tacto", "round": "Series A", "investor": "Cherry Ventures"},
            {"company": "Sensmore", "round": "Seed", "investor": "Point Nine Capital"},
        ]
    }


def route_after_rag(state: AgentState) -> str:
    if state.get("search_results"):
        return END
    if state.get("iterations", 0) >= MAX_ITERATIONS:
        return END
    return "web_tool"


def build_graph():
    builder = StateGraph(AgentState)
    builder.add_node("supervisor", supervisor)
    builder.add_node("rag_agent", rag_agent)
    builder.add_node("web_tool", web_tool)

    builder.add_edge(START, "supervisor")
    builder.add_edge("supervisor", "rag_agent")
    builder.add_conditional_edges(
        "rag_agent", route_after_rag, {"web_tool": "web_tool", END: END}
    )
    builder.add_edge("web_tool", "rag_agent")  # cycle back
    return builder.compile()


def main():
    graph = watch(build_graph())  # one-line integration
    inputs = {
        "query": "Find recent AI VC deals in Germany",
        "iterations": 0,
        "search_results": [],
        "answer": "",
    }
    final = graph.invoke(inputs)
    print("\n[example] Final answer:", final.get("answer"))


if __name__ == "__main__":
    main()
