// Entry point: WebSocket connection, live event dispatch, and module wiring.
import { S, $ } from "./state.js";
import {
    initGraph, setActiveNode, setCompletedNode, setErrorNode, clearNodeStates,
    recordMetrics, updateSummary,
} from "./graph.js";
import {
    updateState, showError, hideError, detectAnomalies, flagAnomaly,
    addLogEntry, initErrorRegion,
} from "./inspector.js";
import { initReplay, refreshRunList, hideTimeline } from "./replay.js";
import { initPanels } from "./panels.js";

// --- live run lifecycle ---------------------------------------------------
function resetRunState() {
    S.nodeDurations = {};
    S.nodeTokens = {};
    S.totals = { duration: 0, tokens: 0, cost: 0 };
    S.flaggedAnomalies = new Set();
    updateSummary();
    hideError();
}

function enterLiveMode() {
    S.mode = "live";
    hideTimeline();
    clearNodeStates();
    resetRunState();
    addLogEntry("init", "Live mode — waiting for new runs…");
}

function dispatch(data) {
    // run_end is a control event: refresh the run list, otherwise ignore
    // live rendering while replaying.
    if (data.event_type === "run_end") { refreshRunList(); return; }
    if (S.mode !== "live") return;

    switch (data.event_type) {
        case "graph_init": {
            const s = data.structure || data.state_delta || {};
            initGraph(s.nodes || [], s.links || []);
            resetRunState();
            addLogEntry("init", "Graph initialized.");
            break;
        }
        case "node_start":
            setActiveNode(data.node_name);
            addLogEntry("start", data.node_name);
            break;
        case "node_end": {
            setCompletedNode(data.node_name);
            updateState(data.full_state, data.state_delta);
            detectAnomalies(data.node_name, data.full_state, data.state_delta);
            recordMetrics(data);
            const dur = data.duration_ms != null ? ` (${Math.round(data.duration_ms)}ms)` : "";
            addLogEntry("end", `${data.node_name}${dur}`);
            break;
        }
        case "node_error":
            setErrorNode(data.node_name);
            showError(data.node_name, data.error || {});
            flagAnomaly(data.node_name, `node '${data.node_name}' raised ${data.error?.type || "error"}`);
            addLogEntry("error", `${data.node_name}: ${data.error?.message || "error"}`);
            break;
    }
}

// --- WebSocket ------------------------------------------------------------
function connect() {
    const badge = $("ws-status"), text = $("ws-text");
    const socket = new WebSocket(`ws://${window.location.host}/ws`);
    socket.onopen = () => { badge.className = "status-badge online"; text.textContent = "Connected"; };
    socket.onclose = () => { badge.className = "status-badge offline"; text.textContent = "Disconnected"; };
    socket.onerror = (e) => console.error("WS error:", e);
    socket.onmessage = (e) => dispatch(JSON.parse(e.data));
}

// --- init -----------------------------------------------------------------
initPanels();
initErrorRegion();
initReplay(enterLiveMode);
refreshRunList();
connect();
