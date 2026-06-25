// Graph rendering: layered layout, nodes (cards + start/end terminals),
// edges, execution-state highlighting, per-node metrics and the heatmap.
import { S, $, svgEl } from "./state.js";

const CARD_HW = 70, CARD_HH = 29;   // card half-width / half-height
const TERM_HW = 18;                  // terminal node half-extent

function classifyType(id) {
    if (id === "__start__" || id === "__end__") return "SYSTEM";
    const l = id.toLowerCase();
    if (l.includes("agent")) return "AGENT";
    if (l.includes("tool")) return "TOOL";
    if (l.includes("supervisor")) return "SUPERVISOR";
    return "NODE";
}

// `nodes` is [{id,label}], `links` is [{source,target}].
export function initGraph(nodes, links) {
    const nodesGroup = $("nodes-group");
    const linksGroup = $("links-group");
    nodesGroup.innerHTML = "";
    linksGroup.innerHTML = "";

    const nodeMeta = {};
    nodes.forEach(n => { nodeMeta[n.id] = { label: n.label || n.id }; });
    const nodeIds = Object.keys(nodeMeta);

    // BFS layering from __start__ (or first node).
    const adj = {}, depth = {};
    nodeIds.forEach(id => { adj[id] = []; depth[id] = undefined; });
    links.forEach(l => { if (adj[l.source]) adj[l.source].push(l.target); });

    const start = nodeIds.includes("__start__") ? "__start__" : nodeIds[0];
    const queue = [start]; const seen = new Set([start]); depth[start] = 0;
    while (queue.length) {
        const cur = queue.shift();
        (adj[cur] || []).forEach(next => {
            if (!seen.has(next)) { seen.add(next); depth[next] = (depth[cur] || 0) + 1; queue.push(next); }
        });
    }
    nodeIds.forEach(id => { if (depth[id] === undefined) depth[id] = 1; });

    const layers = {};
    nodeIds.forEach(id => { (layers[depth[id]] ||= []).push(id); });

    const panelW = (window.innerWidth * 0.6);
    const panelH = (window.innerHeight * 0.8);
    const centerY = panelH / 2;
    const layerIds = Object.keys(layers).sort((a, b) => a - b);
    const xSpacing = Math.min(220, (panelW - 200) / Math.max(1, layerIds.length - 1));

    S.graph.nodes = {};
    layerIds.forEach((layerId, li) => {
        const ids = layers[layerId];
        const x = 120 + li * xSpacing;
        ids.forEach((id, idx) => {
            const ySpacing = 120;
            const y = centerY - ((ids.length - 1) * ySpacing) / 2 + idx * ySpacing;
            const terminal = id === "__start__" || id === "__end__";
            S.graph.nodes[id] = {
                id, x, y, label: nodeMeta[id].label || id,
                type: classifyType(id), terminal, hw: terminal ? TERM_HW : CARD_HW,
            };
        });
    });
    S.graph.links = links.map(l => ({ source: l.source, target: l.target }));

    drawEdges(linksGroup);
    Object.keys(S.graph.nodes).forEach(id => drawNode(nodesGroup, S.graph.nodes[id]));
}

function drawEdges(linksGroup) {
    S.graph.links.forEach(link => {
        const s = S.graph.nodes[link.source], t = S.graph.nodes[link.target];
        if (!s || !t) return;
        let x1, y1, x2, y2, dx, d;
        if (s.x < t.x) {
            x1 = s.x + s.hw; y1 = s.y; x2 = t.x - t.hw; y2 = t.y;
            dx = (x2 - x1) * 0.5;
            d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        } else {
            x1 = s.x - s.hw; y1 = s.y; x2 = t.x + t.hw; y2 = t.y;
            dx = (x1 - x2) * 0.5;
            d = `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
        }
        const p = svgEl("path");
        p.setAttribute("d", d);
        p.setAttribute("class", "edge");
        p.setAttribute("id", `edge-${link.source}-${link.target}`);
        linksGroup.appendChild(p);
    });
}

function drawNode(group, node) {
    const g = svgEl("g");
    g.setAttribute("id", `node-${node.id}`);
    g.setAttribute("transform", `translate(${node.x}, ${node.y})`);

    if (node.terminal) {
        const isStart = node.id === "__start__";
        g.setAttribute("class", `node terminal ${isStart ? "start" : "end"}`);
        if (isStart) {
            g.appendChild(circle("halo", 14));
            g.appendChild(circle("fill", 8));
        } else {
            g.appendChild(circle("outer", 14));
            g.appendChild(circle("inner", 6));
        }
        const label = svgEl("text");
        label.setAttribute("y", 30);
        label.setAttribute("class", "terminal-label");
        label.textContent = isStart ? "START" : "END";
        g.appendChild(label);
        group.appendChild(g);
        return;
    }

    g.setAttribute("class", "node");
    const rect = svgEl("rect");
    rect.setAttribute("x", -CARD_HW); rect.setAttribute("y", -28);
    rect.setAttribute("width", CARD_HW * 2); rect.setAttribute("height", 58);
    g.appendChild(rect);

    g.appendChild(cardText("node-type", -13, node.type));
    g.appendChild(cardText("node-label", 4, node.label));
    const metrics = cardText("node-metrics", 20, "");
    metrics.setAttribute("id", `metrics-${node.id}`);
    g.appendChild(metrics);
    group.appendChild(g);
}

function circle(cls, r) {
    const c = svgEl("circle");
    c.setAttribute("class", cls); c.setAttribute("r", r);
    return c;
}
function cardText(cls, y, text) {
    const t = svgEl("text");
    t.setAttribute("y", y); t.setAttribute("class", cls);
    t.textContent = text;
    return t;
}

// --- execution-state highlighting ----------------------------------------
export function setActiveNode(id) {
    document.querySelectorAll(".node.active").forEach(n => n.classList.remove("active"));
    document.querySelectorAll(".edge.active").forEach(e => e.classList.remove("active"));
    $(`node-${id}`)?.classList.add("active");
    S.graph.links.forEach(l => {
        if (l.target === id) $(`edge-${l.source}-${l.target}`)?.classList.add("active");
    });
}
export function setCompletedNode(id) {
    const n = $(`node-${id}`);
    if (n) { n.classList.remove("active"); n.classList.add("completed"); }
}
export function setErrorNode(id) {
    const n = $(`node-${id}`);
    if (n) { n.classList.remove("active", "completed"); n.classList.add("error"); }
}
export function clearNodeStates() {
    document.querySelectorAll(".node").forEach(n => n.classList.remove("active", "completed", "error"));
    document.querySelectorAll(".edge").forEach(e => e.classList.remove("active"));
}

// --- metrics + heatmap ----------------------------------------------------
export function updateNodeCard(id) {
    const el = $(`metrics-${id}`);
    if (!el) return;
    const parts = [];
    if (S.nodeDurations[id] != null) parts.push(`${Math.round(S.nodeDurations[id])}ms`);
    if (S.nodeTokens[id]) parts.push(`${S.nodeTokens[id]} tok`);
    el.textContent = parts.join(" · ");
}

export function applyHeat() {
    const vals = Object.values(S.nodeDurations);
    const max = vals.length ? Math.max(...vals) : 0;
    Object.keys(S.nodeDurations).forEach(id => {
        const rect = document.querySelector(`#node-${id} rect`);
        if (!rect) return;
        rect.style.fill = heatColor(max > 0 ? S.nodeDurations[id] / max : 0);
    });
}
// Cool surface (#16181e) -> warm amber (#b45309) by t in [0,1].
function heatColor(t) {
    const c0 = [22, 24, 30], c1 = [180, 83, 9];
    const m = c0.map((v, i) => Math.round(v + (c1[i] - v) * t));
    return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
}

export function recordMetrics(ev) {
    if (ev.duration_ms != null) { S.nodeDurations[ev.node_name] = ev.duration_ms; S.totals.duration += ev.duration_ms; }
    const tok = (ev.tokens && ev.tokens.total) || 0;
    if (tok) { S.nodeTokens[ev.node_name] = tok; S.totals.tokens += tok; }
    if (ev.cost_usd) S.totals.cost += ev.cost_usd;
    updateNodeCard(ev.node_name);
    applyHeat();
    updateSummary();
}

export function updateSummary() {
    $("sum-duration").textContent = Math.round(S.totals.duration).toLocaleString();
    $("sum-tokens").textContent = S.totals.tokens.toLocaleString();
    $("sum-cost").textContent = S.totals.cost.toFixed(4);
}
