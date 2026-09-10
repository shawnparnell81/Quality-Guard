/* ============================================================
   Print view.

   ?print=<number> opens one record's designed form on a bare,
   paper-sized page - no sidebar, no tabs, no app chrome - so the
   person can review it and hit Ctrl+P / "Save as PDF" for a clean
   controlled-document copy.

   The built-in 8D has its own builder; every other form renders
   through the generic live-document builder from its schema. Styled
   by the per-form @media print rules in style.css.
   ============================================================ */

import { api } from "../api.js";
import { el } from "../dom.js";
import { buildEightDForm } from "./change.js";
import { buildLiveForm } from "./live-form.js";

/* per-type overrides; everything else falls back to buildLiveForm */
const BUILDERS = {
    eightd: (record) => buildEightDForm(record, { editable: false })
};

export async function openPrintView(number) {
    const host = document.getElementById("print-host");
    if (!host) return;

    document.body.classList.add("print-mode");
    document.title = number + " · Print · QMS Guardian";
    host.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));

    let record, definition;
    try {
        record = (await api.record(number)).record;
        definition = await api.recordForm(record.type, { version: record.form_version }).catch(() => null);
    } catch (error) {
        host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    let sheet;
    if (BUILDERS[record.type]) {
        sheet = BUILDERS[record.type](record);
    } else if (definition && Array.isArray(definition.fields)) {
        sheet = buildLiveForm(record, definition, { editable: false }).node;
    } else {
        host.replaceChildren(el("p", { class: "sm",
            text: record.number + " has no designed print layout - use the PDF button instead." }));
        return;
    }

    const bar = el("div", { class: "print-bar no-print" }, [
        el("button", { class: "btn btn-primary", type: "button", text: "Print / Save as PDF",
            onClick: () => window.print() }),
        el("button", { class: "btn", type: "button", text: "Close",
            onClick: () => window.close() })
    ]);

    sheet.classList.add("print-area");
    host.replaceChildren(bar, sheet);
    window.scrollTo(0, 0);
}
