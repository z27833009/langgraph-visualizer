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

if (errorTab) {
    errorTab.addEventListener("click", () => {
        errorTraceback.classList.toggle("collapsed");
        errorToggle.innerText = errorTraceback.classList.contains("collapsed") ? "▸" : "▾";
    });
}

// Per-run history of each state key's value, for first-anomaly detection.
let keyHistory = {};
let flaggedAnomalies = new Set();

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

    if (data.event_type === "graph_init") {
        // New protocol: structure = {nodes:[{id,label}], links:[{source,target}]}.
        // Backward-compat: old events carried nodes/links under state_delta.
        const structure = data.structure || data.state_delta || {};
        initGraph(structure.nodes || [], structure.links || []);
        keyHistory = {};
        flaggedAnomalies = new Set();
        hideError();
        addLogEntry("init", "Graph initialized with structure.");
    } else if (data.event_type === "node_start") {
        setActiveNode(data.node_name);
        addLogEntry("start", `→ ${data.node_name}`);
    } else if (data.event_type === "node_end") {
        setCompletedNode(data.node_name);
        updateState(data.full_state, data.state_delta);
        detectAnomalies(data.node_name, data.full_state, data.state_delta);
        const dur = data.duration_ms != null ? ` (${data.duration_ms.toFixed(0)}ms)` : "";
        addLogEntry("end", `✓ ${data.node_name}${dur}`);
    } else if (data.event_type === "node_error") {
        setErrorNode(data.node_name);
        showError(data.node_name, data.error || {});
        flagAnomaly(data.node_name, `node '${data.node_name}' raised ${data.error?.type || "error"}`);
        addLogEntry("error", `✗ ${data.node_name}: ${data.error?.message || "error"}`);
    }
};

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
        rect.setAttribute("y", -25);
        rect.setAttribute("width", 140);
        rect.setAttribute("height", 50);
        g.appendChild(rect);

        // Subtitle / Type label
        const typeText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        typeText.setAttribute("y", -8);
        typeText.setAttribute("class", "node-type");
        typeText.textContent = node.type;
        g.appendChild(typeText);

        // Main Node name
        const labelText = document.createElementNS("http://www.w3.org/2000/svg", "text");
        labelText.setAttribute("y", 12);
        labelText.setAttribute("class", "node-label");
        labelText.textContent = node.label;
        g.appendChild(labelText);

        nodesGroup.appendChild(g);
    });
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

