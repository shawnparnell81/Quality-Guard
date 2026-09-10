/* ============================================================
   Print view.

   ?print=<number> opens one record's designed form on a bare,
   paper-sized page - no sidebar, no tabs, no app chrome - so the
   person can review it and hit Ctrl+P / "Save as PDF" for a clean
   controlled-document copy.

   Only form types with a bespoke print layout come here (8D, the
   calibration log); every other type keeps the generated pdfkit PDF.
   The layout is the same builder the on-screen form uses, rendered
   read-only, and styled by the per-form @media print rules in
   style.css.
   ============================================================ */

import { api } from "../api.js";
import { el } from "../dom.js";
import { buildEightDForm } from "./change.js";
import { buildCalLogForm } from "./calibration-log.js";

const BUILDERS = {
    eightd: buildEightDForm,
    calibration_log: buildCalLogForm
};

export async function openPrintView(number) {
    const host = document.getElementById("print-host");
    if (!host) return;

    document.body.classList.add("print-mode");
    document.title = number + " · Print · QMS Guardian";
    host.replaceChildren(el("p", { class: "sm dim", text: "Loading…" }));

    let record;
    try {
        record = (await api.record(number)).record;
    } catch (error) {
        host.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    const build = BUILDERS[record.type];
    if (!build) {
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

    const sheet = build(record, { editable: false });
    sheet.classList.add("print-area");

    host.replaceChildren(bar, sheet);
    window.scrollTo(0, 0);
}
