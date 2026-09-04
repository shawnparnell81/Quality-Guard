/* ============================================================
   Calibration, training, documents, vendors and material.

   These read from the typed master-data tables rather than the
   records table, so each one gets its own small renderer.
   ============================================================ */

import { api } from "../api.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize
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

                    if (!entry) return el("td", { class: "dim", text: "-" });
                    if (entry.ok) current++;

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

export async function renderDocuments() {
    const tbody = document.getElementById("documents-table");
    loadingRow(tbody, 6);

    try {
        const { documents } = await api.documents();

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
        ]);
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

/* ---------- vendors ---------- */

const VENDOR_STATUS = {
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

    try {
        const [genealogy, onHold] = await Promise.all([
            api.genealogy("L-88213"),
            api.lots({ on_hold: "true" })
        ]);

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

        fillTable(holds, onHold.lots, [
            { className: "mono sm", render: (row) => row.lot_number },
            { className: "sm", render: (row) => row.location || "-" },
            { className: "num", render: (row) => row.qty.toLocaleString() },
            { render: (row) => pill(humanize(row.status), "open") }
        ], "Nothing on hold");

    } catch (error) {
        if (tree) {
            tree.replaceChildren(
                el("div", { class: "sm", style: "color:var(--crit)", text: error.message })
            );
        }
        errorRow(holds, 4, error);
    }
}
