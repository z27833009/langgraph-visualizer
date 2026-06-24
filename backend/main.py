import json
import logging
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


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
    event_type: str  # "node_start" | "node_end" | "graph_init"
    node_name: str
    state_delta: dict = {}
    full_state: dict = {}

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
    # Broadcast to all connected frontends
    await manager.broadcast(event.model_dump_json())
    return {"status": "ok"}

# Serve frontend static files
BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
