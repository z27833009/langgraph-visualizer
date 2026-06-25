// Replay / time travel: run selector, REST-driven snapshot loading,
// timeline slider and keyboard stepping. Does not depend on the WebSocket.
import { S, $ } from "./state.js";
import {
    initGraph, clearNodeStates, setErrorNode, updateNodeCard, applyHeat, updateSummary,
} from "./graph.js";
import { updateState, showError, hideError, addLogEntry, clearLog } from "./inspector.js";

let onEnterLive = () => {};

export function initReplay(enterLiveCallback) {
    onEnterLive = enterLiveCallback;
    $("run-select").addEventListener("change", (e) => {
        const v = e.target.value;
        if (v === "__live__") onEnterLive();
        else enterReplay(v);
    });
    const tl = $("timeline");
    tl.addEventListener("input", () => renderReplayStep(parseInt(tl.value, 10)));
    $("tl-prev").addEventListener("click", () => renderReplayStep(parseInt(tl.value, 10) - 1));
    $("tl-next").addEventListener("click", () => renderReplayStep(parseInt(tl.value, 10) + 1));
    document.addEventListener("keydown", (e) => {
        if (S.mode !== "replay") return;
        if (e.key === "ArrowLeft") { renderReplayStep(parseInt(tl.value, 10) - 1); e.preventDefault(); }
        else if (e.key === "ArrowRight") { renderReplayStep(parseInt(tl.value, 10) + 1); e.preventDefault(); }
    });
}

export async function refreshRunList() {
    let runs = [];
    try { runs = await (await fetch("/runs")).json(); } catch { return; }
    const sel = $("run-select");
    const current = sel.value;
    sel.innerHTML = '<option value="__live__">Live</option>';
    runs.forEach(r => {
        const o = document.createElement("option");
        o.value = r.run_id;
        const when = r.started_at ? new Date(r.started_at * 1000).toLocaleTimeString() : "";
        o.textContent = `${r.status} · ${when} · ${r.run_id.slice(0, 8)}`;
        sel.appendChild(o);
    });
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

export async function enterReplay(runId) {
    let run, events;
    try {
        run = await (await fetch(`/runs/${runId}`)).json();
        events = await (await fetch(`/runs/${runId}/events`)).json();
    } catch { addLogEntry("error", `Failed to load run ${runId}`); return; }

    S.mode = "replay";
    hideError();
    initGraph((run.structure || {}).nodes || [], (run.structure || {}).links || []);

    S.nodeDurations = {}; S.nodeTokens = {};
    events.forEach(e => {
        if (e.event_type === "node_end") {
            if (e.duration_ms != null) S.nodeDurations[e.node_name] = e.duration_ms;
            const tok = (e.tokens && e.tokens.total) || 0;
            if (tok) S.nodeTokens[e.node_name] = tok;
        }
    });
    S.totals = {
        duration: events.reduce((s, e) => s + (e.duration_ms || 0), 0),
        tokens: run.total_tokens || 0,
        cost: run.total_cost || 0,
    };
    updateSummary();
    applyHeat();

    S.replayTimeline = events.filter(e => e.event_type === "node_end" || e.event_type === "node_error");
    const tl = $("timeline");
    tl.min = 0;
    tl.max = Math.max(0, S.replayTimeline.length - 1);
    tl.value = tl.max;
    $("timeline-bar").classList.add("visible");
    renderReplayStep(S.replayTimeline.length - 1);
}

export function hideTimeline() { $("timeline-bar").classList.remove("visible"); }

function renderReplayStep(idx) {
    const tlen = S.replayTimeline.length;
    if (!tlen) return;
    idx = Math.max(0, Math.min(idx, tlen - 1));
    $("timeline").value = idx;
    clearNodeStates();
    hideError();

    for (let j = 0; j <= idx; j++) {
        const ev = S.replayTimeline[j];
        const node = $(`node-${ev.node_name}`);
        if (!node) continue;
        if (ev.event_type === "node_error") { node.classList.remove("completed"); node.classList.add("error"); }
        else node.classList.add("completed");
        updateNodeCard(ev.node_name);
    }

    const cur = S.replayTimeline[idx];
    if (cur.event_type === "node_error") {
        setErrorNode(cur.node_name);
        showError(cur.node_name, cur.error || {});
    } else {
        $(`node-${cur.node_name}`)?.classList.add("active");
        updateState(cur.full_state, cur.state_delta);
    }
    $("tl-label").textContent = `step ${idx + 1} / ${tlen} · ${cur.node_name}`;

    // Rebuild the Execution Log up to the current step so it tracks scrubbing,
    // highlighting the current step (debugger-style).
    clearLog();
    for (let j = 0; j <= idx; j++) {
        const ev = S.replayTimeline[j];
        const current = j === idx;
        if (ev.event_type === "node_error") {
            addLogEntry("error", `${ev.node_name}: ${ev.error?.message || "error"}`, { ts: ev.ts, current });
        } else {
            const d = ev.duration_ms != null ? ` (${Math.round(ev.duration_ms)}ms)` : "";
            addLogEntry("end", `${ev.node_name}${d}`, { ts: ev.ts, current });
        }
    }
}
