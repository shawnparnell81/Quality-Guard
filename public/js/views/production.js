/* ============================================================
   Production.

   The work order list, the traveller behind whichever one is
   selected, its first article, and any quality event raised against
   it. Holding and releasing happen here too, gated on the
   production.hold and production.release permissions.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { confirmStep } from "../forms.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize
} from "../dom.js";

const WO_STATUS = {
    running:      ["Running",      "done"],
    planned:      ["Planned",      "hold"],
    quality_hold: ["Quality hold", "open"],
    mrb_hold:     ["MRB hold",     "prog"],
    complete:     ["Complete",     "done"]
};

const OP_STATUS = {
    pass:    ["Pass",    "done"],
    fail:    ["Fail",    "open"],
    running: ["Running", "prog"],
    blocked: ["Blocked", "hold"],
    planned: ["Planned", "hold"]
};

let selected = null;

export async function renderProduction() {
    const tbody = document.getElementById("wo-table");
    loadingRow(tbody, 7);

    try {
        const { work_orders } = await api.workOrders();

        fillTable(tbody, work_orders, [
            { className: "nowrap", render: (row) => [
                severity(row.status === "quality_hold" ? "crit"
                       : row.status === "mrb_hold" ? "warn" : "ok"),
                recordId(row.wo_number)
            ] },
            { className: "mono sm nowrap", render: (row) => row.part_number || "-" },
            { className: "mono sm", render: (row) => row.lot_number || "-" },
            { className: "num", render: (row) => row.qty.toLocaleString() },

            /* Progress as done-of-total rather than a bar: on a shop
               floor the operation number is what people say out loud. */
            { className: "mono sm", render: (row) =>
                row.ops_total > 0
                    ? row.ops_done + " of " + row.ops_total
                    : (row.current_op || "-") + " of " + (row.total_ops || "-") },

            { className: "sm", render: (row) => row.cell || "-" },
            { render: (row) => {
                const [label, kind] = WO_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No work orders");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!work_orders[index]) return;
            tr.dataset.wo = work_orders[index].wo_number;
            tr.classList.add("row-clickable");
        });

        /* Keep whatever was open, otherwise lead with the one that
           needs attention. */
        const target = work_orders.some((w) => w.wo_number === selected)
            ? selected
            : (work_orders[0] && work_orders[0].wo_number);

        if (target) {
            selectRow(tbody, target);
            await renderWorkOrder(target);
        }
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

function selectRow(tbody, wo) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.wo === wo);
    });
}

async function renderWorkOrder(wo) {
    selected = wo;

    const heading = document.getElementById("wo-detail-number");
    const statusSlot = document.getElementById("wo-detail-status");
    const panel = document.getElementById("wo-detail");
    const travellerBody = document.getElementById("traveller-table");
    const faiPanel = document.getElementById("fai-panel");
    const faiBody = document.getElementById("fai-table");

    if (travellerBody) loadingRow(travellerBody, 4);

    try {
        const { work_order, traveller, first_article, quality_events } =
            await api.workOrder(wo);

        if (heading) heading.textContent = work_order.wo_number;

        if (statusSlot) {
            const [label, kind] = WO_STATUS[work_order.status] || ["Unknown", "hold"];
            statusSlot.replaceChildren(pill(label, kind));
        }

        /* ---- summary and actions ---- */
        const list = el("dl", { class: "kv" }, [
            el("dt", { text: "Part" }),
            el("dd", { class: "mono", text: (work_order.part_number || "-")
                + (work_order.revision ? " rev " + work_order.revision : "") }),
            el("dt", { text: "Description" }),
            el("dd", { text: work_order.part_description || "-" }),
            el("dt", { text: "Lot" }),
            el("dd", { class: "mono", text: work_order.lot_number || "-" }),
            el("dt", { text: "Heat" }),
            el("dd", { class: "mono", text: work_order.heat_number || "-" }),
            el("dt", { text: "Quantity" }),
            el("dd", { class: "mono", text: work_order.qty.toLocaleString() }),
            el("dt", { text: "Cell" }),
            el("dd", { text: work_order.cell || "-" })
        ]);

        const children = [list];

        if (work_order.hold_reason) {
            children.push(el("div", { class: "hold-note" }, [
                el("div", { class: "hold-head", text: "On hold" }),
                el("p", { class: "sm", style: "margin:4px 0 0", text: work_order.hold_reason }),
                el("p", { class: "sm dim", style: "margin:6px 0 0",
                    text: (work_order.held_by || "unknown")
                          + ", " + formatDate(work_order.held_at) })
            ]));
        }

        /* ---- quality events against this work order ---- */
        if (quality_events.length > 0) {
            children.push(el("div", { class: "section-label", text: "Quality events" }));
            children.push(el("div", { class: "chip-list" },
                quality_events.map((event) => el("span", {
                    class: "chip",
                    title: event.title,
                    text: event.number + "  " + humanize(event.status)
                }))
            ));
        }

        /* ---- hold and release ---- */
        const actions = [];
        const isComplete = work_order.status === "complete";
        const onHold = work_order.status === "quality_hold" || work_order.status === "mrb_hold";

        if (!isComplete && !onHold && can("production.hold")) {
            const button = el("button", { class: "btn", type: "button" }, "Place on hold");
            button.addEventListener("click", () => {
                confirmStep({
                    title: "Hold " + work_order.wo_number,
                    body: "Work stops at the current operation until somebody releases it.",
                    confirmLabel: "Place on hold",
                    onConfirm: async (reason) => {
                        if (!reason) throw new Error("A reason is required to hold a work order");
                        await api.holdWorkOrder(work_order.wo_number, { reason });
                        await renderProduction();
                    }
                });
            });
            actions.push(button);
        }

        if (onHold && can("production.release")) {
            const button = el("button", { class: "btn btn-primary", type: "button" }, "Release to floor");
            button.addEventListener("click", () => {
                confirmStep({
                    title: "Release " + work_order.wo_number,
                    body: "Work resumes. Any open nonconformance on this work order will "
                        + "block the release.",
                    confirmLabel: "Release",
                    onConfirm: async (reason) => {
                        try {
                            await api.releaseWorkOrder(work_order.wo_number, { reason });
                        } catch (error) {
                            const blocking = error.payload?.blocking;
                            throw new Error(blocking
                                ? error.message + ": " + blocking.join(", ")
                                : error.message);
                        }
                        await renderProduction();
                    }
                });
            });
            actions.push(button);
        }

        if (actions.length > 0) {
            children.push(el("div", { class: "section-label", text: "Actions" }));
            children.push(el("div", { class: "row" }, actions));
        }

        if (panel) panel.replaceChildren(...children);

        /* ---- traveller ---- */
        fillTable(travellerBody, traveller, [
            { className: "mono sm", render: (row) => row.op_number },
            { className: "sm", render: (row) => row.description },
            { className: "sm", render: (row) => row.operator || el("span", { class: "dim", text: "-" }) },
            { render: (row) => {
                const [label, kind] = OP_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No traveller recorded");

        /* ---- first article ---- */
        if (faiPanel) faiPanel.hidden = first_article.length === 0;

        if (first_article.length > 0) {
            fillTable(faiBody, first_article, [
                { className: "mono sm", render: (row) => row.characteristic_no },
                { className: "mono sm", render: (row) => row.specification },
                { className: "mono sm", render: (row) => row.actual || "-" },
                { className: "mono sm dim", render: (row) => row.gage_id || "-" },
                { render: (row) => row.result === "pass"
                    ? pill("Pass", "done")
                    : pill("Fail", "open") }
            ]);
        }
    } catch (error) {
        errorRow(travellerBody, 4, error);
    }
}

/* One delegated listener for the work order list. */
export function wireProduction() {
    const tbody = document.getElementById("wo-table");
    if (!tbody) return;

    tbody.addEventListener("click", (event) => {
        const row = event.target.closest("tr[data-wo]");
        if (!row) return;

        selectRow(tbody, row.dataset.wo);
        renderWorkOrder(row.dataset.wo);
    });
}
