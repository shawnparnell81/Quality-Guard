/* ============================================================
   Customer Service logs: purchase orders, work orders, purchase
   requests.

   Each screen is a register on the left and a detail panel on the
   right, the same shape as Receiving Inspection. Open a row to see
   every field; while the record is in an open status and you hold
   the log permission the fields are editable and Save writes a
   PATCH. "New" opens the same form blank.

   Work orders are the existing work_orders row - the one Production
   Control uses - not a copy. Purchase orders and requests have their
   own thin tables (migrations 030, plus 032 for work_orders.data).
   ============================================================ */

import { api } from "../api.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, toast
} from "../dom.js";

const money = (value, currency) => value == null || value === ""
    ? "-"
    : (currency ? currency + " " : "")
      + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2 });

const STATUS_KIND = {
    draft: "hold", open: "prog", partially_received: "prog",
    received: "done", closed: "done", cancelled: "hold",
    submitted: "prog", approved: "done", rejected: "open", ordered: "done",
    planned: "hold", running: "prog", quality_hold: "open",
    mrb_hold: "open", complete: "done"
};
const statusPill = (status) => pill(humanize(status), STATUS_KIND[status] || "hold");

/* ============================================================
   Field kit - one labelled control, editable or static, keyed by
   where its value lives: a top-level column, or a key inside `data`.
   ============================================================ */

function fieldGroup(label, control, span) {
    return el("div", { class: "field-group" + (span ? " span-2" : "") },
        [el("label", { text: label }), control]);
}

function staticGroup(label, text, span) {
    const has = text !== "" && text !== null && text !== undefined;
    return el("div", { class: "field-group" + (span ? " span-2" : "") }, [
        el("label", { text: label }),
        el("div", { class: "static-value" + (has ? "" : " empty"), text: has ? String(text) : "—" })
    ]);
}

/* spec: { key, label, type, options?, span?, inData?, readonly? }
   readers get [key, value, inData]. */
function makeField(spec, editable, values) {
    const raw = spec.inData
        ? ((values.data || {})[spec.key])
        : values[spec.key];
    const current = raw === undefined || raw === null ? "" : raw;

    if (!editable || spec.readonly) {
        const shown = spec.type === "date" && current ? formatDate(current)
            : spec.type === "select" ? humanize(String(current))
            : current;
        return { node: staticGroup(spec.label, current === "" ? "" : shown, spec.span), read: () => null };
    }

    let input;
    if (spec.type === "memo") {
        input = el("textarea", { rows: 2 });
        if (current !== "") input.value = String(current);
    } else if (spec.type === "select") {
        input = el("select", {}, [
            el("option", { value: "", text: "—" }),
            ...spec.options.map((o) => el("option", { value: o, text: humanize(o) }))
        ]);
        input.value = String(current);
    } else {
        input = el("input", { type: spec.type === "number" ? "number" : spec.type === "date" ? "date" : "text" });
        if (current !== "") input.value = spec.type === "date" ? String(current).slice(0, 10) : String(current);
    }

    return {
        node: fieldGroup(spec.label, input, spec.span || spec.type === "memo"),
        read: () => {
            const v = input.value.trim();
            if (v === "") return [spec.key, null, spec.inData];
            return [spec.key, spec.type === "number" ? Number(v) : v, spec.inData];
        }
    };
}

function collect(readers) {
    const top = {};
    const data = {};
    for (const read of readers) {
        const r = read();
        if (!r) continue;
        const [key, value, inData] = r;
        if (inData) data[key] = value;
        else top[key] = value;
    }
    if (Object.keys(data).length) top.data = data;
    return top;
}

/* ============================================================
   Per-log configuration
   ============================================================ */

const PO_DETAIL = [
    { key: "vendor",        label: "Vendor / supplier", type: "text", readonly: true },
    { key: "status",        label: "Status", type: "select",
      options: ["draft", "open", "partially_received", "received", "closed", "cancelled"] },
    { key: "order_date",    label: "Order date", type: "date" },
    { key: "need_by_date",  label: "Need by", type: "date" },
    { key: "total_amount",  label: "Total amount", type: "number" },
    { key: "currency",      label: "Currency", type: "text" },
    { key: "ship_to",       label: "Ship to", type: "text", inData: true, span: true },
    { key: "payment_terms", label: "Payment terms", type: "text", inData: true },
    { key: "buyer_contact", label: "Buyer contact", type: "text", inData: true },
    { key: "notes",         label: "Notes", type: "memo" }
];

const PR_DETAIL = [
    { key: "description",    label: "What is needed", type: "memo" },
    { key: "department",     label: "Department", type: "text" },
    { key: "status",         label: "Status", type: "select",
      options: ["draft", "submitted", "approved", "rejected", "ordered", "closed"] },
    { key: "needed_by_date", label: "Needed by", type: "date" },
    { key: "estimated_cost", label: "Estimated cost", type: "number" },
    { key: "justification",  label: "Justification", type: "memo", inData: true },
    { key: "budget_code",    label: "Budget code", type: "text", inData: true },
    { key: "po_number",      label: "PO raised", type: "text" }
];

const WO_DETAIL = [
    { key: "customer",    label: "Customer", type: "text", inData: true },
    { key: "customer_po", label: "Customer PO", type: "text", inData: true },
    { key: "part_number", label: "Part number", type: "text" },
    { key: "lot_number",  label: "Lot number", type: "text" },
    { key: "qty",         label: "Quantity", type: "number" },
    { key: "due_date",    label: "Due date", type: "date", inData: true },
    { key: "priority",    label: "Priority", type: "select",
      options: ["normal", "high", "rush"], inData: true },
    { key: "cell",        label: "Cell / work centre", type: "text" },
    { key: "current_op",  label: "Current op", type: "text" },
    { key: "total_ops",   label: "Total ops", type: "text" },
    { key: "status",      label: "Status", type: "select",
      options: ["planned", "running", "quality_hold", "mrb_hold", "complete"] },
    { key: "notes",       label: "Notes", type: "memo", inData: true }
];

/* New-record forms drop the readonly identifier/vendor and add the
   fields only set at creation. */
const PO_CREATE = [
    { key: "vendor", label: "Vendor / supplier", type: "text" },
    ...PO_DETAIL.filter((f) => f.key !== "vendor")
];
const PR_CREATE = PR_DETAIL.filter((f) => f.key !== "po_number");
const WO_CREATE = WO_DETAIL;

const LOGS = {
    po: {
        title: "purchase order", numberKey: "po_number",
        detailFields: PO_DETAIL, createFields: PO_CREATE,
        detailEl: "po-detail", headEl: "po-detail-number", tableEl: "po-log-table",
        rowAttr: "po", refresh: renderPoLog,
        fetch: (n) => api.purchaseOrder(n).then((r) => ({ record: r.purchase_order, can_edit: r.can_edit })),
        create: api.createPurchaseOrder, update: api.updatePurchaseOrder,
        isOpen: (s) => !["closed", "cancelled"].includes(s),
        placeholder: "Select a purchase order"
    },
    pr: {
        title: "purchase request", numberKey: "pr_number",
        detailFields: PR_DETAIL, createFields: PR_CREATE,
        detailEl: "pr-detail", headEl: "pr-detail-number", tableEl: "pr-log-table",
        rowAttr: "pr", refresh: renderPrLog,
        fetch: (n) => api.purchaseRequest(n).then((r) => ({ record: r.purchase_request, can_edit: r.can_edit })),
        create: api.createPurchaseRequest, update: api.updatePurchaseRequest,
        isOpen: (s) => !["closed", "rejected"].includes(s),
        placeholder: "Select a request"
    },
    wo: {
        title: "work order", numberKey: "wo_number",
        detailFields: WO_DETAIL, createFields: WO_CREATE,
        detailEl: "wo-detail", headEl: "wo-detail-number", tableEl: "wo-log-table",
        rowAttr: "wo", refresh: renderWoLog,
        fetch: (n) => api.workOrder(n).then((r) => ({
            record: r.work_order, can_edit: r.can_edit, extra: r
        })),
        create: api.createWorkOrder, update: api.updateWorkOrder,
        isOpen: (s) => s !== "complete",
        placeholder: "Select a work order"
    }
};

const selected = { po: null, pr: null, wo: null };

function mark(tableEl, attr, value) {
    tableEl.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset[attr] === value);
    });
}

/* ============================================================
   Detail panel
   ============================================================ */

async function renderLogDetail(kind, number) {
    const cfg = LOGS[kind];
    const panel = document.getElementById(cfg.detailEl);
    const head = document.getElementById(cfg.headEl);
    if (!panel) return;

    selected[kind] = number;
    panel.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    /* create mode */
    if (!number) {
        if (head) head.textContent = "New " + cfg.title;
        renderForm(kind, panel, {}, true, true);
        return;
    }

    try {
        const { record, can_edit, extra } = await cfg.fetch(number);
        if (head) head.textContent = record[cfg.numberKey];
        const editable = Boolean(can_edit) && cfg.isOpen(record.status);
        renderForm(kind, panel, record, editable, false, extra);
    } catch (error) {
        panel.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
    }
}

function renderForm(kind, panel, record, editable, creating, extra) {
    const cfg = LOGS[kind];
    const specs = creating ? cfg.createFields : cfg.detailFields;
    const readers = [];
    const grid = el("div", { class: "field-grid" });

    for (const spec of specs) {
        const f = makeField(spec, editable, record);
        readers.push(f.read);
        grid.append(f.node);
    }

    const children = [];

    if (!creating) {
        children.push(el("div", { class: "row", style: "gap:6px;margin-bottom:10px" },
            [statusPill(record.status)]));
    }

    children.push(el("section", { class: "form-section" }, [
        el("h3", { text: creating ? "Details" : cfg.title.replace(/^\w/, (c) => c.toUpperCase()) }),
        grid
    ]));

    if (editable || creating) {
        const btn = el("button", { class: "btn btn-primary no-print", type: "button" },
            creating ? "Create " + cfg.title : "Save changes");
        btn.addEventListener("click", async () => {
            const payload = collect(readers);
            btn.disabled = true;
            btn.textContent = "Saving...";
            try {
                const number = creating
                    ? (await cfg.create(payload))[cfg.numberKey]
                    : record[cfg.numberKey];
                if (!creating) await cfg.update(number, payload);
                selected[kind] = number;
                toast(number + (creating ? " created" : " updated"));
                await cfg.refresh();
                await renderLogDetail(kind, number);
                mark(document.getElementById(cfg.tableEl), cfg.rowAttr, number);
            } catch (error) {
                toast(error.message, "error");
                btn.disabled = false;
                btn.textContent = creating ? "Create " + cfg.title : "Save changes";
            }
        });
        children.push(el("div", { class: "row", style: "margin:4px 0" }, btn));
    } else if (!creating) {
        children.push(el("p", { class: "sm dim", style: "margin:4px 0",
            text: cfg.isOpen(record.status)
                ? "View only – you do not hold the permission to edit this."
                : "This " + cfg.title + " is " + humanize(record.status) + " and can no longer be edited." }));
    }

    /* Work order: the floor detail, read-only, plus a jump. */
    if (kind === "wo" && extra) {
        children.push(el("div", { class: "section-label", text: "On the floor" }));
        children.push(el("p", { class: "sm", style: "margin:0 0 8px" }, [
            (extra.traveller || []).length + " traveller ops, "
            + (extra.first_article || []).length + " first-article characteristics, "
            + (extra.quality_events || []).length + " quality events. ",
            el("button", {
                class: "btn sm no-print", type: "button", text: "Open on Production Control",
                onClick: () => document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "production" } }))
            })
        ]));
        if (extra.work_order && extra.work_order.hold_reason) {
            children.push(el("p", { class: "sm", style: "color:var(--crit);margin:0",
                text: "On hold: " + extra.work_order.hold_reason }));
        }
    }

    panel.replaceChildren(...children);
}

/* ============================================================
   Registers
   ============================================================ */

function wireRows(tableEl, rows, attr, onPick) {
    tableEl.querySelectorAll("tr").forEach((tr, i) => {
        if (!rows[i]) return;
        tr.dataset[attr] = rows[i][attr === "wo" ? "wo_number" : attr === "po" ? "po_number" : "pr_number"];
        tr.classList.add("row-clickable");
    });
}

export async function renderPoLog() {
    const tbody = document.getElementById("po-log-table");
    const note = document.getElementById("po-log-note");
    loadingRow(tbody, 6);
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
            { render: (r) => statusPill(r.status) }
        ], "No purchase orders logged yet");
        wireRows(tbody, rows, "po");
        await settleSelection("po", tbody, rows.map((r) => r.po_number));
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

export async function renderWoLog() {
    const tbody = document.getElementById("wo-log-table");
    const note = document.getElementById("wo-log-note");
    loadingRow(tbody, 6);
    try {
        const { work_orders: rows } = await api.workOrders();
        if (note) {
            const held = rows.filter((r) => r.status === "quality_hold" || r.status === "mrb_hold").length;
            note.textContent = rows.length + " work orders / " + held + " on hold";
        }
        fillTable(tbody, rows, [
            { className: "mono sm nowrap", render: (r) => r.wo_number },
            { className: "mono sm nowrap", render: (r) => r.part_number || "-" },
            { className: "sm", render: (r) => (r.data && r.data.customer) || "-" },
            { className: "num", render: (r) => r.qty != null ? r.qty.toLocaleString() : "-" },
            { className: "sm", render: (r) => r.cell || "-" },
            { render: (r) => statusPill(r.status) }
        ], "No work orders yet");
        wireRows(tbody, rows, "wo");
        await settleSelection("wo", tbody, rows.map((r) => r.wo_number));
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

export async function renderPrLog() {
    const tbody = document.getElementById("pr-log-table");
    const note = document.getElementById("pr-log-note");
    loadingRow(tbody, 6);
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
            { className: "mono sm", render: (r) => formatDate(r.needed_by_date) },
            { className: "mono sm", render: (r) => r.po_number || "-" },
            { render: (r) => statusPill(r.status) }
        ], "No purchase requests logged yet");
        wireRows(tbody, rows, "pr");
        await settleSelection("pr", tbody, rows.map((r) => r.pr_number));
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

/* After a register renders: keep the current selection if it still
   exists, otherwise open the first row, otherwise leave the detail
   panel on its placeholder. */
async function settleSelection(kind, tbody, numbers) {
    const target = selected[kind] && numbers.includes(selected[kind])
        ? selected[kind]
        : numbers[0];
    if (!target) {
        selected[kind] = null;
        const head = document.getElementById(LOGS[kind].headEl);
        const panel = document.getElementById(LOGS[kind].detailEl);
        if (head) head.textContent = LOGS[kind].placeholder;
        if (panel) panel.replaceChildren(el("p", { class: "sm dim", text: "Nothing logged yet." }));
        return;
    }
    mark(tbody, LOGS[kind].rowAttr, target);
    if (target !== selected[kind] || !document.getElementById(LOGS[kind].detailEl).hasChildNodes()) {
        await renderLogDetail(kind, target);
    }
}

/* ============================================================
   Wiring
   ============================================================ */

export function wireLogs() {
    for (const kind of ["po", "wo", "pr"]) {
        const cfg = LOGS[kind];

        const newBtn = document.getElementById(kind + "-log-new");
        if (newBtn) newBtn.addEventListener("click", () => {
            selected[kind] = null;
            mark(document.getElementById(cfg.tableEl), cfg.rowAttr, " ");
            renderLogDetail(kind, null);
        });

        const table = document.getElementById(cfg.tableEl);
        if (table) table.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-" + cfg.rowAttr + "]");
            if (!row) return;
            mark(table, cfg.rowAttr, row.dataset[cfg.rowAttr]);
            renderLogDetail(kind, row.dataset[cfg.rowAttr]);
        });
    }
}
