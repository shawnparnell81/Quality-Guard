/* ============================================================
   Small shared helpers for the form field renderers - the one modal
   dialog, the threshold colouring, and the human-readable label for
   a computed column. Split out of forms.js so the table editor
   (table-editor.js) can use them without importing forms.js back.
   ============================================================ */

import { el } from "./dom.js";
import { identifiers as exprIdentifiers } from "./expr.js";

/* One <dialog> reused for every modal in the form area (row drawer,
   per-row attachments, signature prompt). */
let dialog = null;

export function ensureDialog() {
    if (dialog) return dialog;

    dialog = el("dialog", { class: "modal" });
    document.body.append(dialog);

    /* Clicking the backdrop closes. The dialog element reports clicks
       on the backdrop as clicks on itself, so compare the target. */
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
    });

    return dialog;
}

/* Amber / red on a numeric cell once it crosses column.thresholds.
   By default a HIGH value is the bad one (RPN); thresholds.direction
   "low" flips it so a value AT OR BELOW the threshold is the bad one
   (a yield %, an OEE, a Cpk). */
export function paintThreshold(cell, column, value) {
    cell.classList.remove("rpn-warn", "rpn-crit");
    const t = column.thresholds;
    const n = Number(value);
    if (!t || value === "" || !Number.isFinite(n)) return;
    const low = t.direction === "low";
    const past = (limit) => (low ? n <= limit : n >= limit);
    if (t.crit != null && past(t.crit)) cell.classList.add("rpn-crit");
    else if (t.warn != null && past(t.warn)) cell.classList.add("rpn-warn");
}

/* "RPN = Severity × Occurrence × Detection" - shown as the title of a
   computed cell so a person knows where its value comes from. */
export function describeComputed(column, columns) {
    const labelOf = (k) => (columns.find((c) => c.key === k) || {}).label || k;

    if (typeof column.expr === "string" && column.expr.trim()) {
        let text = column.expr;
        try {
            for (const id of exprIdentifiers(column.expr)) {
                text = text.replace(
                    new RegExp("\\b" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"),
                    labelOf(id));
            }
        } catch { /* unparseable - show it verbatim */ }
        return column.label + " = " + text.replace(/\*/g, " × ").replace(/\//g, " ÷ ");
    }

    const join = column.compute === "sum" ? " + " : " × ";
    return column.label + " = " + (column.inputs || []).map(labelOf).join(join);
}
