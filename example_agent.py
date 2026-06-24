import time
import requests

BACKEND_URL = "http://127.0.0.1:8000/event"

def send_event(event_type: str, node_name: str, state_delta: dict = None, full_state: dict = None):
    payload = {
        "event_type": event_type,
        "node_name": node_name,
        "state_delta": state_delta or {},
        "full_state": full_state or {}
    }
    try:
        requests.post(BACKEND_URL, json=payload)
    except requests.exceptions.ConnectionError:
        print("[!] Visualizer backend is not running. Start it with: python backend/main.py")

def simulate_agent_execution():
    # 1. Define graph structure
    nodes = {
        "__start__": {"label": "Start"},
        "supervisor": {"label": "Supervisor"},
        "rag_agent": {"label": "RAG Agent"},
        "web_tool": {"label": "Web Search"},
        "__end__": {"label": "End"}
    }
    
    links = [
        {"source": "__start__", "target": "supervisor"},
        {"source": "supervisor", "target": "rag_agent"},
        {"source": "rag_agent", "target": "web_tool"},
        {"source": "web_tool", "target": "rag_agent"},
        {"source": "rag_agent", "target": "__end__"}
    ]

    print("[*] Initializing visualizer graph structure...")
    send_event("graph_init", "__start__", full_state={"query": "Find latest AI VC deals"}, state_delta={"nodes": nodes, "links": links})
    time.sleep(2)

    # State variables
    state = {
        "query": "Find latest AI VC deals in Germany",
        "search_results": [],
        "agent_response": "",
        "iterations": 0
    }

    # Node: Start
    send_event("node_start", "__start__")
    time.sleep(1)
    send_event("node_end", "__start__", full_state=state)

    # Node: Supervisor
    send_event("node_start", "supervisor")
    time.sleep(1.5)
    state["iterations"] += 1
    send_event("node_end", "supervisor", state_delta={"iterations": 1}, full_state=state)

    # Node: RAG Agent
    send_event("node_start", "rag_agent")
    time.sleep(2)
    state["agent_response"] = "Query needs external search database connection."
    send_event("node_end", "rag_agent", state_delta={"agent_response": state["agent_response"]}, full_state=state)

    # Node: Web Tool
    send_event("node_start", "web_tool")
    time.sleep(2.5)
    state["search_results"] = [
        {"company": "Tacto", "round": "Series A", "investor": "Cherry Ventures"},
        {"company": "Sensmore", "round": "Seed", "investor": "Point Nine Capital"}
    ]
    send_event("node_end", "web_tool", state_delta={"search_results": state["search_results"]}, full_state=state)

    # Node: RAG Agent (Looping back)
    send_event("node_start", "rag_agent")
    time.sleep(2)
    state["agent_response"] = "Found 2 active AI startups: Tacto (procurement AI, Cherry Ventures) and Sensmore (industrial AI, Point Nine Capital)."
    send_event("node_end", "rag_agent", state_delta={"agent_response": state["agent_response"]}, full_state=state)

    # Node: End
    send_event("node_start", "__end__")
    time.sleep(1)
    send_event("node_end", "__end__", full_state=state)
    print("[+] Simulation complete!")

if __name__ == "__main__":
    simulate_agent_execution()
