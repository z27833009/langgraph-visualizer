// WebSockets connection
const statusBadge = document.getElementById("ws-status");
const stateViewer = document.getElementById("state-viewer");
const logViewer = document.getElementById("log-viewer");
const nodesGroup = document.getElementById("nodes-group");
const linksGroup = document.getElementById("links-group");
const errorPanel = document.getElementById("error-panel");
const errorTraceback = document.getElementById("error-traceback");
const errorTab = document.getElementById("error-tab");
const errorToggle = document.getElementById("error-toggle");

const runSelect = document.getElementById("run-select");
const timelineBar = document.getElementById("timeline-bar");
const timeline = document.getElementById("timeline");
const tlLabel = document.getElementById("tl-label");
const tlPrev = document.getElementById("tl-prev");
const tlNext = document.getElementById("tl-next");
const sumDuration = document.getElementById("sum-duration");
const sumTokens = document.getElementById("sum-tokens");
const sumCost = document.getElementById("sum-cost");

if (errorTab) {
    errorTab.addEventListener("click", () => {
        errorTraceback.classList.toggle("collapsed");
        errorToggle.innerText = errorTraceback.classList.contains("collapsed") ? "▸" : "▾";
    });
}

// Per-run history of each state key's value, for first-anomaly detection.
let keyHistory = {};
let flaggedAnomalies = new Set();

// --- Mode + metrics state -------------------------------------------------
let mode = "live";                 // "live" | "replay"
let nodeDurations = {};            // node_name -> latest duration_ms (for heatmap)
let nodeTokens = {};               // node_name -> latest token total
let totals = { duration: 0, tokens: 0, cost: 0 };
let replayTimeline = [];           // node_end / node_error events, ordered by step

const socket = new WebSocket(`ws://${window.location.host}/ws`);

socket.onopen = () => {
    statusBadge.innerText = "Connected";
    statusBadge.style.color = "#10b981";
    statusBadge.style.backgroundColor = "rgba(16, 185, 129, 0.1)";
};

socket.onclose = () => {
    statusBadge.innerText = "Disconnected";
    statusBadge.style.color = "#ef4444";
    statusBadge.style.backgroundColor = "rgba(239, 68, 68, 0.1)";
};

socket.onerror = (error) => {
    console.error("WS error:", error);
};

// State representation
let graphData = {
    nodes: {},
    links: []
};

socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    // run_end is a control event — refresh the run list so the new run
    // appears in the selector. Ignore other live events while replaying.
    if (data.event_type === "run_end") {
        refreshRunList();
        return;
    }
    if (mode !== "live") return;

    if (data.event_type === "graph_init") {
        // New protocol: structure = {nodes:[{id,label}], links:[{source,target}]}.
        // Backward-compat: old events carried nodes/links under state_delta.
        const structure = data.structure || data.state_delta || {};
        initGraph(structure.nodes || [], structure.links || []);
        resetRunState();
        addLogEntry("init", "Graph initialized with structure.");
    } else if (data.event_type === "node_start") {
        setActiveNode(data.node_name);
        addLogEntry("start", `→ ${data.node_name}`);
    } else if (data.event_type === "node_end") {
        setCompletedNode(data.node_name);
        updateState(data.full_state, data.state_delta);
        detectAnomalies(data.node_name, data.full_state, data.state_delta);
        recordMetrics(data);
        const dur = data.duration_ms != null ? ` (${data.duration_ms.toFixed(0)}ms)` : "";
        addLogEntry("end", `✓ ${data.node_name}${dur}`);
    } else if (data.event_type === "node_error") {
        setErrorNode(data.node_name);
        showError(data.node_name, data.error || {});
        flagAnomaly(data.node_name, `node '${data.node_name}' raised ${data.error?.type || "error"}`);
        addLogEntry("error", `✗ ${data.node_name}: ${data.error?.message || "error"}`);
    }
};

function resetRunState() {
    keyHistory = {};
    flaggedAnomalies = new Set();
    nodeDurations = {};
    nodeTokens = {};
    totals = { duration: 0, tokens: 0, cost: 0 };
    updateSummary();
    hideError();
}

// Accumulate node metrics + run totals, then refresh card overlay + heatmap.
function recordMetrics(ev) {
    if (ev.duration_ms != null) {
        nodeDurations[ev.node_name] = ev.duration_ms;
        totals.duration += ev.duration_ms;
    }
    const tok = (ev.tokens && ev.tokens.total) || 0;
    if (tok) { nodeTokens[ev.node_name] = tok; totals.tokens += tok; }
    if (ev.cost_usd) totals.cost += ev.cost_usd;
    updateNodeCard(ev.node_name);
    applyHeat();
    updateSummary();
}

function updateSummary() {
    sumDuration.innerText = Math.round(totals.duration).toLocaleString();
    sumTokens.innerText = totals.tokens.toLocaleString();
    sumCost.innerText = totals.cost.toFixed(4);
}

function showError(nodeName, error) {
    errorTraceback.innerText =
        (error.type ? `${error.type}: ${error.message}\n\n` : "") +
        (error.traceback || "(no traceback)");
    errorTraceback.classList.remove("collapsed");
    errorToggle.innerText = "▾";
    errorPanel.classList.add("visible");
}

function hideError() {
    errorPanel.classList.remove("visible");
    errorTraceback.innerText = "";
}

// First-anomaly heuristic (lightweight, deterministic — no "AI diagnosis").
function detectAnomalies(nodeName, fullState, delta) {
    const changes = { ...(delta?.added || {}), ...(delta?.changed || {}) };
    Object.keys(changes).forEach(path => {
        const entry = delta.changed && delta.changed[path];
        const newVal = entry ? entry.new : changes[path];
        const oldVal = entry ? entry.old : undefined;

        const isEmpty = newVal === null || newVal === "" ||
            (Array.isArray(newVal) && newVal.length === 0) ||
            (newVal && typeof newVal === "object" && !Array.isArray(newVal) && Object.keys(newVal).length === 0);
        const typeChanged = oldVal !== undefined && newVal !== undefined &&
            jsType(oldVal) !== jsType(newVal);

        if (typeChanged) {
            flagAnomaly(nodeName, `'${path}' changed type ${jsType(oldVal)} → ${jsType(newVal)}`);
        } else if (isEmpty && oldVal !== undefined && !isEmptyVal(oldVal)) {
            flagAnomaly(nodeName, `'${path}' became empty/None`);
        }
    });
}

function isEmptyVal(v) {
    return v === null || v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}

function jsType(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
}

function flagAnomaly(nodeName, reason) {
    if (flaggedAnomalies.has(reason)) return;
    flaggedAnomalies.add(reason);
    addLogEntry("anomaly", `⚠ 首次异常 @ ${nodeName}: ${reason}`);
}

function addLogEntry(type, text) {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.innerText = `[${time}] ${text}`;
    logViewer.appendChild(entry);
    logViewer.scrollTop = logViewer.scrollHeight;
}

function updateState(fullState, delta) {
    stateViewer.innerHTML = "";
    
    const h3 = document.createElement("h3");
    h3.innerText = "Current State Variables:";
    h3.style.margin = "0 0 10px 0";
    h3.style.fontSize = "0.9rem";
    h3.style.color = "#94a3b8";
    stateViewer.appendChild(h3);

    const pre = document.createElement("pre");
    pre.className = "state-block";
    pre.innerText = JSON.stringify(fullState, null, 2);
    stateViewer.appendChild(pre);

    renderDelta(delta);
}

// Render the backend-computed delta with color-coded keys:
// added = green, changed = yellow, removed = red.
function renderDelta(delta) {
    if (!delta) return;
    const added = delta.added || {};
    const changed = delta.changed || {};
    const removed = delta.removed || {};
    const total = Object.keys(added).length + Object.keys(changed).length + Object.keys(removed).length;
    if (total === 0) return;

    const title = document.createElement("h3");
    title.innerText = "Changes this step:";
    title.style.margin = "15px 0 8px 0";
    title.style.fontSize = "0.9rem";
    title.style.color = "#94a3b8";
    stateViewer.appendChild(title);

    const list = document.createElement("div");
    list.className = "delta-list";

    const fmt = (v) => {
        const s = JSON.stringify(v);
        return s && s.length > 120 ? s.slice(0, 117) + "…" : s;
    };

    Object.entries(added).forEach(([k, v]) => {
        addDeltaRow(list, "delta-added", `+ ${k}: ${fmt(v)}`);
    });
    Object.entries(changed).forEach(([k, ov]) => {
        addDeltaRow(list, "delta-changed", `~ ${k}: ${fmt(ov.old)} → ${fmt(ov.new)}`);
    });
    Object.entries(removed).forEach(([k, v]) => {
        addDeltaRow(list, "delta-removed", `- ${k}: ${fmt(v)}`);
    });

    stateViewer.appendChild(list);
}

function addDeltaRow(list, cls, text) {
    const row = document.createElement("div");
    row.className = `delta-row ${cls}`;
    row.innerText = text;
    list.appendChild(row);
}

function setErrorNode(nodeId) {
    const node = document.getElementById(`node-${nodeId}`);
    if (node) {
        node.classList.remove("active", "completed");
        node.classList.add("error");
    }
}

// Render nodes in a simple layered or circular layout.
// `nodes` is a list of {id, label}; `links` is a list of {source, target}.
function initGraph(nodes, links) {
    nodesGroup.innerHTML = "";
    linksGroup.innerHTML = "";

    // Build a {id: {label}} lookup from the structure list.
    const nodeMeta = {};
    nodes.forEach(n => { nodeMeta[n.id] = { label: n.label || n.id }; });
    const nodeIds = Object.keys(nodeMeta);

    // Build adjacency list for BFS
    const adj = {};
    const depthMap = {};
    nodeIds.forEach(id => {
        adj[id] = [];
        depthMap[id] = undefined;
    });
    links.forEach(l => {
        if (adj[l.source]) adj[l.source].push(l.target);
    });

    // BFS to determine layers from __start__
    const startNode = nodeIds.includes("__start__") ? "__start__" : nodeIds[0];
    const queue = [startNode];
    const visited = new Set([startNode]);
    depthMap[startNode] = 0;

    while (queue.length > 0) {
        const curr = queue.shift();
        const currentDepth = depthMap[curr] || 0;
        
        (adj[curr] || []).forEach(next => {
            if (!visited.has(next)) {
                visited.add(next);
                depthMap[next] = currentDepth + 1;
                queue.push(next);
            }
        });
    }

    // Assign default layer to any disconnected/unreached nodes
    nodeIds.forEach(id => {
        if (depthMap[id] === undefined) {
            depthMap[id] = 1;
        }
    });

    // Group nodes by layer
    const layers = {};
    nodeIds.forEach(id => {
        const d = depthMap[id];
        if (!layers[d]) layers[d] = [];
        layers[d].push(id);
    });

    // Compute layout positions
    const panelWidth = window.innerWidth * 0.55;
    const panelHeight = window.innerHeight * 0.75;
    const centerY = panelHeight / 2;
    
    const layerIds = Object.keys(layers).sort((a, b) => a - b);
    const layerCount = layerIds.length;
    const xSpacing = Math.min(220, (panelWidth - 200) / Math.max(1, layerCount - 1));

    graphData.nodes = {};
    
    layerIds.forEach((layerId, lIndex) => {
        const ids = layers[layerId];
        const count = ids.length;
        const x = 120 + lIndex * xSpacing;
        
        ids.forEach((id, index) => {
            // Distribute vertically around centerY
            const ySpacing = 110;
            const totalHeight = (count - 1) * ySpacing;
            const y = centerY - (totalHeight / 2) + index * ySpacing;
            
            // Determine type classification
            let type = "NODE";
            if (id === "__start__" || id === "__end__") type = "SYSTEM";
            else if (id.toLowerCase().includes("agent")) type = "AGENT";
            else if (id.toLowerCase().includes("tool")) type = "TOOL";
            else if (id.toLowerCase().includes("supervisor")) type = "SUPERVISOR";
            
            graphData.nodes[id] = {
                id: id,
                x: x,
                y: y,
                label: (nodeMeta[id] && nodeMeta[id].label) || id,
                type: type
            };
        });
    });

    graphData.links = links.map(link => ({
        source: link.source,
        target: link.target
    }));

    // Draw links using smooth cubic bezier curves (horizontal flow)
    graphData.links.forEach(link => {
        const sourceNode = graphData.nodes[link.source];
        const targetNode = graphData.nodes[link.target];
        if (!sourceNode || !targetNode) return;

        // Connect nodes based on relative horizontal direction to prevent twisted loops
        let x1, y1, x2, y2, dx, pathD;
        if (sourceNode.x < targetNode.x) {
            // Forward link: right-edge of source to left-edge of target
            x1 = sourceNode.x + 70;
            y1 = sourceNode.y;
            x2 = targetNode.x - 70;
            y2 = targetNode.y;
            dx = (x2 - x1) * 0.5;
            pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        } else {
            // Backward loop link: left-edge of source to right-edge of target (curves back nicely)
            x1 = sourceNode.x - 70;
            y1 = sourceNode.y;
            x2 = targetNode.x + 70;
            y2 = targetNode.y;
            dx = (x1 - x2) * 0.5;
            pathD = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
        }

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathD);
        path.setAttribute("class", "edge");
        path.setAttribute("id", `edge-${link.source}-${link.target}`);
        linksGroup.appendChild(path);
    });

    // Draw nodes as modern rounded cards
    Object.keys(graphData.nodes).forEach(id => {
        const node = graphData.nodes[id];
        
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", "node");
        g.setAttribute("id", `node-${id}`);
        g.setAttribute("transform", `translate(${node.x}, ${node.y})`);

        // Node card background (rx/ry rounded corners)
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", -70);
        rect.setAttribute("y", -28);
        rect.setAttribute("width", 140);
        rect.setAttribute("height", 58);
        g.appendChild(rect);

        // Subtitle / Type label
        const typeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        typeText.setAttribute("y", -13);
        typeText.setAttribute("class", "node-type");
        typeText.textContent = node.type;
        g.appendChild(typeText);

        // Main Node name
        const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        labelText.setAttribute("y", 4);
        labelText.setAttribute("class", "node-label");
        labelText.textContent = node.label;
        g.appendChild(labelText);

        // Metrics overlay (duration / tokens), filled in on node_end / replay
        const metricsText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        metricsText.setAttribute("y", 20);
        metricsText.setAttribute("class", "node-metrics");
        metricsText.setAttribute("id", `metrics-${id}`);
        g.appendChild(metricsText);

        nodesGroup.appendChild(g);
    });
}

// --- Node metric overlay + heatmap ---------------------------------------
function updateNodeCard(nodeId) {
    const el = document.getElementById(`metrics-${nodeId}`);
    if (!el) return;
    const parts = [];
    if (nodeDurations[nodeId] != null) parts.push(`${Math.round(nodeDurations[nodeId])}ms`);
    if (nodeTokens[nodeId]) parts.push(`${nodeTokens[nodeId]} tok`);
    el.textContent = parts.join(" · ");
}

// Tint each node's fill by how slow it is relative to the slowest node.
function applyHeat() {
    const vals = Object.values(nodeDurations);
    const max = vals.length ? Math.max(...vals) : 0;
    Object.keys(nodeDurations).forEach(id => {
        const rect = document.querySelector(`#node-${id} rect`);
        if (!rect) return;
        const t = max > 0 ? nodeDurations[id] / max : 0;
        rect.style.fill = heatColor(t);
    });
}

// Interpolate cool slate (#1e293b) -> hot red (#b91c1c) by t in [0,1].
function heatColor(t) {
    const c0 = [30, 41, 59], c1 = [185, 28, 28];
    const mix = c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function setActiveNode(nodeId) {
    // Reset active states
    document.querySelectorAll(".node").forEach(n => n.classList.remove("active"));
    document.querySelectorAll(".edge").forEach(e => e.classList.remove("active"));

    const activeNode = document.getElementById(`node-${nodeId}`);
    if (activeNode) {
        activeNode.classList.add("active");
    }

    // Highlight any incoming links to the active node
    graphData.links.forEach(link => {
        if (link.target === nodeId) {
            const edge = document.getElementById(`edge-${link.source}-${link.target}`);
            if (edge) edge.classList.add("active");
        }
    });
}

function setCompletedNode(nodeId) {
    const node = document.getElementById(`node-${nodeId}`);
    if (node) {
        node.classList.remove("active");
        node.classList.add("completed");
    }
}

function clearNodeStates() {
    document.querySelectorAll(".node").forEach(n =>
        n.classList.remove("active", "completed", "error"));
    document.querySelectorAll(".edge").forEach(e => e.classList.remove("active"));
}

// =========================================================================
// Replay / time travel
// =========================================================================
async function refreshRunList() {
    let runs = [];
    try {
        runs = await (await fetch("/runs")).json();
    } catch (e) {
        return;
    }
    const current = runSelect.value;
    runSelect.innerHTML = '<option value="__live__">● Live</option>';
    runs.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.run_id;
        const when = r.started_at ? new Date(r.started_at * 1000).toLocaleTimeString() : "";
        const icon = r.status === "error" ? "✗" : (r.status === "completed" ? "✓" : "●");
        opt.innerText = `${icon} ${when} · ${r.run_id.slice(0, 8)}`;
        runSelect.appendChild(opt);
    });
    // Preserve selection if still present.
    if ([...runSelect.options].some(o => o.value === current)) runSelect.value = current;
}

runSelect.addEventListener("change", () => {
    const val = runSelect.value;
    if (val === "__live__") {
        enterLiveMode();
    } else {
        enterReplay(val);
    }
});

function enterLiveMode() {
    mode = "live";
    timelineBar.classList.remove("visible");
    clearNodeStates();
    resetRunState();
    addLogEntry("init", "Live mode — waiting for new runs…");
}

async function enterReplay(runId) {
    let run, events;
    try {
        run = await (await fetch(`/runs/${runId}`)).json();
        events = await (await fetch(`/runs/${runId}/events`)).json();
    } catch (e) {
        addLogEntry("error", `Failed to load run ${runId}`);
        return;
    }
    mode = "replay";
    hideError();

    // Rebuild the graph from the stored structure.
    const structure = run.structure || {};
    initGraph(structure.nodes || [], structure.links || []);

    // Build heat / metric maps from the full run, plus run-total summary.
    nodeDurations = {};
    nodeTokens = {};
    events.forEach(e => {
        if (e.event_type === "node_end") {
            if (e.duration_ms != null) nodeDurations[e.node_name] = e.duration_ms;
            const tok = (e.tokens && e.tokens.total) || 0;
            if (tok) nodeTokens[e.node_name] = tok;
        }
    });
    totals = {
        duration: events.reduce((s, e) => s + (e.duration_ms || 0), 0),
        tokens: run.total_tokens || 0,
        cost: run.total_cost || 0,
    };
    updateSummary();
    applyHeat();

    // Timeline = the steps that produced a state snapshot or an error.
    replayTimeline = events.filter(e =>
        e.event_type === "node_end" || e.event_type === "node_error");
    timeline.min = 0;
    timeline.max = Math.max(0, replayTimeline.length - 1);
    timeline.value = timeline.max;          // start at the end (final state)
    timelineBar.classList.add("visible");
    logViewer.innerHTML = "";
    addLogEntry("init", `Replaying run ${runId.slice(0, 8)} (${replayTimeline.length} steps)`);
    renderReplayStep(replayTimeline.length - 1);
}

function renderReplayStep(idx) {
    if (!replayTimeline.length) return;
    idx = Math.max(0, Math.min(idx, replayTimeline.length - 1));
    timeline.value = idx;
    clearNodeStates();
    hideError();

    // Cumulative node states up to and including idx.
    for (let j = 0; j <= idx; j++) {
        const ev = replayTimeline[j];
        const node = document.getElementById(`node-${ev.node_name}`);
        if (!node) continue;
        if (ev.event_type === "node_error") {
            node.classList.remove("completed");
            node.classList.add("error");
        } else {
            node.classList.add("completed");
        }
        updateNodeCard(ev.node_name);
    }

    const cur = replayTimeline[idx];
    if (cur.event_type === "node_error") {
        setErrorNode(cur.node_name);
        showError(cur.node_name, cur.error || {});
    } else {
        // Mark the current node active to indicate "you are here".
        const node = document.getElementById(`node-${cur.node_name}`);
        if (node) node.classList.add("active");
        updateState(cur.full_state, cur.state_delta);
    }

    tlLabel.innerText = `step ${idx + 1} / ${replayTimeline.length} · ${cur.node_name}`;
}

timeline.addEventListener("input", () => renderReplayStep(parseInt(timeline.value, 10)));
tlPrev.addEventListener("click", () => renderReplayStep(parseInt(timeline.value, 10) - 1));
tlNext.addEventListener("click", () => renderReplayStep(parseInt(timeline.value, 10) + 1));

document.addEventListener("keydown", (e) => {
    if (mode !== "replay") return;
    if (e.key === "ArrowLeft") {
        renderReplayStep(parseInt(timeline.value, 10) - 1);
        e.preventDefault();
    } else if (e.key === "ArrowRight") {
        renderReplayStep(parseInt(timeline.value, 10) + 1);
        e.preventDefault();
    }
});

// Populate the run list on load.
refreshRunList();

