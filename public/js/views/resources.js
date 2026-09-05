/* ============================================================
   Calibration, training, documents, vendors and material.

   These read from the typed master-data tables rather than the
   records table, so each one gets its own small renderer.
   ============================================================ */

import { api } from "../api.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, printElement
} from "../dom.js";

/* ---------- calibration ---------- */

const CAL_STATUS = {
    past_due: ["Past due", "open"],
    due_soon: ["Due soon", "prog"],
    current:  ["Current",  "done"]
};

export async function renderCalibration() {
    const tbody = document.getElementById("calibration-table");
    loadingRow(tbody, 7);

    try {
        const { gages } = await api.gages();

        fillTable(tbody, gages, [
            { className: "mono sm", render: (row) => row.gage_id },
            { render: (row) => row.description },
            { className: "mono sm", render: (row) => row.range_text || "-" },
            { className: "mono sm", render: (row) => row.interval_months + " mo" },
            { className: "mono sm", render: (row) => formatDate(row.last_cal) },
            { className: "mono sm", render: (row) => formatDate(row.next_due) },
            { render: (row) => {
                const [label, kind] = CAL_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ]);
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

/* ---------- training ----------
   The matrix is built from whatever documents come back, so adding a
   controlled document to the requirements adds a column here without
   any change to this file. */

export async function renderTraining() {
    const table = document.getElementById("training-matrix-table");
    const gapsBody = document.getElementById("training-gaps-table");

    if (gapsBody) loadingRow(gapsBody, 4);

    try {
        const [{ matrix }, { gaps }] = await Promise.all([
            api.trainingMatrix(),
            api.trainingGaps()
        ]);

        if (table) {
            const docNumbers = [...new Set(
                matrix.flatMap((row) => Object.keys(row.documents))
            )].sort();

            const head = el("tr", {}, [
                el("th", { text: "Operator" }),
                el("th", { text: "Role" }),
                ...docNumbers.map((doc) => el("th", { text: doc })),
                el("th", { text: "Documents current" })
            ]);

            const body = matrix.map((row) => {
                let current = 0;

                const cells = docNumbers.map((doc) => {
                    const entry = row.documents[doc];

                    /* Not in the object at all means this document is not
                       required for this person's role. Present with no
                       trained_revision means it IS required and nobody
                       has ever recorded training against it, which is a
                       gap in its own right and distinct from a stale one. */
                    if (!entry) return el("td", { class: "dim", text: "-" });
                    if (entry.ok) current++;

                    if (entry.trained_revision === null) {
                        return el("td", {}, pill("Never trained", "open"));
                    }

                    return el("td", {}, entry.ok
                        ? pill("rev " + entry.trained_revision, "done")
                        : pill("rev " + entry.trained_revision + " stale", "open"));
                });

                return el("tr", {}, [
                    el("td", { text: row.operator }),
                    el("td", { class: "sm dim", text: humanize(row.role) }),
                    ...cells,
                    el("td", { class: "num", text: current + " / " + docNumbers.length })
                ]);
            });

            table.replaceChildren(
                el("thead", {}, head),
                el("tbody", {}, body)
            );
        }

        fillTable(gapsBody, gaps, [
            { render: (row) => row.operator },
            { className: "sm dim", render: (row) => humanize(row.role) },
            { className: "mono sm", render: (row) => row.doc_number + " rev " + row.current_revision },
            { render: (row) => row.gap_type === "never_trained"
                ? pill("Never trained", "open")
                : pill("Superseded rev", "prog") }
        ], "No training gaps");

    } catch (error) {
        errorRow(gapsBody, 4, error);
    }
}

/* ---------- documents ---------- */

const DOC_STATUS = {
    released:    ["Released",    "done"],
    in_approval: ["In approval", "prog"],
    draft:       ["Draft",       "hold"],
    obsolete:    ["Obsolete",    "hold"]
};

let selectedDocument = null;
let documentsCache = [];

export async function renderDocuments() {
    const tbody = document.getElementById("documents-table");
    loadingRow(tbody, 6);

    try {
        const { documents } = await api.documents();
        documentsCache = documents;

        fillTable(tbody, documents, [
            { className: "mono sm", render: (row) => row.doc_number },
            { render: (row) => row.title },
            { className: "mono sm", render: (row) => row.current_revision || "-" },
            { render: (row) => row.owner || "-" },
            { className: "num", render: (row) => row.revision_count },
            { render: (row) => {
                const [label, kind] = DOC_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No documents");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            const row = documents[index];
            if (!row) return;
            tr.dataset.doc = row.doc_number;
            tr.classList.add("row-clickable");
        });

        const target = documents.some((d) => d.doc_number === selectedDocument)
            ? selectedDocument
            : (documents[0] && documents[0].doc_number);

        if (target) {
            markDocument(tbody, target);
            await renderDocumentDetail(target);
        } else {
            clearDocumentDetail();
        }
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

function markDocument(tbody, docNumber) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.doc === docNumber);
    });
}

function clearDocumentDetail() {
    const heading = document.getElementById("document-detail-number");
    const statusSlot = document.getElementById("document-detail-status");
    const summary = document.getElementById("document-summary");
    const revisions = document.getElementById("document-revisions");

    if (heading) heading.textContent = "Select a document";
    if (statusSlot) statusSlot.replaceChildren();
    if (summary) summary.replaceChildren();
    if (revisions) revisions.replaceChildren();
}

/* Revision history, real this time. The summary card and the table
   below it both come from the document actually clicked, not a
   single example frozen in the markup regardless of what you pick. */
async function renderDocumentDetail(docNumber) {
    selectedDocument = docNumber;

    const heading = document.getElementById("document-detail-number");
    const statusSlot = document.getElementById("document-detail-status");
    const summary = document.getElementById("document-summary");
    const revisionsBody = document.getElementById("document-revisions");

    if (revisionsBody) loadingRow(revisionsBody, 5);

    const doc = documentsCache.find((d) => d.doc_number === docNumber);

    if (heading) heading.textContent = docNumber;

    if (statusSlot && doc) {
        const [label, kind] = DOC_STATUS[doc.status] || ["Unknown", "hold"];
        statusSlot.replaceChildren(pill(label, kind));
    }

    if (summary && doc) {
        summary.replaceChildren(el("dl", { class: "kv" }, [
            el("dt", { text: "Title" }),
            el("dd", { text: doc.title }),
            el("dt", { text: "Owner" }),
            el("dd", { text: doc.owner || "-" }),
            el("dt", { text: "Current revision" }),
            el("dd", { class: "mono", text: doc.current_revision || "-" })
        ]));
    }

    try {
        const { revisions } = await api.revisions(docNumber);

        fillTable(revisionsBody, revisions, [
            { className: "mono sm", render: (row) => row.revision },
            { className: "sm", render: (row) => row.change_summary },
            { className: "sm", render: (row) => row.author || "-" },
            { className: "sm dim", render: (row) => row.approved_by || "pending" },
            { className: "mono sm", render: (row) =>
                row.effective_date ? formatDate(row.effective_date) : "-" }
        ], "No revision history recorded");
    } catch (error) {
        errorRow(revisionsBody, 5, error);
    }
}

export function wireDocuments() {
    const tbody = document.getElementById("documents-table");
    if (tbody) {
        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-doc]");
            if (!row) return;
            markDocument(tbody, row.dataset.doc);
            renderDocumentDetail(row.dataset.doc);
        });
    }

    const printButton = document.getElementById("document-print");
    if (printButton) {
        printButton.addEventListener("click", () => {
            printElement(document.getElementById("document-detail-panel"));
        });
    }
}

/* ---------- vendors ---------- */

export const VENDOR_STATUS = {
    approved:   ["Approved",    "done"],
    on_watch:   ["On watch",    "prog"],
    scar_open:  ["SCAR issued", "open"],
    onboarding: ["Onboarding",  "hold"],
    suspended:  ["Suspended",   "open"]
};

export async function renderVendors() {
    const tbody = document.getElementById("vendors-table");
    loadingRow(tbody, 7);

    try {
        const { vendors } = await api.vendors();

        fillTable(tbody, vendors, [
            { render: (row) => row.name },
            { className: "sm", render: (row) => row.scope },
            { className: "mono sm", render: (row) => row.cert_type || "-" },
            { className: "mono sm", render: (row) => formatDate(row.cert_expires) },
            { className: "num", render: (row) => row.otd_pct != null ? row.otd_pct + "%" : "-" },
            { className: "num", render: (row) => row.ppm != null ? row.ppm.toLocaleString() : "-" },
            { render: (row) => {
                const [label, kind] = VENDOR_STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ]);
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

/* ---------- warehouse: genealogy and holds ----------
   The tree is drawn from the depth the server returns, so a deeper
   chain of splits and merges needs no change here. */

export async function renderWarehouse() {
    const tree = document.getElementById("genealogy-tree");
    const holds = document.getElementById("holds-table");

    if (holds) loadingRow(holds, 4);
    if (tree) tree.replaceChildren(el("div", { class: "sm dim", text: "Loading..." }));

    /* Fetched separately, not with Promise.all: the genealogy tree and
       the holds table are unrelated data, and a problem tracing one lot
       should never blank a table that loaded fine. */
    const onHold = await api.lots({ on_hold: "true" }).catch((error) => {
        errorRow(holds, 4, error);
        return null;
    });

    if (onHold) {
        fillTable(holds, onHold.lots, [
            { className: "mono sm", render: (row) => row.lot_number },
            { className: "sm", render: (row) => row.location || "-" },
            { className: "num", render: (row) => row.qty.toLocaleString() },
            { render: (row) => pill(humanize(row.status), "open") }
        ], "Nothing on hold");
    }

    /* There is no lot picker on this screen yet, so there is no single
       lot to always trace. Leading with whatever is on hold shows the
       one someone is actually likely to need traced right now, rather
       than a lot number that only exists in the demo data. */
    const targetLot = onHold?.lots?.[0]?.lot_number;

    if (!targetLot) {
        if (tree) {
            tree.replaceChildren(el("div", { class: "sm dim", text: "Nothing on hold to trace." }));
        }
        return;
    }

    try {
        const genealogy = await api.genealogy(targetLot);

        if (tree) {
            tree.replaceChildren(...genealogy.tree.map((node) => {
                const rail = "   ".repeat(node.depth) + (node.depth === 0 ? "+-" : "+-");
                const flagged = node.status === "on_hold" || node.status === "quarantine";

                return el("div", { class: "tree-node" + (flagged ? " flagged" : "") }, [
                    el("span", { class: "tree-rail", text: rail }),
                    el("span", { class: "tree-label", text: node.lot_number }),
                    el("span", { class: "tree-meta", text: [
                        node.part_number || node.heat_number,
                        node.qty ? node.qty.toLocaleString() + " pc" : null,
                        node.location,
                        node.linked_records > 0 ? node.linked_records + " linked records" : null
                    ].filter(Boolean).join(", ") })
                ]);
            }));
        }
    } catch (error) {
        if (tree) {
            tree.replaceChildren(
                el("div", { class: "sm", style: "color:var(--crit)", text: error.message })
            );
        }
    }
}
