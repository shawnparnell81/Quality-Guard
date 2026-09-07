/* ============================================================
   Customer Service logs.

   Three registers: purchase orders, work orders, purchase requests.
   Each is a table plus a "New" button that opens a short form
   (openEntityForm). The forms are deliberately minimal for now - a
   number, a party, a status, the dates that matter - and grow as the
   real forms are finessed. Work orders read the existing
   /api/work-orders; the other two have their own thin tables.
   ============================================================ */

import { api } from "../api.js";
import { openEntityForm } from "../entity-form.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, toast
} from "../dom.js";
import { applyPermissions } from "../session.js";

const money = (value, currency) => value == null
    ? "-"
    : (currency ? currency + " " : "") + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2 });

const STATUS_KIND = {
    // purchase orders
    draft: "hold", open: "prog", partially_received: "prog",
    received: "done", closed: "done", cancelled: "hold",
    // purchase requests
    submitted: "prog", approved: "done", rejected: "open", ordered: "done",
    // work orders
    planned: "hold", running: "prog", quality_hold: "open",
    mrb_hold: "open", complete: "done"
};

const statusPill = (status) => pill(humanize(status), STATUS_KIND[status] || "hold");

/* ============================================================
   Purchase orders
   ============================================================ */

const PO_FIELDS = [
    { key: "vendor",       label: "Vendor / supplier", type: "text", required: true,
      hint: "An AVL vendor name links the PO to that vendor; any other name is kept as text." },
    { key: "status",       label: "Status", type: "select",
      options: ["draft", "open", "partially_received", "received", "closed", "cancelled"] },
    { key: "order_date",   label: "Order date", type: "date" },
    { key: "need_by_date", label: "Need by", type: "date" },
    { key: "total_amount", label: "Total amount", type: "number", min: 0 },
    { key: "currency",     label: "Currency", type: "text", hint: "Default USD." },
    { key: "po_number",    label: "PO number", type: "text", hint: "Leave blank to auto-number PO-YYYY-NNNN." },
    { key: "notes",        label: "Notes", type: "memo" }
];

export async function renderPoLog() {
    const tbody = document.getElementById("po-log-table");
    const note = document.getElementById("po-log-note");
    loadingRow(tbody, 7);

    try {
        const { purchase_orders: rows } = await api.purchaseOrders();
        if (note) {
            const open = rows.filter((r) => r.status === "open" || r.status === "partially_received").length;
            note.textContent = rows.length + " logged / " + open + " open";
        }

        fillTable(tbody, rows, [
            { className: "mono sm nowrap", render: (r) => r.po_number },
            { className: "sm", render: (r) => r.vendor || "-" },
            { className: "mono sm", render: (r) => formatDate(r.order_date) },
            { className: "mono sm", render: (r) => formatDate(r.need_by_date) },
            { className: "num", render: (r) => money(r.total_amount, r.currency) },
            { className: "sm dim", render: (r) => r.buyer || "-" },
            { render: (r) => statusPill(r.status) }
        ], "No purchase orders logged yet");

        tbody.querySelectorAll("tr").forEach((tr, i) => {
            if (!rows[i]) return;
            tr.dataset.po = rows[i].po_number;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

function openPoForm(existing) {
    const editing = Boolean(existing);
    openEntityForm({
        title: editing ? "Edit " + existing.po_number : "New purchase order",
        fields: editing ? PO_FIELDS.filter((f) => f.key !== "po_number" && f.key !== "vendor") : PO_FIELDS,
        values: existing || { currency: "USD", status: "open" },
        submitLabel: editing ? "Save changes" : "Log purchase order",
        successMessage: (row) => row.po_number + (editing ? " updated" : " logged"),
        onSubmit: ({ values }) => editing
            ? api.updatePurchaseOrder(existing.po_number, values)
            : api.createPurchaseOrder(values),
        onSaved: () => renderPoLog()
    });
}

/* ============================================================
   Work orders
   ============================================================ */

const WO_FIELDS = [
    { key: "part_number", label: "Part number", type: "text" },
    { key: "lot_number",  label: "Lot number", type: "text" },
    { key: "qty",         label: "Quantity", type: "number", required: true, min: 1 },
    { key: "cell",        label: "Cell / work centre", type: "text" },
    { key: "current_op",  label: "Current op", type: "text" },
    { key: "total_ops",   label: "Total ops", type: "text" },
    { key: "status",      label: "Status", type: "select",
      options: ["planned", "running", "quality_hold", "mrb_hold", "complete"] },
    { key: "wo_number",   label: "WO number", type: "text", hint: "Leave blank to auto-number." }
];

export async function renderWoLog() {
    const tbody = document.getElementById("wo-log-table");
    const note = document.getElementById("wo-log-note");
    loadingRow(tbody, 7);

    try {
        const { work_orders: rows } = await api.workOrders();
        if (note) {
            const held = rows.filter((r) => r.status === "quality_hold" || r.status === "mrb_hold").length;
            note.textContent = rows.length + " work orders / " + held + " on hold";
        }

        fillTable(tbody, rows, [
            { className: "mono sm nowrap", render: (r) => r.wo_number },
            { className: "mono sm nowrap", render: (r) => r.part_number || "-" },
            { className: "mono sm", render: (r) => r.lot_number || "-" },
            { className: "num", render: (r) => r.qty != null ? r.qty.toLocaleString() : "-" },
            { className: "sm", render: (r) => r.cell || "-" },
            { className: "mono sm", render: (r) =>
                (r.ops_done != null ? r.ops_done + " / " + r.ops_total : "-") },
            { render: (r) => statusPill(r.status) }
        ], "No work orders yet");
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

function openWoForm() {
    openEntityForm({
        title: "New work order",
        fields: WO_FIELDS,
        values: { status: "planned" },
        submitLabel: "Log work order",
        successMessage: (row) => row.wo_number + " logged",
        onSubmit: ({ values }) => api.createWorkOrder(values),
        onSaved: () => renderWoLog()
    });
}

/* ============================================================
   Purchase requests
   ============================================================ */

const PR_FIELDS = [
    { key: "description",    label: "What is needed", type: "memo", required: true },
    { key: "department",     label: "Department", type: "text" },
    { key: "status",         label: "Status", type: "select",
      options: ["draft", "submitted", "approved", "rejected", "ordered", "closed"] },
    { key: "needed_by_date", label: "Needed by", type: "date" },
    { key: "estimated_cost", label: "Estimated cost", type: "number", min: 0 },
    { key: "po_number",      label: "PO raised", type: "text", hint: "Fill in once a PO covers this request." },
    { key: "pr_number",      label: "PR number", type: "text", hint: "Leave blank to auto-number PR-YYYY-NNNN." },
    { key: "notes",          label: "Notes", type: "memo" }
];

export async function renderPrLog() {
    const tbody = document.getElementById("pr-log-table");
    const note = document.getElementById("pr-log-note");
    loadingRow(tbody, 7);

    try {
        const { purchase_requests: rows } = await api.purchaseRequests();
        if (note) {
            const pending = rows.filter((r) => r.status === "submitted").length;
            note.textContent = rows.length + " requests / " + pending + " awaiting approval";
        }

        fillTable(tbody, rows, [
            { className: "mono sm nowrap", render: (r) => r.pr_number },
            { className: "sm", render: (r) => r.description || "-" },
            { className: "sm dim", render: (r) => r.department || "-" },
            { className: "sm dim", render: (r) => r.requested_by || "-" },
            { className: "mono sm", render: (r) => formatDate(r.needed_by_date) },
            { className: "mono sm", render: (r) => r.po_number || "-" },
            { render: (r) => statusPill(r.status) }
        ], "No purchase requests logged yet");

        tbody.querySelectorAll("tr").forEach((tr, i) => {
            if (!rows[i]) return;
            tr.dataset.pr = rows[i].pr_number;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

function openPrForm(existing) {
    const editing = Boolean(existing);
    openEntityForm({
        title: editing ? "Edit " + existing.pr_number : "New purchase request",
        fields: editing ? PR_FIELDS.filter((f) => f.key !== "pr_number") : PR_FIELDS,
        values: existing || { status: "submitted" },
        submitLabel: editing ? "Save changes" : "Log request",
        successMessage: (row) => row.pr_number + (editing ? " updated" : " logged"),
        onSubmit: ({ values }) => editing
            ? api.updatePurchaseRequest(existing.pr_number, values)
            : api.createPurchaseRequest(values),
        onSaved: () => renderPrLog()
    });
}

/* ============================================================
   Wiring
   ============================================================ */

export function wireLogs() {
    const poNew = document.getElementById("po-log-new");
    if (poNew) poNew.addEventListener("click", () => openPoForm());

    const woNew = document.getElementById("wo-log-new");
    if (woNew) woNew.addEventListener("click", () => openWoForm());

    const prNew = document.getElementById("pr-log-new");
    if (prNew) prNew.addEventListener("click", () => openPrForm());

    const poTable = document.getElementById("po-log-table");
    if (poTable) {
        poTable.addEventListener("click", async (event) => {
            const row = event.target.closest("tr[data-po]");
            if (!row) return;
            try {
                const { purchase_order, can_edit } = await api.purchaseOrder(row.dataset.po);
                if (!can_edit) { toast("View only - you cannot edit purchase orders", "error"); return; }
                openPoForm(purchase_order);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    }

    const prTable = document.getElementById("pr-log-table");
    if (prTable) {
        prTable.addEventListener("click", async (event) => {
            const row = event.target.closest("tr[data-pr]");
            if (!row) return;
            try {
                const { purchase_request, can_edit } = await api.purchaseRequest(row.dataset.pr);
                if (!can_edit) { toast("View only - you cannot edit purchase requests", "error"); return; }
                openPrForm(purchase_request);
            } catch (error) {
                toast(error.message, "error");
            }
        });
    }

    /* Hide the New buttons for anyone without the permission. */
    applyPermissions(document.getElementById("view-po-log"));
    applyPermissions(document.getElementById("view-wo-log"));
    applyPermissions(document.getElementById("view-pr-log"));
}
