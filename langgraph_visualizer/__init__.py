"""langgraph_visualizer — one-line, local-first tracing for LangGraph.

    from langgraph_visualizer import watch

    graph = watch(builder.compile())
    graph.invoke(inputs)
"""

from .client import EventClient
from .tracer import (
    DEFAULT_COST_TABLE,
    VisualizerCallbackHandler,
    WatchedGraph,
    extract_structure,
    watch,
)

__all__ = [
    "watch",
    "WatchedGraph",
    "VisualizerCallbackHandler",
    "extract_structure",
    "EventClient",
    "DEFAULT_COST_TABLE",
]
