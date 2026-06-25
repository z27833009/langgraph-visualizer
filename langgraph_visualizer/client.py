"""Lightweight, degradation-safe HTTP event sender.

Runs a single background worker thread consuming a FIFO queue so events
are delivered to the backend *in order* without blocking the user's agent.
If the backend is not running, it prints exactly one warning and silently
drops further events (never raises, never hangs).
"""

from __future__ import annotations

import atexit
import os
import queue
import threading
import time

import requests

DEFAULT_BACKEND_URL = os.environ.get(
    "LANGGRAPH_VISUALIZER_URL", "http://127.0.0.1:8000"
)

_SENTINEL = object()


class EventClient:
    """Async, fire-and-forget event sender with graceful degradation."""

    def __init__(self, backend_url: str = DEFAULT_BACKEND_URL, timeout: float = 2.0):
        self._url = backend_url.rstrip("/") + "/event"
        self._timeout = timeout
        self._q: "queue.Queue" = queue.Queue()
        self._warned = False
        self._down = False  # once True, stop trying (avoid per-event timeouts)
        self._thread = threading.Thread(
            target=self._worker, name="lgv-event-sender", daemon=True
        )
        self._thread.start()
        atexit.register(self.flush)

    def post_event(self, event: dict) -> None:
        """Enqueue an event for delivery. Never blocks meaningfully."""
        self._q.put(event)

    def _worker(self) -> None:
        while True:
            item = self._q.get()
            try:
                if item is _SENTINEL:
                    return
                self._send(item)
            finally:
                self._q.task_done()

    def _send(self, event: dict) -> None:
        if self._down:
            return
        try:
            requests.post(self._url, json=event, timeout=self._timeout)
        except requests.exceptions.RequestException:
            if not self._warned:
                print(
                    "[langgraph-visualizer] backend not reachable at "
                    f"{self._url} - running without visualization."
                )
                self._warned = True
            # Backend is down for this run; stop retrying so we never block.
            self._down = True

    def flush(self, timeout: float = 5.0) -> None:
        """Best-effort wait until queued events are delivered."""
        deadline = time.monotonic() + timeout
        while not self._q.empty() and time.monotonic() < deadline:
            time.sleep(0.02)
