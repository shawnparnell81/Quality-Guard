/* ============================================================
   Quality event registers.

   NCR, CAPA, complaint, audit and risk all render through the same
   function, because on the server they are all rows in the records
   table. Only the column list differs, so only the column list is
   written out per module - and the same is true of the detail panel
   below the register: one function, driven by whichever type it was
   asked for, rather than a screen written per type.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { openRecordEditor, confirmStep, editDueDate } from "../forms.js";
import { renderEightD, renderChange } from "./change.js";
import { renderApqpDetail } from "./apqp.js";
import { renderDiDetail } from "./di.js";
import { renderFairDetail } from "./fair.js";
import { openEntityForm } from "../entity-form.js";
import { renderDocumentsPanel } from "./resources.js";
import { openFileWindow } from "../doc-windows.js";
import { recordLink, looksLikeRecordNumber } from "../record-nav.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, statusKind, printElement, toast
} from "../dom.js";

/* 8D and ECN keep their own register + detail rendering (change.js) -
   the eight-discipline track and the impact sign-off table are not
   the generic key/value detail every other type shares - so creating
   or editing one of these refreshes through those functions instead
   of REGISTERS/renderRecordDetail below. */
const OWN_SCREEN_REFRESH = {
    eightd: renderEightD,
    ecn: renderChange,
    apqp: (number) => renderApqpDetail(number),
    di: (number) => renderDiDetail(number),
    fair: (number) => renderFairDetail(number)
};

/* Which sidebar screen "New X" and "Edit X" should return to once the
   full-page editor is done - the nav-item data-view values, not the
   record type keys, since a few of them differ (complaint -> the
   "complaints" screen, eightd -> "d8", ecn -> "change"). */
const TYPE_VIEW = {
    ncr: "ncr", capa: "capa", complaint: "complaints",
    audit: "audit", risk: "risk", eightd: "d8", ecn: "change", scar: "scar", fair: "fair"
};

/* Shared first column: severity stripe plus record number. */
const idColumn = {
    className: "nowrap",
    render: (row) => [severity(row.severity), recordId(row.number)]
};

const statusColumn = {
    render: (row) => pill(humanize(row.status), statusKind(row.status))
};

const REGISTERS = {
    ncr: {
        tbody: "ncr-register",
        columns: [
            idColumn,
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "sm", render: (row) => row.title },
            { className: "num", render: (row) =>
                row.data.qty_affected != null ? row.data.qty_affected.toLocaleString() : "-" },
            { className: "sm", render: (row) => row.data.disposition || "-" },
            statusColumn
        ]
    },

    capa: {
        tbody: "capa-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.title },
            { className: "sm", render: (row) => row.owner || "-" },
            { className: "mono sm", render: (row) => dueCell(row) },
            statusColumn
        ]
    },

    complaint: {
        tbody: "complaint-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", render: (row) => row.title },
            { className: "num", render: (row) =>
                row.data.qty != null ? row.data.qty.toLocaleString() : "-" },
            { className: "mono sm", render: (row) =>
                row.closed_at ? "closed" : dueCell(row) },
            statusColumn
        ]
    },

    audit: {
        tbody: "audit-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.scope || row.title },
            { className: "sm", render: (row) => row.data.auditor || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.planned) },
            statusColumn
        ]
    },

    risk: {
        tbody: "risk-table",
        columns: [
            { className: "mono sm", render: (row) => row.number },
            { className: "sm", render: (row) => row.title },
            { className: "sm dim", render: (row) => row.data.process || "-" },
            { className: "num", render: (row) => row.data.severity ?? "-" },
            { className: "num", render: (row) => row.data.occurrence ?? "-" },
            { className: "num", render: (row) => row.data.detection ?? "-" },
            { className: "num", render: (row) => rpnCell(row.data.rpn) },
            { className: "sm", render: (row) => row.data.action || "-" },
            statusColumn
        ]
    },

    apqp: {
        tbody: "apqp-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "sm", render: (row) => row.title },
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.target_sop) },
            { className: "sm dim", render: (row) => row.data.psw_status || "-" },
            statusColumn
        ]
    },

    di: {
        tbody: "di-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.department || "-" },
            { className: "sm", render: (row) => row.data.finding || row.title },
            { className: "sm dim", render: (row) => row.data.investigator || "-" },
            statusColumn
        ]
    },

    scar: {
        tbody: "scar-register",
        columns: [
            idColumn,
            { className: "sm", render: (row) => row.data.supplier || "-" },
            { className: "sm", render: (row) => row.title },
            { className: "mono sm nowrap", render: (row) => row.data.part_number || "-" },
            { className: "mono sm", render: (row) => scarDueCell(row) },
            statusColumn
        ]
    },

    fair: {
        tbody: "fair-register",
        columns: [
            idColumn,
            { className: "mono sm nowrap", render: (row) =>
                (row.data.part_number || "-") + (row.data.revision ? " / " + row.data.revision : "") },
            { className: "sm", render: (row) => row.data.customer || "-" },
            { className: "mono sm", render: (row) => formatDate(row.data.inspection_date) },
            { className: "num", render: (row) => {
                const checked = Number(row.data.checked_count) || 0;
                if (checked === 0) return "-";
                const nc = checked - (Number(row.data.conforming_count) || 0);
                const text = (checked - nc) + " / " + checked;
                return nc > 0 ? el("span", { style: "color:var(--crit)", text }) : text;
            } },
            statusColumn
        ]
    }
};

/* A SCAR's own due date is the supplier's response deadline, carried
   in data.response_due rather than the shared records.due_at column,
   so it needs its own overdue check. */
function scarDueCell(row) {
    const due = row.data.response_due;
    if (!due) return "-";
    const overdue = row.status !== "closed" && new Date(due) < new Date();
    const text = formatDate(due) + (overdue ? " overdue" : "");
    return overdue ? el("span", { style: "color:var(--crit)", text }) : text;
}

/* An overdue date is worth colouring, because it is the one thing on
   these screens that means someone has to act today. */
function dueCell(row) {
    if (!row.due_at) return "-";

    const overdue = !row.closed_at && new Date(row.due_at) < new Date();
    const text = formatDate(row.due_at) + (overdue ? " overdue" : "");

    return overdue
        ? el("span", { style: "color:var(--crit)", text })
        : text;
}

function rpnCell(rpn) {
    if (rpn == null) return "-";

    const colour = rpn >= 150 ? "var(--crit)" : rpn >= 100 ? "var(--warn)" : null;
    return colour ? el("span", { style: "color:" + colour, text: rpn }) : String(rpn);
}

/* A detail-view <dd>. A value that is just another record's number
   ("Work order", "Source", a receipt's NCR) becomes a link to it. */
function fieldValueDd(field, value) {
    const text = String(value).trim();
    if (looksLikeRecordNumber(text)) {
        return el("dd", {}, recordLink(text, { chip: false }));
    }
    return el("dd", { text: field && field.type === "date" ? formatDate(value) : text });
}

/* Severity and open-only, per type. The server already understood
   these query params (records.js) - nothing here needed a backend
   change, only a control to actually send them. */
const activeFilters = {};

function currentFilterParams(type) {
    const filter = activeFilters[type] || {};
    return {
        type,
        severity: filter.severity || undefined,
        open: filter.open ? "true" : undefined
    };
}

function hasActiveFilter(type) {
    const filter = activeFilters[type] || {};
    return Boolean(filter.severity || filter.open);
}

export async function renderRegister(type) {
    const config = REGISTERS[type];
    if (!config) return;

    const tbody = document.getElementById(config.tbody);
    loadingRow(tbody, config.columns.length);

    try {
        const { records } = await api.records(currentFilterParams(type));
        fillTable(tbody, records, config.columns,
            hasActiveFilter(type) ? "No records match this filter" : "No records of this type yet");

        /* Tag each row with its record number so one delegated listener
           can work out what was clicked. fillTable emits rows in the
           order it was given them, so index lines up with the data. */
        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!records[index]) return;
            tr.dataset.number = records[index].number;
            tr.classList.add("row-clickable");
        });

        /* Every register shows one record in full, not only NCR. */
        if (records.length > 0) {
            selectRow(tbody, records[0].number);
            await renderRecordDetail(type, records[0].number);
        } else {
            clearDetail(type);
        }

        /* Computed from exactly what is on screen right now (so it
           tracks whatever filter is active), the same overdue rule
           every other module uses: still open, and past its due date. */
        const overdueNote = document.getElementById(type + "-overdue-note");
        if (overdueNote) {
            const overdue = records.filter((r) =>
                !r.closed_at && r.due_at && new Date(r.due_at) < new Date()).length;
            overdueNote.textContent = overdue === 1 ? "1 overdue" : overdue + " overdue";
            overdueNote.hidden = overdue === 0;
        }

        if (type === "risk") renderRiskMatrix(records);
    } catch (error) {
        errorRow(tbody, config.columns.length, error);
    }
}

/* ============================================================
   Risk matrix - severity x occurrence, the standard FMEA heat map.
   Detection is deliberately left out of the grid itself (it already
   factors into RPN, shown in the register below); severity x
   occurrence is what a risk matrix conventionally plots.
   ============================================================ */

let riskRecordsCache = [];

function riskLevel(score) {
    if (score >= 50) return "crit";
    if (score >= 20) return "warn";
    return "ok";
}

function renderRiskMatrix(records) {
    const container = document.getElementById("risk-matrix");
    if (!container) return;

    riskRecordsCache = records;

    const counts = {};
    for (const record of records) {
        const sev = record.data?.severity;
        const occ = record.data?.occurrence;
        /* Opportunities and anything scored outside 1-10 do not plot
           on a risk matrix - skipped rather than forced into a cell
           that would misrepresent them. */
        if (!Number.isInteger(sev) || !Number.isInteger(occ)) continue;
        if (sev < 1 || sev > 10 || occ < 1 || occ > 10) continue;

        const key = sev + "," + occ;
        counts[key] = (counts[key] || 0) + 1;
    }

    const grid = el("div", { class: "risk-matrix-grid" });

    grid.append(el("div", { class: "rm-corner", text: "Sev \\ Occ" }));
    for (let occ = 1; occ <= 10; occ++) {
        grid.append(el("div", { class: "rm-axis-label", text: String(occ) }));
    }

    for (let sev = 10; sev >= 1; sev--) {
        grid.append(el("div", { class: "rm-axis-label", text: String(sev) }));

        for (let occ = 1; occ <= 10; occ++) {
            const n = counts[sev + "," + occ] || 0;
            const level = riskLevel(sev * occ);

            const cell = el("button", {
                type: "button",
                class: "rm-cell rm-" + level + (n === 0 ? " rm-empty" : ""),
                title: "Severity " + sev + " × occurrence " + occ + ": " + n + " risk(s)"
            }, n > 0 ? String(n) : "");

            if (n > 0) {
                cell.addEventListener("click", () => filterRiskMatrixCell(sev, occ));
            }

            grid.append(cell);
        }
    }

    container.replaceChildren(
        grid,
        el("div", { class: "risk-matrix-legend" }, [
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-ok" }), "Low"]),
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-warn" }), "Medium"]),
            el("span", { class: "rm-legend-item" }, [el("span", { class: "rm-swatch rm-crit" }), "High"])
        ])
    );
}

/* Filters the already-fetched list client-side rather than adding a
   backend query param nothing else needs - clicking a cell is asking
   "which of what I already have sits here," not a new search. */
function filterRiskMatrixCell(severity, occurrence) {
    const config = REGISTERS.risk;
    const tbody = document.getElementById(config.tbody);
    if (!tbody) return;

    const matching = riskRecordsCache.filter((r) =>
        r.data?.severity === severity && r.data?.occurrence === occurrence);

    fillTable(tbody, matching, config.columns, "No records match this cell");

    tbody.querySelectorAll("tr").forEach((tr, index) => {
        if (!matching[index]) return;
        tr.dataset.number = matching[index].number;
        tr.classList.add("row-clickable");
    });

    if (matching.length > 0) {
        selectRow(tbody, matching[0].number);
        renderRecordDetail("risk", matching[0].number);
    }
}

function selectRow(tbody, number) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.number === number);
    });
}

function clearDetail(type) {
    const heading = document.getElementById(type + "-detail-number");
    const statusSlot = document.getElementById(type + "-detail-status");
    const panel = document.getElementById(type + "-detail");
    const pdfButton = document.getElementById(type + "-pdf");
    const editButton = document.getElementById(type + "-edit");

    if (heading) heading.textContent = "Select a record";
    if (statusSlot) statusSlot.replaceChildren();
    if (panel) panel.replaceChildren();
    if (pdfButton) delete pdfButton.dataset.number;
    if (editButton) delete editButton.dataset.number;
}

/* One listener per register, attached once when this module loads.
   Rows are replaced on every fetch, so a listener per row would have
   to be rebuilt each time; these never are. */
export function wireRegisterClicks() {
    for (const [type, config] of Object.entries(REGISTERS)) {
        const tbody = document.getElementById(config.tbody);
        if (!tbody) continue;

        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-number]");
            if (!row) return;

            selectRow(tbody, row.dataset.number);
            renderRecordDetail(type, row.dataset.number);
        });

        const printButton = document.getElementById(type + "-print");
        if (printButton) {
            printButton.addEventListener("click", () => {
                printElement(document.getElementById(type + "-detail-panel"));
            });
        }

        /* The PDF button has no href of its own - renderRecordDetail
           stamps the currently-shown record's number onto it via
           dataset each time the detail panel changes, so this always
           downloads whatever is actually on screen. */
        const pdfButton = document.getElementById(type + "-pdf");
        if (pdfButton) {
            pdfButton.addEventListener("click", () => {
                const number = pdfButton.dataset.number;
                if (number) window.location.href = "/api/records/" + encodeURIComponent(number) + "/pdf";
            });
        }
    }

    /* One delegated listener for every severity dropdown and every
       "open only" checkbox, across every register - each element
       says which type it belongs to, so this never needs to know how
       many registers exist. */
    document.addEventListener("change", (event) => {
        const severitySelect = event.target.closest(".filter-severity");
        if (severitySelect) {
            const type = severitySelect.dataset.type;
            activeFilters[type] = { ...activeFilters[type], severity: severitySelect.value };
            renderRegister(type);
            return;
        }

        const openCheckbox = event.target.closest(".filter-open input");
        if (openCheckbox) {
            const type = openCheckbox.dataset.type;
            activeFilters[type] = { ...activeFilters[type], open: openCheckbox.checked };
            renderRegister(type);
        }
    });

    /* Every "raise a record" and "edit this record" button on every
       screen, through one listener each. The button says which type
       it opens, and edit buttons carry the currently-shown record's
       number in their dataset (stamped by renderRecordDetail, or by
       the type's own detail renderer for 8D and ECN). */
    document.addEventListener("click", (event) => {
        const newButton = event.target.closest("[data-new-record]");
        if (newButton && !newButton.disabled) {
            const type = newButton.dataset.newRecord;

            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
            openRecordEditor(type, {
                returnView: TYPE_VIEW[type] || type,
                onSaved: async (created) => {
                    if (OWN_SCREEN_REFRESH[type]) {
                        await OWN_SCREEN_REFRESH[type](created.number);
                    } else if (REGISTERS[type]) {
                        await renderRegister(type);

                        /* Land on the thing that was just created rather
                           than leaving somebody to hunt for it. */
                        const register = document.getElementById(REGISTERS[type].tbody);
                        if (register) selectRow(register, created.number);
                        await renderRecordDetail(type, created.number);
                    }
                }
            });
            return;
        }

        const editButton = event.target.closest("[data-edit-record]");
        if (editButton && !editButton.disabled) {
            const type = editButton.dataset.editRecord;
            const number = editButton.dataset.number;
            if (!number) return;

            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
            openRecordEditor(type, {
                number,
                returnView: TYPE_VIEW[type] || type,
                onSaved: async (updated) => {
                    if (OWN_SCREEN_REFRESH[type]) {
                        await OWN_SCREEN_REFRESH[type](updated.number);
                    } else if (REGISTERS[type]) {
                        await renderRegister(type);
                        const register = document.getElementById(REGISTERS[type].tbody);
                        if (register) selectRow(register, updated.number);
                        await renderRecordDetail(type, updated.number);
                    }
                }
            });
        }
    });
}

/* ---------- detail panel ---------- */

const DETAIL_FIELDS = [
    ["Customer",              (d) => d.customer],
    ["Contact",               (d) => d.contact],
    ["Part",                  (d) => d.part_number],
    ["Lot / serial",          (d) => d.lot_number],
    ["Work order",            (d) => d.work_order],
    ["Operation",             (d) => d.operation],
    ["Characteristic",        (d) => d.characteristic],
    ["Measured",              (d) => d.measured],
    ["Gage",                  (d) => d.gage_id],
    ["Detected at",           (d) => d.detected_at],
    ["Qty affected",          (d) => d.qty_affected],
    ["Quantity",              (d) => d.qty],
    ["Disposition",           (d) => d.disposition],
    ["Containment",           (d) => d.containment],
    ["Source",                (d) => d.source],
    ["Problem statement",     (d) => d.problem_statement],
    ["Root cause",            (d) => d.root_cause],
    ["Corrective action",     (d) => d.corrective_action],
    ["Effectiveness criterion", (d) => d.effectiveness_criterion],
    ["Description",           (d) => d.description],
    ["Scope",                 (d) => d.scope],
    ["Auditor",                (d) => d.auditor],
    ["Planned",               (d) => d.planned],
    ["Process",               (d) => d.process],
    ["Severity",              (d) => d.severity],
    ["Occurrence",            (d) => d.occurrence],
    ["Detection",             (d) => d.detection],
    ["Action",                (d) => d.action],
    ["Target SOP",            (d) => d.target_sop],
    ["PPAP level",            (d) => d.ppap_level],
    ["PSW status",            (d) => d.psw_status],
    ["Top program risks",     (d) => d.program_risk_summary],
    ["Lessons learned",       (d) => d.lessons_learned]
];

export async function renderRecordDetail(type, number) {
    /* APQP is not the generic key/value detail - it is built around its
       three deliverable documents and a phase gate (apqp.js). */
    if (type === "apqp") {
        const pdfButton = document.getElementById("apqp-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        const editButton = document.getElementById("apqp-edit");
        if (editButton) editButton.dataset.number = number;
        return renderApqpDetail(number);
    }

    /* A DI is built around its three investigation-form slots (di.js). */
    if (type === "di") {
        const pdfButton = document.getElementById("di-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        return renderDiDetail(number);
    }

    /* A FAIR renders its characteristic table with computed pass/fail
       (fair.js). */
    if (type === "fair") {
        const pdfButton = document.getElementById("fair-pdf");
        if (pdfButton) pdfButton.dataset.number = number;
        const editButton = document.getElementById("fair-edit");
        if (editButton) editButton.dataset.number = number;
        return renderFairDetail(number);
    }

    const panel = document.getElementById(type + "-detail");
    const heading = document.getElementById(type + "-detail-number");
    const statusSlot = document.getElementById(type + "-detail-status");

    if (!panel) return;

    panel.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const [{ record, links, history, transitions }, attachData, schemaDef] = await Promise.all([
            api.record(number),
            api.attachments(number),
            api.recordForm(type).catch(() => null)
        ]);
        const attachments = attachData.attachments;

        if (heading) heading.textContent = record.number;

        const pdfButton = document.getElementById(type + "-pdf");
        if (pdfButton) pdfButton.dataset.number = record.number;

        const editButton = document.getElementById(type + "-edit");
        if (editButton) editButton.dataset.number = record.number;

        /* Only apqp has a Documents panel in the markup today - this
           is written to key off that element's presence rather than
           the type, so any other record type that gets one later
           (an 8D's own, added below in change.js, or a future type)
           picks this up with no change here. */
        if (document.getElementById(type + "-documents-panel")) {
            renderDocumentsPanel(record.number, type + "-documents-panel");
        }

        if (statusSlot) {
            statusSlot.replaceChildren(
                pill(humanize(record.status), statusKind(record.status))
            );
        }

        const list = el("dl", { class: "kv" });

        /* due_at lives on the record itself, not in the type-specific
           data payload, so it is not one of DETAIL_FIELDS below - it
           gets its own row, always shown, with the same overdue rule
           the register colouring and the dashboard both use. */
        const isOverdue = !record.closed_at && record.due_at && new Date(record.due_at) < new Date();
        const changeDue = el("button", {
            class: "btn no-print", type: "button",
            style: "margin-left:8px;padding:1px 8px;font-size:11px"
        }, record.due_at ? "Change" : "Set");

        changeDue.addEventListener("click", () => {
            editDueDate({
                title: "Due date for " + record.number,
                currentValue: record.due_at,
                onSave: async (value) => {
                    await api.updateRecord(record.number, { due_at: value });

                    /* renderRegister re-selects its own first row, so
                       the just-edited record - not necessarily first -
                       has to be re-selected and re-rendered after it,
                       not before, or this screen would silently jump
                       back to whatever record happens to sort first. */
                    await renderRegister(type);
                    const tbody = document.getElementById(REGISTERS[type].tbody);
                    if (tbody) selectRow(tbody, record.number);
                    await renderRecordDetail(type, record.number);
                }
            });
        });

        list.append(el("dt", { text: "Due date" }));
        list.append(el("dd", {}, [
            record.due_at
                ? el("span", {
                    style: isOverdue ? "color:var(--crit)" : null,
                    text: formatDate(record.due_at) + (isOverdue ? " (overdue)" : "")
                  })
                : el("span", { class: "dim", text: "Not set" }),
            changeDue
        ]));

        const children = [list];

        /* The record's own fields. Driven by the published form schema
           so a field added in the Form Builder (or imported from a
           spreadsheet) shows here with no change to this screen. The
           known-good labels from DETAIL_FIELDS win where they apply;
           everything else falls back to the schema's own label. Fields
           are grouped by their `section`, and a `table` field renders
           as a read-only grid. */
        const schemaFields = (schemaDef && Array.isArray(schemaDef.fields)) ? schemaDef.fields : null;

        if (schemaFields) {
            /* Reverse the DETAIL_FIELDS reader functions into a
               key -> nice-label map, once, by probing each with a
               Proxy that records which data key it touches. */
            const keyLabels = {};
            for (const [label, read] of DETAIL_FIELDS) {
                const probe = new Proxy({}, {
                    get: (_t, prop) => { if (!keyLabels[prop]) keyLabels[prop] = label; }
                });
                try { read(probe); } catch { /* reader touched more than one key */ }
            }
            const labelFor = (field) => keyLabels[field.key] || field.label;

            /* Scalar fields collect into a shared key/value list; a
               section heading or a table flushes it and starts a new
               one, so the groups stay visually distinct. */
            let kv = null;
            let lastSection;
            const flushKv = () => { if (kv && kv.childElementCount) children.push(kv); kv = null; };

            for (const field of schemaFields) {
                const value = record.data ? record.data[field.key] : undefined;
                const hasValue = field.type === "table"
                    ? Array.isArray(value) && value.length > 0
                    : value !== undefined && value !== null && value !== "";
                if (!hasValue) continue;

                if ((field.section || null) !== (lastSection || null)) {
                    lastSection = field.section || null;
                    if (lastSection) {
                        flushKv();
                        children.push(el("div", { class: "section-label", text: lastSection }));
                    }
                }

                if (field.type === "table") {
                    flushKv();
                    const columns = Array.isArray(field.columns) ? field.columns : [];
                    children.push(el("div", { class: "sm", style: "font-weight:600;margin:6px 0 4px",
                        text: labelFor(field) }));
                    children.push(el("div", { class: "table-wrap" }, el("table", { class: "sm" }, [
                        el("thead", {}, el("tr", {}, columns.map((c) => el("th", { text: c.label })))),
                        el("tbody", {}, value.map((row) => el("tr", {},
                            columns.map((c) => {
                                const raw = row[c.key];
                                const td = el("td", { class: "sm", text: raw != null ? String(raw) : "-" });
                                if (c.type === "computed" && c.thresholds && raw != null) {
                                    const n = Number(raw);
                                    if (c.thresholds.crit != null && n >= c.thresholds.crit) td.classList.add("rpn-crit");
                                    else if (c.thresholds.warn != null && n >= c.thresholds.warn) td.classList.add("rpn-warn");
                                }
                                return td;
                            }))))
                    ])));
                } else {
                    if (!kv) kv = el("dl", { class: "kv" });
                    kv.append(el("dt", { text: labelFor(field) }), fieldValueDd(field, value));
                }
            }
            flushKv();
        } else {
            for (const [label, read] of DETAIL_FIELDS) {
                const value = read(record.data);
                if (value === undefined || value === null || value === "") continue;
                list.append(el("dt", { text: label }));
                list.append(fieldValueDd(null, value));
            }
        }

        /* Workflow. Every legal next step is shown, including the ones
           this person may not take, because "you cannot, the quality
           manager can" is more useful than a missing button. Buttons
           that only make sense on screen, not on paper. */
        if (transitions && transitions.length > 0) {
            children.push(el("div", { class: "section-label no-print", text: "Move this forward" }));

            children.push(el("div", { class: "row no-print" }, transitions.map((step) => {
                const button = el("button", {
                    class: "btn" + (step.allowed ? " btn-primary" : " not-permitted"),
                    type: "button",
                    title: step.blocked_because || "Move to " + step.label
                }, step.label);

                if (!step.allowed) {
                    button.disabled = true;
                    return button;
                }

                button.addEventListener("click", () => {
                    confirmStep({
                        title: "Move " + record.number + " to " + step.label,
                        body: step.is_terminal
                            ? "This closes the record. The audit trail is sealed and it cannot be reopened."
                            : "The record moves from " + humanize(record.status)
                              + " to " + step.label + ".",
                        confirmLabel: "Move to " + step.label,
                        onConfirm: async (reason) => {
                            await api.transition(record.number, { to: step.to, reason });
                            await renderRegister(type);
                        }
                    });
                });

                return button;
            })));

            const blocked = transitions.filter((step) => !step.allowed);
            if (blocked.length > 0) {
                children.push(el("p", {
                    class: "sm dim no-print",
                    style: "margin:8px 0 0",
                    text: blocked[0].blocked_because
                }));
            }
        }

        children.push(el("div", { class: "section-label", text: "Linked records" }));
        if (links.length > 0) {
            children.push(el("div", { class: "chip-list" },
                links.map((link) => el("span", { class: "linked-rec" }, [
                    recordLink(link),
                    el("button", {
                        class: "linked-rec-x no-print", type: "button",
                        title: "Unlink " + link.number, "aria-label": "Unlink " + link.number,
                        onClick: async () => {
                            try {
                                await api.unlinkRecord(record.number, link.number);
                                await renderRecordDetail(type, number);
                            } catch (error) { toast(error.message, "error"); }
                        }
                    }, "×")
                ]))
            ));
        } else {
            children.push(el("p", { class: "sm dim", style: "margin:0", text: "No linked records." }));
        }

        /* Link another record by its number. */
        const linkInput = el("input", { type: "text", class: "sm", placeholder: "e.g. CAPA-2026-0005" });
        const linkKind = el("select", { class: "sm" }, [
            "related", "caused_by", "corrects", "supersedes", "child_of"
        ].map((k) => el("option", { value: k, text: humanize(k) })));
        const linkBtn = el("button", { class: "btn no-print", type: "button" }, "Link");
        linkBtn.addEventListener("click", async () => {
            const to = linkInput.value.trim();
            if (!to) { toast("Enter a record number", "error"); return; }
            try {
                await api.linkRecord(record.number, { to, link_type: linkKind.value });
                await renderRecordDetail(type, number);
            } catch (error) { toast(error.message, "error"); }
        });
        children.push(el("div", {
            class: "row no-print", style: "gap:6px;margin:6px 0 4px;flex-wrap:wrap"
        }, [linkInput, linkKind, linkBtn]));

        /* An uploaded file is served straight back (openFileWindow); a
           link-only row points at a network share and just carries the
           path. A CAPA cannot close without at least one attachment;
           the disabled close button above already says so before this
           section is even reached. */
        children.push(el("div", { class: "section-label", text: "Attachments" }));

        if (attachments.length > 0) {
            children.push(el("div", { class: "chip-list" },
                attachments.map((a) => {
                    const meta = "  " + formatDate(a.uploaded_at)
                        + (a.uploaded_by ? "  " + a.uploaded_by : "");
                    if (a.has_file) {
                        return el("button", {
                            class: "chip chip-link no-print", type: "button",
                            title: "Open " + a.filename,
                            onClick: () => openFileWindow(
                                api.attachmentFileUrl(record.number, a.id), a.filename, a.mime_type)
                        }, a.filename + meta);
                    }
                    return el("span", {
                        class: "chip", title: a.storage_key || "",
                        text: a.filename + meta + "  (link)"
                    });
                })
            ));
        } else {
            children.push(el("p", { class: "sm dim", text: "No attachments yet." }));
        }

        /* Browse for a file - the common case. */
        const fileInput = el("input", { type: "file", class: "sm no-print" });
        const uploadButton = el("button", { class: "btn no-print", type: "button" }, "Upload");

        uploadButton.addEventListener("click", async () => {
            if (!fileInput.files || !fileInput.files[0]) {
                toast("Choose a file first", "error");
                return;
            }
            const form = new FormData();
            form.append("file", fileInput.files[0]);
            uploadButton.disabled = true;
            uploadButton.textContent = "Uploading...";
            try {
                await api.uploadAttachment(record.number, form);
                await renderRecordDetail(type, number);
            } catch (error) {
                toast(error.message, "error");
                uploadButton.disabled = false;
                uploadButton.textContent = "Upload";
            }
        });

        children.push(el("div", {
            class: "row no-print", style: "gap:6px;margin:4px 0 6px;flex-wrap:wrap"
        }, [fileInput, uploadButton]));

        /* Or point at a file kept on a network share. */
        const addFilename = el("input", { type: "text", placeholder: "Filename", class: "sm" });
        const addLocation = el("input", { type: "text", placeholder: "or a path / link on a share", class: "sm" });
        const addButton = el("button", { class: "btn no-print", type: "button" }, "Link");

        addButton.addEventListener("click", async () => {
            const filename = addFilename.value.trim();
            const location = addLocation.value.trim();

            if (!filename || !location) {
                toast("Filename and location are both required", "error");
                return;
            }

            try {
                await api.addAttachment(record.number, { filename, storage_key: location });
                await renderRecordDetail(type, number);
            } catch (error) {
                toast(error.message, "error");
            }
        });

        children.push(el("div", {
            class: "row no-print", style: "gap:6px;margin:0 0 12px;flex-wrap:wrap"
        }, [addFilename, addLocation, addButton]));

        if (history.length > 0) {
            children.push(el("div", { class: "section-label", text: "Audit trail" }));
            children.push(el("div", { class: "chip-list" },
                history.slice(0, 6).map((entry) => el("span", {
                    class: "chip",
                    text: formatDate(entry.changed_at) + "  " + entry.changed_by
                           + " set " + entry.field
                           + (entry.new_value ? " to " + entry.new_value : "")
                }))
            ));
        }

        /* An audit that turned up a discrepancy is worked through a
           Discrepancy Investigation - raised here, once, and shown
           here after. The DI is a child_of link on the audit. */
        if (type === "audit") {
            children.push(el("div", { class: "section-label", text: "Discrepancy Investigation" }));
            const existingDi = links.find((l) => l.type === "di");
            if (existingDi) {
                const open = el("button", { class: "link-btn", type: "button", text: existingDi.number });
                open.addEventListener("click", () => {
                    document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "di" } }));
                    renderDiDetail(existingDi.number);
                });
                children.push(el("p", { class: "sm" }, [
                    open,
                    document.createTextNode("  "),
                    pill(humanize(existingDi.status), statusKind(existingDi.status))
                ]));
            } else if (can("di.manage")) {
                const raise = el("button", {
                    class: "btn no-print", type: "button", dataset: { requires: "di.manage" },
                    text: "Raise Discrepancy Investigation"
                });
                raise.addEventListener("click", () => raiseDiFromAudit(record));
                children.push(raise);
            } else {
                children.push(el("p", { class: "sm dim", text: "No DI raised for this audit." }));
            }
        }

        panel.replaceChildren(...children);
    } catch (error) {
        panel.replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
        );
    }
}

/* Raise a DI from an audit finding: department + what the audit found,
   then land on the new DI. The DI is created and linked to the audit
   in one call (POST /api/di). */
function raiseDiFromAudit(audit) {
    openEntityForm({
        title: "Raise a Discrepancy Investigation",
        fields: [
            { key: "department", label: "Department under review", type: "text", required: true,
              value: audit.data?.scope || "" },
            { key: "finding", label: "What the audit found", type: "memo", required: true }
        ],
        submitLabel: "Raise DI",
        successMessage: "Discrepancy Investigation raised",
        onSubmit: ({ values }) => api.raiseDi({
            audit_number: audit.number,
            department: values.department,
            finding: values.finding
        }),
        onSaved: (di) => {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "di" } }));
            renderDiDetail(di.number);
        }
    });
}
