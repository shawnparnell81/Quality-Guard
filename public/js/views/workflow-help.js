/* ============================================================
   Audit -> Discrepancy Investigation -> NCR / 8D / CAPA, drawn.

   A reference page: the flow from an internal audit finding to its
   corrective forms, and the DI state machine, as inline SVG in the
   same hand-rolled house style as the turtle diagram and the review
   charts - no diagram runtime. The Mermaid and PlantUML source for
   the same two figures lives in docs/audit-di-workflow.md.
   ============================================================ */

import { el } from "../dom.js";

const NS = "http://www.w3.org/2000/svg";

function s(name, attrs, text) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    if (text !== undefined) node.textContent = text;
    return node;
}

/* A wrapped-text label centred in a box. */
function label(x, y, lines, opts = {}) {
    const g = s("text", {
        "text-anchor": "middle", "font-size": opts.size || 12,
        "font-family": "'IBM Plex Sans', system-ui, sans-serif",
        fill: opts.fill || "var(--ink)", "font-weight": opts.weight || 400
    });
    const arr = Array.isArray(lines) ? lines : [lines];
    const lh = opts.size ? opts.size + 3 : 15;
    const top = y - ((arr.length - 1) * lh) / 2;
    arr.forEach((ln, i) => g.append(s("tspan", { x, y: top + i * lh }, ln)));
    return g;
}

function box(svg, x, y, w, h, lines, opts = {}) {
    svg.append(s("rect", {
        x, y, width: w, height: h, rx: 6,
        fill: opts.fill || "var(--surface)",
        stroke: opts.stroke || "var(--accent, var(--brand))",
        "stroke-width": opts.strokeWidth || 1.5
    }));
    svg.append(label(x + w / 2, y + h / 2, lines, opts));
}

function diamond(svg, cx, cy, rx, ry, lines) {
    svg.append(s("polygon", {
        points: `${cx},${cy - ry} ${cx + rx},${cy} ${cx},${cy + ry} ${cx - rx},${cy}`,
        fill: "var(--surface)", stroke: "var(--warn)", "stroke-width": 1.5
    }));
    svg.append(label(cx, cy, lines, { size: 11 }));
}

function arrow(svg, x1, y1, x2, y2, text) {
    svg.append(s("line", {
        x1, y1, x2, y2, stroke: "var(--ink-3)", "stroke-width": 1.5,
        "marker-end": "url(#awf-arrow)"
    }));
    if (text) {
        svg.append(label((x1 + x2) / 2 + (Math.abs(x2 - x1) < 4 ? 22 : 0), (y1 + y2) / 2 - 4, text,
            { size: 10, fill: "var(--ink-3)" }));
    }
}

function canvas(w, h) {
    const svg = s("svg", {
        viewBox: `0 0 ${w} ${h}`, class: "awf-svg", role: "img"
    });
    const defs = s("defs");
    const m = s("marker", {
        id: "awf-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5,
        markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse"
    });
    m.append(s("path", { d: "M0,0 L10,5 L0,10 z", fill: "var(--ink-3)" }));
    defs.append(m);
    svg.append(defs);
    return svg;
}

function drawFlow() {
    const W = 560, H = 560;
    const svg = canvas(W, H);
    const cx = W / 2;

    box(svg, cx - 90, 10, 180, 44, "Internal audit", { weight: 600 });
    arrow(svg, cx, 54, cx, 84);

    diamond(svg, cx, 110, 78, 30, ["Discrepancy", "found?"]);
    arrow(svg, cx + 78, 110, W - 70, 110, "no");
    box(svg, W - 140, 88, 130, 44, ["GM / QM signs,", "audit closed"], { stroke: "var(--ok)", size: 11 });
    arrow(svg, cx, 140, cx, 170, "yes");

    box(svg, cx - 110, 170, 220, 46, "Raise Discrepancy Investigation", { size: 11 });
    svg.append(label(cx + 122, 193, "di.manage", { size: 9, fill: "var(--ink-3)" }));
    arrow(svg, cx, 216, cx, 246);

    box(svg, 20, 246, 160, 52, ["Attach NCR form", "(upload or link)"], { size: 10 });
    box(svg, cx - 80, 246, 160, 52, ["Attach 8D report", "(upload or link)"], { size: 10 });
    box(svg, W - 180, 246, 160, 52, ["Attach CAPA form", "(upload or link)"], { size: 10 });
    svg.append(label(cx, 314, "each: di.manage - a completed controlled document per slot",
        { size: 9, fill: "var(--ink-3)" }));
    arrow(svg, cx, 298, cx, 332);

    diamond(svg, cx, 362, 92, 30, ["All three forms", "on file?"]);
    arrow(svg, cx - 92, 362, 40, 362, "no");
    box(svg, 20, 388, 150, 40, "Close DI blocked", { stroke: "var(--crit)", size: 10 });
    arrow(svg, cx, 392, cx, 422, "yes");

    box(svg, cx - 100, 422, 200, 46, "Close DI", { stroke: "var(--ok)", size: 12, weight: 600 });
    svg.append(label(cx, 488, "di.close - Quality Manager / General Manager only",
        { size: 9, fill: "var(--ink-3)" }));
    arrow(svg, cx, 468, cx, 498);

    box(svg, cx - 110, 498, 220, 46, "Audit can now close", { stroke: "var(--ok)", size: 11 });
    svg.append(label(cx, 566 - 6, "audit.close", { size: 9, fill: "var(--ink-3)" }));

    return svg;
}

function drawStates() {
    const W = 620, H = 150;
    const svg = canvas(W, H);
    const y = 60, bw = 128, bh = 44;
    const xs = [12, 172, 340, 500];
    const names = ["Open", "Investigating", ["Awaiting form", "closure"], "Closed"];
    const perms = ["di.manage", "di.manage", "di.close +\nall 3 forms"];

    names.forEach((n, i) => box(svg, xs[i], y, bw, bh, n,
        { size: i === 3 ? 12 : 11, stroke: i === 3 ? "var(--ok)" : "var(--accent, var(--brand))",
          weight: i === 3 ? 600 : 400 }));

    for (let i = 0; i < 3; i += 1) {
        arrow(svg, xs[i] + bw, y + bh / 2, xs[i + 1], y + bh / 2);
        svg.append(label((xs[i] + bw + xs[i + 1]) / 2, y - 6, perms[i].split("\n"),
            { size: 9, fill: i === 2 ? "var(--warn)" : "var(--ink-3)" }));
    }

    /* reopen edge: linked_closure -> investigating, curving below */
    svg.append(s("path", {
        d: `M ${xs[2] + bw / 2} ${y + bh} C ${xs[2]} ${y + bh + 40}, ${xs[1] + bw} ${y + bh + 40}, ${xs[1] + bw / 2} ${y + bh}`,
        fill: "none", stroke: "var(--ink-3)", "stroke-width": 1.25,
        "stroke-dasharray": "4 3", "marker-end": "url(#awf-arrow)"
    }));
    svg.append(label((xs[1] + xs[2] + bw) / 2, y + bh + 44, "reopen (di.manage)",
        { size: 9, fill: "var(--ink-3)" }));

    return svg;
}

export async function renderWorkflowHelp() {
    const flow = document.getElementById("awf-flow");
    const states = document.getElementById("awf-states");
    const notes = document.getElementById("awf-notes");
    if (!flow) return;

    flow.replaceChildren(drawFlow());
    if (states) states.replaceChildren(drawStates());

    if (notes) {
        notes.replaceChildren(el("ul", { class: "awf-notes" }, [
            el("li", {}, [
                el("strong", { text: "Gate 1 - DI closure. " }),
                document.createTextNode("A DI cannot move to Closed until the NCR form, the 8D report and "
                    + "the CAPA form are all attached (uploaded, or linked from Document Control). "
                    + "Enforced server-side in the workflow transition, and the Close button says which are missing.")
            ]),
            el("li", {}, [
                el("strong", { text: "Gate 2 - audit closure. " }),
                document.createTextNode("An audit that raised a DI cannot close until that DI is Closed. "
                    + "The finding is not resolved until its investigation is.")
            ]),
            el("li", {}, [
                el("strong", { text: "Who can do what. " }),
                document.createTextNode("Raise a DI, run the investigation, attach or replace a form: di.manage "
                    + "(Quality Engineer, Manufacturing Engineer, Engineering Manager, Quality Manager, GM). "
                    + "Close a DI: di.close (Quality Manager and General Manager only).")
            ]),
            el("li", {}, [
                el("strong", { text: "The forms. " }),
                document.createTextNode("Today the three slots hold the completed forms as controlled documents - "
                    + "the same NCR / 8D / CAPA forms already in Document Control, filled out and attached here. "
                    + "When those move to in-app editable forms, a slot gains a linked-record option; the workflow does not change.")
            ]),
            el("li", { class: "sm dim" }, "Diagram source (Mermaid + PlantUML): docs/audit-di-workflow.md")
        ]));
    }
}
