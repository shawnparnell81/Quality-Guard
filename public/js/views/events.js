/* ============================================================
   Quality event registers.

   NCR, CAPA, complaint, audit and risk all render through the same
   function, because on the server they are all rows in the records
   table. Only the column list differs, so only the column list is
   written out per module.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { openRecordForm, confirmStep } from "../forms.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize, statusKind
} from "../dom.js";

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
    }
};

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

export async function renderRegister(type) {
    const config = REGISTERS[type];
    if (!config) return;

    const tbody = document.getElementById(config.tbody);
    loadingRow(tbody, config.columns.length);

    try {
        const { records } = await api.records({ type });
        fillTable(tbody, records, config.columns, "No records of this type yet");

        /* Tag each row with its record number so one delegated listener
           can work out what was clicked. fillTable emits rows in the
           order it was given them, so index lines up with the data. */
        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!records[index]) return;
            tr.dataset.number = records[index].number;
            tr.classList.add("row-clickable");
        });

        /* The NCR screen also shows one record in full. */
        if (type === "ncr" && records.length > 0) {
            selectRow(tbody, records[0].number);
            await renderRecordDetail(records[0].number);
        }
    } catch (error) {
        errorRow(tbody, config.columns.length, error);
    }
}

function selectRow(tbody, number) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.number === number);
    });
}

/* One listener for the whole register, attached once when this module
   loads. Rows are replaced on every fetch, so a listener per row would
   have to be rebuilt each time; this one never is. */
export function wireRegisterClicks() {
    const tbody = document.getElementById("ncr-register");

    if (tbody) {
        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-number]");
            if (!row) return;

            selectRow(tbody, row.dataset.number);
            renderRecordDetail(row.dataset.number);
        });
    }

    /* Every "raise a record" button on every screen, through one
       listener. The button says which type it opens. */
    document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-new-record]");
        if (!button || button.disabled) return;

        const type = button.dataset.newRecord;

        openRecordForm(type, {
            onSaved: async (created) => {
                await renderRegister(type === "complaint" ? "complaint" : type);

                /* Land on the thing that was just created rather than
                   leaving somebody to hunt for it in the register. */
                if (type === "ncr") {
                    const register = document.getElementById("ncr-register");
                    if (register) selectRow(register, created.number);
                    await renderRecordDetail(created.number);
                }
            }
        });
    });
}

/* ---------- detail panel ---------- */

const DETAIL_FIELDS = [
    ["Part",           (d) => d.part_number],
    ["Lot / serial",   (d) => d.lot_number],
    ["Work order",     (d) => d.work_order],
    ["Operation",      (d) => d.operation],
    ["Characteristic", (d) => d.characteristic],
    ["Measured",       (d) => d.measured],
    ["Gage",           (d) => d.gage_id],
    ["Detected at",    (d) => d.detected_at],
    ["Qty affected",   (d) => d.qty_affected],
    ["Disposition",    (d) => d.disposition],
    ["Containment",    (d) => d.containment]
];

export async function renderRecordDetail(number) {
    const panel = document.getElementById("ncr-detail");
    const heading = document.getElementById("ncr-detail-number");
    const statusSlot = document.getElementById("ncr-detail-status");

    if (!panel) return;

    panel.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { record, links, history, transitions } = await api.record(number);

        if (heading) heading.textContent = record.number;
        if (statusSlot) {
            statusSlot.replaceChildren(
                pill(humanize(record.status), statusKind(record.status))
            );
        }

        const list = el("dl", { class: "kv" });

        for (const [label, read] of DETAIL_FIELDS) {
            const value = read(record.data);
            if (value === undefined || value === null || value === "") continue;

            list.append(el("dt", { text: label }));
            list.append(el("dd", {
                class: label === "Measured" ? "mono" : null,
                style: label === "Measured" ? "color:var(--crit)" : null,
                text: String(value)
            }));
        }

        const children = [list];

        /* Workflow. Every legal next step is shown, including the ones
           this person may not take, because "you cannot, the quality
           manager can" is more useful than a missing button. */
        if (transitions && transitions.length > 0) {
            children.push(el("div", { class: "section-label", text: "Move this forward" }));

            children.push(el("div", { class: "row" }, transitions.map((step) => {
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
                            await renderRegister("ncr");
                        }
                    });
                });

                return button;
            })));

            const blocked = transitions.filter((step) => !step.allowed);
            if (blocked.length > 0) {
                children.push(el("p", {
                    class: "sm dim",
                    style: "margin:8px 0 0",
                    text: blocked[0].blocked_because
                }));
            }
        }

        if (links.length > 0) {
            children.push(el("div", { class: "section-label", text: "Linked records" }));
            children.push(el("div", { class: "chip-list" },
                links.map((link) => el("span", {
                    class: "chip",
                    text: link.number + "  " + link.link_type.replace(/_/g, " ")
                }))
            ));
        }

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

        panel.replaceChildren(...children);
    } catch (error) {
        panel.replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
        );
    }
}
