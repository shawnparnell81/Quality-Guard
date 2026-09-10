/* ============================================================
   First Article Inspection Report detail.

   A FAIR is a records row: a part / revision header, a ballooned
   characteristic table, an overall disposition, and a five-state
   workflow (draft -> in progress -> complete -> approved / rejected).

   Each characteristic's Pass / Fail and the conforming counts are
   computed server-side (applyFairResults in routes/records.js) from
   nominal + [tol_minus, tol_plus] vs actual, so this screen only has
   to display them - and colour the fails.
   ============================================================ */

import { api } from "../api.js";
import { confirmStep } from "../forms.js";
import { applyPermissions } from "../session.js";
import { el, pill, humanize, formatDate } from "../dom.js";

const STATE_LABEL = {
    draft: "Draft", in_progress: "In progress", complete: "Complete",
    approved: "Approved", rejected: "Rejected"
};
const STATE_KIND = {
    draft: "hold", in_progress: "prog", complete: "prog",
    approved: "done", rejected: "open"
};

const HEADER_FIELDS = [
    ["Part number", "part_number"], ["Part name", "part_name"], ["Revision", "revision"],
    ["Drawing / spec", "drawing"], ["Customer", "customer"], ["Customer PO / contract", "po_number"],
    ["Process / cell", "process"], ["Serial / lot", "serial_or_lot"],
    ["Material cert", "material_cert"], ["Special processes", "special_processes"],
    ["FAI type", "fai_type"], ["Inspection date", "inspection_date"],
    ["Inspected by", "inspected_by"], ["Equipment used", "equipment_used"]
];

const CHAR_COLUMNS = [
    ["Balloon", "balloon"], ["Characteristic", "feature"], ["Class", "char_class"],
    ["Nominal", "nominal"], ["Tol −", "tol_minus"], ["Tol +", "tol_plus"],
    ["Method", "method"], ["Actual", "actual"], ["Result", "result"], ["Notes", "notes"]
];

function charTable(rows) {
    if (!rows || rows.length === 0) {
        return el("p", { class: "sm dim", text: "No characteristics recorded yet." });
    }
    return el("div", { class: "table-wrap" }, el("table", { class: "sm dim-repeater" }, [
        el("thead", {}, el("tr", {}, CHAR_COLUMNS.map(([label]) => el("th", { scope: "col", text: label })))),
        el("tbody", {}, rows.map((row) => {
            const fail = row.result === "Fail";
            return el("tr", { class: fail ? "fair-fail-row" : undefined },
                CHAR_COLUMNS.map(([, key]) => {
                    const value = row[key];
                    const td = el("td", { class: "sm", text: value != null && value !== "" ? String(value) : "-" });
                    if (key === "result" && value === "Fail") td.classList.add("fair-fail");
                    if (key === "result" && value === "Pass") td.classList.add("fair-pass");
                    return td;
                }));
        }))
    ]));
}

function dispositionKind(disposition) {
    if (disposition === "Accepted") return "done";
    if (disposition === "Rejected") return "open";
    return "prog";
}

function transitionsRow(number, record, transitions, slot) {
    if (!transitions || transitions.length === 0) {
        return el("p", { class: "sm dim no-print",
            text: "This FAIR is " + (STATE_LABEL[record.status] || record.status).toLowerCase() + "." });
    }

    const buttons = transitions.map((step) => {
        const button = el("button", {
            class: "btn" + (step.allowed ? " btn-primary" : " not-permitted"),
            type: "button", title: step.blocked_because || "Move to " + step.label
        }, step.label);

        if (!step.allowed) { button.disabled = true; return button; }

        button.addEventListener("click", () => confirmStep({
            title: "Move " + number + " to " + step.label,
            body: step.is_terminal
                ? "This closes the FAIR as " + step.label.toLowerCase() + "."
                : "The FAIR moves to " + step.label + ".",
            confirmLabel: "Move to " + step.label,
            onConfirm: async (reason) => {
                await api.transition(number, { to: step.to, reason });
                await renderFairDetail(number, { slot });
            }
        }));

        return button;
    });

    return el("div", { class: "no-print" }, [
        el("div", { class: "section-label", text: "Move this forward" }),
        el("div", { class: "row" }, buttons)
    ]);
}

/* `slot` is the id prefix the detail is written into - "fair" for the
   register side panel (unchanged), "record-view" for the full-page
   record view (record-page.js). */
export async function renderFairDetail(number, { slot = "fair" } = {}) {
    const numberEl = document.getElementById(slot + "-detail-number");
    const statusEl = document.getElementById(slot + "-detail-status");
    const body = document.getElementById(slot + "-detail");
    if (!body) return;

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { record, transitions } = await api.record(number);
        const d = record.data || {};

        if (numberEl) numberEl.textContent = number;
        if (statusEl) {
            statusEl.replaceChildren(pill(
                STATE_LABEL[record.status] || humanize(record.status),
                STATE_KIND[record.status] || "hold"
            ));
        }

        const header = el("dl", { class: "kv" });
        for (const [label, key] of HEADER_FIELDS) {
            const raw = d[key];
            if (raw == null || raw === "") continue;
            header.append(el("dt", { text: label }));
            header.append(el("dd", { text: key === "inspection_date" ? formatDate(raw) : String(raw) }));
        }

        const drawingRow = d.drawing
            ? el("p", { class: "sm dim no-print", style: "margin:6px 0 0" }, [
                document.createTextNode("Drawing " + d.drawing + "  "),
                (() => {
                    const open = el("button", { class: "link-btn", type: "button", text: "Open Engineering Documents" });
                    open.addEventListener("click", () => document.dispatchEvent(
                        new CustomEvent("navigate", { detail: { view: "eng-documents" } })));
                    return open;
                })()
            ])
            : null;

        const rows = Array.isArray(d.characteristics) ? d.characteristics : [];
        const checked = Number(d.checked_count) || 0;
        const conforming = Number(d.conforming_count) || 0;
        const nonconforming = checked - conforming;

        const summary = el("div", { class: "row", style: "gap:10px;align-items:center;margin:12px 0 4px" }, [
            el("strong", { class: "sm", text: conforming + " of " + checked + " conforming" }),
            checked === 0
                ? el("span", { class: "sm dim", text: "no measured characteristics" })
                : nonconforming > 0
                    ? el("span", { class: "sm", style: "color:var(--crit)", text: nonconforming + " nonconforming" })
                    : el("span", { class: "sm", style: "color:var(--ok)", text: "all in tolerance" }),
            d.disposition ? pill(d.disposition, dispositionKind(d.disposition)) : null
        ]);

        const dispDl = el("dl", { class: "kv" });
        for (const [label, key] of [
            ["Disposition", "disposition"], ["Deviation / concession", "deviation_reference"],
            ["Nonconformance detail", "nonconformances"], ["Reviewed by", "reviewed_by"],
            ["Review date", "review_date"]
        ]) {
            const raw = d[key];
            if (raw == null || raw === "") continue;
            dispDl.append(el("dt", { text: label }));
            dispDl.append(el("dd", { text: key === "review_date" ? formatDate(raw) : String(raw) }));
        }

        body.replaceChildren(
            header,
            drawingRow,
            el("div", { class: "section-label", text: "Characteristics" }),
            summary,
            charTable(rows),
            el("div", { class: "section-label", text: "Disposition" }),
            dispDl.childElementCount ? dispDl : el("p", { class: "sm dim", text: "Not dispositioned yet." }),
            transitionsRow(number, record, transitions, slot)
        );
        applyPermissions(body);
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}
