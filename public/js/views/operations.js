/* ============================================================
   Receiving inspection and shipping.

   Clause 8.4.2 on the way in, clause 8.6 on the way out. Both screens
   are a register on the left and the checks behind one row on the
   right, because that is the shape of the decision in both cases.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { confirmStep } from "../forms.js";
import {
    el, pill, severity, recordId, fillTable, loadingRow, errorRow,
    formatDate, humanize
} from "../dom.js";

/* ============================================================
   Receiving
   ============================================================ */

const RECEIPT_STATUS = {
    pending: ["Awaiting inspection", "prog"],
    accept:  ["Accepted",            "done"],
    reject:  ["Rejected",            "open"]
};

let selectedReceipt = null;

export async function renderReceiving() {
    const tbody = document.getElementById("receipt-table");
    loadingRow(tbody, 7);

    try {
        const { receipts } = await api.receipts();

        fillTable(tbody, receipts, [
            { className: "nowrap", render: (row) => [
                severity(row.status === "reject" ? "crit"
                       : row.status === "pending" ? "warn" : "ok"),
                recordId(row.receipt_number)
            ] },
            { className: "mono sm", render: (row) => row.po_number || "-" },
            { className: "sm", render: (row) => row.vendor || "-" },
            { className: "mono sm nowrap", render: (row) => row.part_number || "-" },
            { className: "num", render: (row) => row.qty_received.toLocaleString() },
            { className: "mono sm", render: (row) => row.sample_plan || "-" },
            { render: (row) => {
                const [label, kind] = RECEIPT_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "Nothing received");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!receipts[index]) return;
            tr.dataset.receipt = receipts[index].receipt_number;
            tr.classList.add("row-clickable");
        });

        const target = receipts.some((r) => r.receipt_number === selectedReceipt)
            ? selectedReceipt
            : (receipts[0] && receipts[0].receipt_number);

        if (target) {
            mark(tbody, "receipt", target);
            await renderReceipt(target);
        }
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

async function renderReceipt(number) {
    selectedReceipt = number;

    const heading = document.getElementById("receipt-number");
    const panel = document.getElementById("receipt-detail");
    const measureBody = document.getElementById("measurement-table");

    if (measureBody) loadingRow(measureBody, 5);

    try {
        const { receipt, measurements, can_disposition } = await api.receipt(number);

        if (heading) heading.textContent = receipt.receipt_number;

        const children = [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Vendor" }),
                el("dd", { text: (receipt.vendor || "-")
                    + (receipt.vendor_grade ? "  grade " + receipt.vendor_grade : "") }),
                el("dt", { text: "Purchase order" }),
                el("dd", { class: "mono", text: receipt.po_number || "-" }),
                el("dt", { text: "Part" }),
                el("dd", { class: "mono", text: receipt.part_number || "-" }),
                el("dt", { text: "Quantity" }),
                el("dd", { class: "mono", text: receipt.qty_received.toLocaleString() }),
                el("dt", { text: "Sampling" }),
                el("dd", { class: "mono", text: receipt.sample_plan || "-" }),
                el("dt", { text: "Received" }),
                el("dd", { class: "mono", text: formatDate(receipt.received_at) })
            ])
        ];

        if (receipt.notes) {
            children.push(el("p", { class: "sm", style: "margin:12px 0 0", text: receipt.notes }));
        }

        /* Grade drives the sampling plan, and saying so on the screen
           saves somebody looking up why this lot got 100 percent. */
        if (receipt.vendor_grade === "D") {
            children.push(el("p", {
                class: "sm dim", style: "margin:10px 0 0",
                text: "Grade D vendors are inspected 100 percent until five consecutive "
                    + "lots are accepted."
            }));
        }

        if (receipt.status === "pending" && can_disposition) {
            children.push(el("div", { class: "section-label", text: "Disposition" }));

            const accept = el("button", { class: "btn btn-primary", type: "button" }, "Accept");
            const reject = el("button", { class: "btn", type: "button" }, "Reject");

            for (const [button, isAccept] of [[accept, true], [reject, false]]) {
                button.addEventListener("click", () => {
                    confirmStep({
                        title: (isAccept ? "Accept " : "Reject ") + receipt.receipt_number,
                        body: isAccept
                            ? "The material is released to stores."
                            : "The material is quarantined and a nonconformance should follow.",
                        confirmLabel: isAccept ? "Accept" : "Reject",
                        onConfirm: async (notes) => {
                            await api.dispositionReceipt(number, { accept: isAccept, notes });
                            await renderReceiving();
                        }
                    });
                });
            }

            children.push(el("div", { class: "row" }, [accept, reject]));
        } else if (receipt.inspected_by) {
            children.push(el("p", {
                class: "sm dim", style: "margin:12px 0 0",
                text: humanize(receipt.status) + " by " + receipt.inspected_by
                      + ", " + formatDate(receipt.inspected_at)
            }));
        }

        if (panel) panel.replaceChildren(...children);

        fillTable(measureBody, measurements, [
            { className: "sm", render: (row) => row.characteristic },
            { className: "mono sm", render: (row) => row.specification || "-" },
            { className: "mono sm", render: (row) => row.actual || "-" },
            { className: "mono sm dim", render: (row) => row.gage_id || "-" },
            { render: (row) => row.result === "pass" ? pill("Pass", "done") : pill("Fail", "open") }
        ], "No measurements recorded");
    } catch (error) {
        errorRow(measureBody, 5, error);
    }
}

/* ============================================================
   Shipping
   ============================================================ */

const SHIP_STATUS = {
    preparing:        ["Preparing",        "hold"],
    awaiting_release: ["Awaiting release", "prog"],
    shipped:          ["Shipped",          "done"],
    blocked:          ["Blocked",          "open"]
};

let selectedShipment = null;

export async function renderShipping() {
    const tbody = document.getElementById("shipment-table");
    loadingRow(tbody, 7);

    try {
        const { shipments } = await api.shipments();

        fillTable(tbody, shipments, [
            { className: "nowrap", render: (row) => [
                severity(row.status === "blocked" ? "crit"
                       : row.status === "awaiting_release" ? "warn" : "ok"),
                recordId(row.shipment_number)
            ] },
            { className: "sm", render: (row) => row.customer },
            { className: "mono sm nowrap", render: (row) => row.part_number || "-" },
            { className: "mono sm", render: (row) => row.lot_number || "-" },
            { className: "num", render: (row) => row.qty.toLocaleString() },
            { className: "mono sm", render: (row) =>
                row.checks_passed + " of " + row.checks_total },
            { render: (row) => {
                const [label, kind] = SHIP_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "Nothing to ship");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!shipments[index]) return;
            tr.dataset.shipment = shipments[index].shipment_number;
            tr.classList.add("row-clickable");
        });

        const target = shipments.some((s) => s.shipment_number === selectedShipment)
            ? selectedShipment
            : (shipments[0] && shipments[0].shipment_number);

        if (target) {
            mark(tbody, "shipment", target);
            await renderShipment(target);
        }
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

async function renderShipment(number) {
    selectedShipment = number;

    const heading = document.getElementById("shipment-number");
    const note = document.getElementById("shipment-note");
    const checkBody = document.getElementById("check-table");
    const panel = document.getElementById("shipment-detail");

    if (checkBody) loadingRow(checkBody, 4);

    try {
        const { shipment, checks, outstanding, can_release } = await api.shipment(number);

        if (heading) heading.textContent = shipment.shipment_number;
        if (note) {
            note.textContent = outstanding === 0
                ? "All checks passed"
                : outstanding + " check(s) outstanding";
        }

        const releasable = can_release && shipment.status !== "shipped";

        fillTable(checkBody, checks, [
            { className: "sm", render: (row) => row.description },
            { className: "mono sm dim", render: (row) => row.evidence || "-" },
            { render: (row) => {
                if (row.status === "pass") return pill("Pass", "done");
                if (row.status === "fail") return pill("Fail", "open");
                return pill("Pending", "prog");
            } },
            { render: (row) => {
                if (row.status === "pass" || !can("shipping.release")
                    || shipment.status === "shipped") {
                    return "";
                }

                const button = el("button", { class: "btn", type: "button" }, "Mark passed");
                button.addEventListener("click", () => {
                    confirmStep({
                        title: row.description,
                        body: "Records this check as complete against your name.",
                        confirmLabel: "Mark passed",
                        onConfirm: async (evidence) => {
                            await api.passShipmentCheck(number, row.position, { evidence });
                            await renderShipment(number);
                        }
                    });
                });
                return button;
            } }
        ], "No checks defined");

        const children = [
            el("dl", { class: "kv" }, [
                el("dt", { text: "Customer" }),
                el("dd", { text: shipment.customer }),
                el("dt", { text: "Part" }),
                el("dd", { class: "mono", text: shipment.part_number || "-" }),
                el("dt", { text: "Lot" }),
                el("dd", { class: "mono", text: shipment.lot_number || "-" }),
                el("dt", { text: "Heat" }),
                el("dd", { class: "mono", text: shipment.heat_number || "-" }),
                el("dt", { text: "Quantity" }),
                el("dd", { class: "mono", text: shipment.qty.toLocaleString() }),
                el("dt", { text: "Carrier" }),
                el("dd", { text: shipment.carrier || "-" }),
                el("dt", { text: "Ship date" }),
                el("dd", { class: "mono", text: formatDate(shipment.ship_date) })
            ])
        ];

        if (shipment.released_by) {
            children.push(el("p", {
                class: "sm dim", style: "margin:12px 0 0",
                text: "Released by " + shipment.released_by + ", " + formatDate(shipment.released_at)
            }));
        } else if (releasable) {
            const button = el("button", { class: "btn btn-primary", type: "button" }, "Authorise release");
            button.addEventListener("click", () => {
                confirmStep({
                    title: "Release " + shipment.shipment_number,
                    body: "Every planned verification is complete. This authorises the "
                        + "product to leave, under your name.",
                    confirmLabel: "Authorise release",
                    onConfirm: async (reason) => {
                        await api.releaseShipment(number, { reason });
                        await renderShipping();
                    }
                });
            });
            children.push(el("div", { class: "section-label", text: "Release" }));
            children.push(el("div", { class: "row" }, button));
        } else if (outstanding > 0) {
            children.push(el("div", { class: "section-label", text: "Release" }));
            children.push(el("p", {
                class: "sm dim", style: "margin:0",
                text: "Cannot release until every check passes. Clause 8.6."
            }));
        }

        if (panel) panel.replaceChildren(...children);
    } catch (error) {
        errorRow(checkBody, 4, error);
    }
}

/* ---------- shared ---------- */

function mark(tbody, key, value) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset[key] === value);
    });
}

export function wireOperations() {
    const receipts = document.getElementById("receipt-table");
    if (receipts) {
        receipts.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-receipt]");
            if (!row) return;
            mark(receipts, "receipt", row.dataset.receipt);
            renderReceipt(row.dataset.receipt);
        });
    }

    const shipments = document.getElementById("shipment-table");
    if (shipments) {
        shipments.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-shipment]");
            if (!row) return;
            mark(shipments, "shipment", row.dataset.shipment);
            renderShipment(row.dataset.shipment);
        });
    }
}
