// Shared mutable state + tiny DOM helper.
// One object whose properties are mutated, so every module sees the same data
// (avoids ES-module live-binding reassignment pitfalls).
export const S = {
    mode: "live",                 // "live" | "replay"
    graph: { nodes: {}, links: [] },
    nodeDurations: {},            // node_name -> latest duration_ms (heatmap)
    nodeTokens: {},               // node_name -> latest token total
    totals: { duration: 0, tokens: 0, cost: 0 },
    replayTimeline: [],           // node_end / node_error events, ordered by step
    flaggedAnomalies: new Set(),  // anomalies already reported (fire once)
};

export const $ = (id) => document.getElementById(id);

export const SVG_NS = "http://www.w3.org/2000/svg";
export const svgEl = (tag) => document.createElementNS(SVG_NS, tag);
