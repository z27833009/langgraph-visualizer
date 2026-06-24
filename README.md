# LangGraph Local Visualizer (MVP)

A lightweight, privacy-focused, local-first visualizer for LangGraph state machine executions.

## Why this exists

Unlike LangSmith (which requires cloud registration and uploads telemetry data) or LangGraph Studio (which is proprietary), this tool runs **completely locally** and provides a real-time reactive visualization of your LangGraph nodes and state changes.

## Architecture

- **Backend**: FastAPI web server that listens for node execution events via a REST API and broadcasts them to the frontend via WebSockets.
- **Frontend**: A clean, premium dashboard built with native Vanilla JS (ES6 modules) and SVG/CSS animations (no heavy framework overhead) to render the graph nodes, active state, and trace logs.
- **Client**: A simple callback/helper function in your Python LangGraph script to stream events to the backend.

## Structure

- `backend/`: FastAPI server and event router.
- `frontend/`: Native HTML5/CSS3/ES6 visualization dashboard.
- `example_agent.py`: A sample LangGraph agent showing how to integrate the telemetry streamer.

## How to Run with uv

This project is configured with a `pyproject.toml` for modern python package management using **uv**.

1. **Start the Backend Server**:
   ```bash
   uv run backend/main.py
   ```
   This will automatically install dependencies (`fastapi`, `uvicorn`, etc.) and start the server at `http://127.0.0.1:8000/`.

2. **Open the Frontend**:
   Open your browser and navigate to `http://127.0.0.1:8000/`.

3. **Run the Example Agent**:
   In a new terminal window, run the simulation agent:
   ```bash
   uv run example_agent.py
   ```

