// Draggable dividers between the three panels (Graph | State / Log),
// with sizes persisted to localStorage. Pure pointer events, no library.
import { $ } from "./state.js";

const KEY = "lgv-panel-sizes";
const MIN_GRAPH = 260, MIN_RIGHT = 280, MIN_STATE = 130, MIN_LOG = 120;

export function initPanels() {
    const rightCol = $("right-column");
    const statePanel = $("state-panel");
    const dividerV = $("divider-v");
    const dividerH = $("divider-h");

    restore(rightCol, statePanel);

    // Vertical divider: drag changes the right column's width.
    makeDraggable(dividerV, (e) => {
        const container = $("main-container").getBoundingClientRect();
        let w = container.right - e.clientX;
        w = clamp(w, MIN_RIGHT, container.width - MIN_GRAPH);
        rightCol.style.width = `${w}px`;
    });

    // Horizontal divider: drag changes the State panel's height.
    makeDraggable(dividerH, (e) => {
        const colRect = rightCol.getBoundingClientRect();
        let h = e.clientY - colRect.top;
        h = clamp(h, MIN_STATE, colRect.height - MIN_LOG);
        statePanel.style.height = `${h}px`;
    });

    function persist() {
        try {
            localStorage.setItem(KEY, JSON.stringify({
                rightWidth: rightCol.style.width,
                stateHeight: statePanel.style.height,
            }));
        } catch { /* ignore */ }
    }
    dividerV.addEventListener("lgv-dragend", persist);
    dividerH.addEventListener("lgv-dragend", persist);
}

function makeDraggable(divider, onMove) {
    divider.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { divider.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        divider.classList.add("dragging");
        document.body.style.userSelect = "none";

        const move = (ev) => onMove(ev);
        const up = () => {
            try { divider.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
            divider.classList.remove("dragging");
            document.body.style.userSelect = "";
            divider.removeEventListener("pointermove", move);
            divider.removeEventListener("pointerup", up);
            divider.dispatchEvent(new Event("lgv-dragend"));
        };
        divider.addEventListener("pointermove", move);
        divider.addEventListener("pointerup", up);
    });
}

function restore(rightCol, statePanel) {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
        if (saved.rightWidth) rightCol.style.width = saved.rightWidth;
        if (saved.stateHeight) statePanel.style.height = saved.stateHeight;
    } catch { /* ignore */ }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, Math.max(lo, hi))); }
