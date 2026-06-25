import logging
from pathlib import Path
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:  # works both as `python backend/main.py` and as a package import
    from backend.diff import diff_state
    from backend.storage import get_events, get_run, list_runs, persist_event
except ImportError:
    from diff import diff_state
    from storage import get_events, get_run, list_runs, persist_event


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("VisualizerBackend")

app = FastAPI(title="LangGraph Local Visualizer")

# Allow CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class GraphEvent(BaseModel):
    event_type: str  # "graph_init" | "node_start" | "node_end" | "node_error"
    run_id: str = ""              # one full run (grouping / replay key)
    step: int = 0                 # monotonic step index within the run
    node_name: str = ""
    ts: float = 0.0               # event timestamp (epoch seconds)
    duration_ms: float | None = None
    state_delta: dict = {}        # node_end: keys changed this step (backend-computed)
    full_state: dict = {}         # node_end: complete state after this step
    tokens: dict | None = None    # {"input","output","total"}
    cost_usd: float | None = None
    error: dict | None = None     # {"type","message","traceback"} (node_error)
    structure: dict | None = None  # graph_init: {"nodes":[...], "links":[...]}

# Active WebSocket connections
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Frontend connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info(f"Frontend disconnected. Active: {len(self.active_connections)}")

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Error sending message: {e}")

manager = ConnectionManager()

# Per-run baseline of the previous full_state, used to auto-compute state_delta.
# Backend is the single source of truth for diffs (clients never send them).
_prev_state: dict[str, dict] = {}


def compute_delta(event: GraphEvent) -> None:
    """Fill event.state_delta by diffing against the run's previous state."""
    if event.event_type == "graph_init":
        _prev_state[event.run_id] = event.full_state or {}
    elif event.event_type == "node_end":
        prev = _prev_state.get(event.run_id, {})
        event.state_delta = diff_state(prev, event.full_state or {})
        _prev_state[event.run_id] = event.full_state or {}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive, listen for messages from frontend if any
            data = await websocket.receive_text()
            logger.info(f"Received from frontend: {data}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.post("/event")
async def post_event(event: GraphEvent):
    logger.info(f"Received event: {event.event_type} for node '{event.node_name}'")
    # Backend computes the state delta (single source of truth).
    compute_delta(event)
    # Persist locally for replay / time travel.
    persist_event(event)
    # Broadcast to all connected frontends
    await manager.broadcast(event.model_dump_json())
    return {"status": "ok"}


# --- Replay REST API -------------------------------------------------------
@app.get("/runs")
async def get_runs():
    return list_runs()


@app.get("/runs/{run_id}")
async def get_run_detail(run_id: str):
    run = get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    return run


@app.get("/runs/{run_id}/events")
async def get_run_events(run_id: str):
    return get_events(run_id)


# Serve frontend static files
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
