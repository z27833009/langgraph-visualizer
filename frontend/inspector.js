// State inspector: full-state JSON, color-coded deltas, error/traceback
// region, first-anomaly detection, and the execution log.
import { S, $ } from "./state.js";

// --- execution log --------------------------------------------------------
export function addLogEntry(type, text) {
    const e = document.createElement("div");
    e.className = `log-entry ${type}`;
    const ts = new Date().toLocaleTimeString();
    e.innerHTML = `<span class="dot"></span><span class="ts">${ts}</span><span class="msg"></span>`;
    e.querySelector(".msg").textContent = text;   // textContent => no injection
    const lv = $("log-viewer");
    lv.appendChild(e);
    lv.scrollTop = lv.scrollHeight;
}

export function clearLog() { $("log-viewer").innerHTML = ""; }

// --- state + delta --------------------------------------------------------
export function updateState(fullState, delta) {
    const v = $("state-viewer");
    v.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "state-block";
    pre.textContent = JSON.stringify(fullState, null, 2);
    v.appendChild(pre);
    renderDelta(delta, v);
}

function renderDelta(delta, container) {
    if (!delta) return;
    const added = delta.added || {}, changed = delta.changed || {}, removed = delta.removed || {};
    if (!Object.keys(added).length && !Object.keys(changed).length && !Object.keys(removed).length) return;

    const title = document.createElement("div");
    title.className = "state-title changes";
    title.textContent = "Changes this step";
    container.appendChild(title);

    const list = document.createElement("div");
    list.className = "delta-list";
    const fmt = (v) => { const s = JSON.stringify(v); return s && s.length > 120 ? s.slice(0, 117) + "…" : s; };
    Object.entries(added).forEach(([k, v]) => row(list, "delta-added", `+ ${k}: ${fmt(v)}`));
    Object.entries(changed).forEach(([k, ov]) => row(list, "delta-changed", `~ ${k}: ${fmt(ov.old)} → ${fmt(ov.new)}`));
    Object.entries(removed).forEach(([k, v]) => row(list, "delta-removed", `- ${k}: ${fmt(v)}`));
    container.appendChild(list);
}

function row(list, cls, text) {
    const r = document.createElement("div");
    r.className = `delta-row ${cls}`;
    r.textContent = text;
    list.appendChild(r);
}

// --- error / traceback region --------------------------------------------
export function initErrorRegion() {
    const head = $("error-head"), tb = $("error-traceback"), toggle = $("error-toggle");
    head.addEventListener("click", () => {
        tb.classList.toggle("collapsed");
        toggle.style.transform = tb.classList.contains("collapsed") ? "rotate(-90deg)" : "";
    });
}

export function showError(nodeName, error) {
    $("error-title").textContent = `Error in ${nodeName}` + (error.type ? ` · ${error.type}` : "");
    $("error-traceback").textContent =
        (error.type ? `${error.type}: ${error.message}\n\n` : "") + (error.traceback || "(no traceback)");
    $("error-traceback").classList.remove("collapsed");
    $("error-toggle").style.transform = "";
    $("error-region").classList.add("visible");
}

export function hideError() {
    $("error-region").classList.remove("visible");
    $("error-traceback").textContent = "";
}

// --- first-anomaly heuristic (deterministic, no "AI diagnosis") -----------
export function detectAnomalies(nodeName, fullState, delta) {
    const changes = { ...(delta?.added || {}), ...(delta?.changed || {}) };
    Object.keys(changes).forEach(path => {
        const entry = delta.changed && delta.changed[path];
        const newVal = entry ? entry.new : changes[path];
        const oldVal = entry ? entry.old : undefined;
        const typeChanged = oldVal !== undefined && newVal !== undefined && jsType(oldVal) !== jsType(newVal);
        if (typeChanged) {
            flagAnomaly(nodeName, `'${path}' changed type ${jsType(oldVal)} → ${jsType(newVal)}`);
        } else if (isEmpty(newVal) && oldVal !== undefined && !isEmpty(oldVal)) {
            flagAnomaly(nodeName, `'${path}' became empty/None`);
        }
    });
}

function isEmpty(v) {
    return v === null || v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}
function jsType(v) { return v === null ? "null" : (Array.isArray(v) ? "array" : typeof v); }

export function flagAnomaly(nodeName, reason) {
    if (S.flaggedAnomalies.has(reason)) return;
    S.flaggedAnomalies.add(reason);
    addLogEntry("anomaly", `First anomaly @ ${nodeName}: ${reason}`);
}
