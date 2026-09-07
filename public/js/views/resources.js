/* ============================================================
   Calibration, training, documents, vendors and material.

   These read from the typed master-data tables rather than the
   records table, so each one gets its own small renderer.
   ============================================================ */

import { api } from "../api.js";
import { can, applyPermissions } from "../session.js";
import { ensureDialog } from "../forms.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow } from "../doc-windows.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, printElement, toast
} from "../dom.js";

/* ---------- calibration ---------- */

const CAL_STATUS = {
    past_due: ["Past due", "open"],
    due_soon: ["Due soon", "prog"],
    current:  ["Current",  "done"]
};

/* The one declarative bit. Everything else about the gage form -
   layout, validation, the modal - is openEntityForm's job. gage_id is
   dropped from the field list when editing (the ID is the key and
   shows in the title instead). */
const GAGE_FIELDS = [
    { key: "gage_id",        label: "Gage ID",                     type: "text",   required: true },
    { key: "description",    label: "Description",                  type: "text",   required: true },
    { key: "manufacturer",   label: "Manufacturer",                type: "text" },
    { key: "model",          label: "Model",                       type: "text" },
    { key: "serial_number",  label: "Serial number",               type: "text" },
    { key: "location",       label: "Location",                    type: "text" },
    { key: "range_text",     label: "Range",                       type: "text",   hint: "e.g. 0-6 in" },
    { key: "interval_months", label: "Calibration interval (months)", type: "number", required: true, min: 1 },
    { key: "cal_supplier",   label: "Calibration supplier",        type: "text" },
    { key: "last_cal",       label: "Last calibrated",             type: "date" },
    { key: "next_due",       label: "Next due",                    type: "date",
      hint: "Leave blank to compute from the last-cal date and interval." }
];

const CAL_FIELDS = [
    { key: "result",       label: "Result", type: "select", required: true, options: ["pass", "fail"],
      hint: "A fail puts the gage on hold until a later result passes." },
    { key: "performed_on", label: "Calibration date", type: "date" },
    { key: "cal_supplier", label: "Calibration supplier", type: "text" },
    { key: "standard_used", label: "Standard used", type: "text",
      hint: "The reference standard or master this was checked against." },
    { key: "as_found",     label: "As found", type: "text" },
    { key: "as_left",      label: "As left", type: "text" },
    { key: "reading",      label: "Reading", type: "text", hint: "What the instrument actually measured." },
    { key: "notes",        label: "Notes", type: "memo" },
    { key: "certificate",  label: "Certificate (PDF)", type: "file", accept: "application/pdf" }
];

/* Kept from the last render so the row Edit button has the full gage
   to seed its form without another fetch. */
let gagesByIdCache = new Map();

export async function renderCalibration() {
    const tbody = document.getElementById("calibration-table");
    const note = document.getElementById("calibration-note");
    loadingRow(tbody, 9);

    try {
        const { gages } = await api.gages();
        gagesByIdCache = new Map(gages.map((g) => [g.gage_id, g]));

        if (note) {
            const pastDue = gages.filter((g) => g.status === "past_due").length;
            const dueSoon = gages.filter((g) => g.status === "due_soon").length;
            note.textContent = pastDue + " past due / " + dueSoon + " due in 30 d";
        }

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
            } },
            /* Separate from the due-date status above on purpose - a
               gage can be well within its calibration interval and
               still be on hold because the last result was a fail.
               Neither fact can stand in for the other. */
            { render: (row) => {
                if (row.availability === "retired") return pill("Retired", "hold");
                return row.availability === "hold"
                    ? pill("On hold", "open")
                    : pill("Available", "done");
            } },
            { render: (row) => el("div", { class: "row-actions" }, [
                el("button", {
                    class: "btn btn-xs", type: "button", text: "Edit",
                    dataset: { requires: "gage.edit", gageEdit: row.gage_id }
                }),
                el("button", {
                    class: "btn btn-xs", type: "button", text: "Record",
                    dataset: { requires: "gage.calibrate", gage: row.gage_id }
                })
            ]) }
        ], "No gages tracked yet");

        applyPermissions(tbody);
    } catch (error) {
        errorRow(tbody, 9, error);
    }
}

/* ---------- add / edit a gage ---------- */

function openGageForm(existing) {
    const editing = Boolean(existing);

    openEntityForm({
        title: editing ? "Edit gage " + existing.gage_id : "New gage",
        fields: editing ? GAGE_FIELDS.filter((f) => f.key !== "gage_id") : GAGE_FIELDS,
        values: existing || {},
        submitLabel: editing ? "Save changes" : "Add gage",
        successMessage: (row) => row.gage_id + (editing ? " updated" : " added"),
        onSubmit: ({ values }) => editing
            ? api.updateGage(existing.gage_id, values)
            : api.createGage(values),
        onSaved: () => renderCalibration()
    });
}

/* ---------- recording a calibration result ---------- */

function openCalibrationForm(gageId) {
    openEntityForm({
        title: "Record calibration - " + gageId,
        fields: CAL_FIELDS,
        values: { result: "pass" },
        submitLabel: "Save result",
        successMessage: (row) => gageId
            + (row.availability === "hold" ? " on hold - failed calibration" : " calibration recorded"),
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            for (const [key, value] of Object.entries(values)) form.append(key, value);
            if (files.certificate) form.append("certificate", files.certificate);
            return api.recordCalibration(gageId, form);
        },
        onSaved: () => renderCalibration()
    });
}

export function wireCalibration() {
    const tbody = document.getElementById("calibration-table");
    if (!tbody) return;

    const newButton = document.getElementById("gage-new");
    if (newButton) {
        newButton.addEventListener("click", () => openGageForm(null));
    }

    tbody.addEventListener("click", (event) => {
        const editButton = event.target.closest("button[data-gage-edit]");
        if (editButton && !editButton.disabled) {
            openGageForm(gagesByIdCache.get(editButton.dataset.gageEdit) || { gage_id: editButton.dataset.gageEdit });
            return;
        }

        const recordButton = event.target.closest("button[data-gage]");
        if (recordButton && !recordButton.disabled) {
            openCalibrationForm(recordButton.dataset.gage);
        }
    });
}

/* ---------- training ----------
   The matrix and gaps list are computed by the server from
   document_requirements + training_records. The records themselves are
   now writable: "Record training" covers a whole session (one
   document, one date, one sign-off sheet, one or many people), and any
   matrix cell / gaps row / records row that has a record behind it
   opens it. */

/* Populated on each render so the forms and the record modal have the
   people and documents to choose from without a second fetch. */
let trainingPeople = [];   // [{ value: initials, label }]
let trainingDocs = [];     // [doc_number]

export async function renderTraining() {
    const table = document.getElementById("training-matrix-table");
    const gapsBody = document.getElementById("training-gaps-table");
    const recordsBody = document.getElementById("training-records-table");

    if (gapsBody) loadingRow(gapsBody, 4);
    if (recordsBody) loadingRow(recordsBody, 6);

    try {
        const [{ matrix }, { gaps }, { records }] = await Promise.all([
            api.trainingMatrix(),
            api.trainingGaps(),
            api.training()
        ]);

        trainingPeople = matrix
            .map((row) => ({ value: row.operator_initials, label: row.operator }))
            .sort((a, b) => a.label.localeCompare(b.label));
        trainingDocs = [...new Set(matrix.flatMap((row) => Object.keys(row.documents)))].sort();

        if (table) {
            const head = el("tr", {}, [
                el("th", { text: "Operator" }),
                el("th", { text: "Role" }),
                ...trainingDocs.map((doc) => el("th", { text: doc })),
                el("th", { text: "Documents current" })
            ]);

            const body = matrix.map((row) => {
                let current = 0;

                const cells = trainingDocs.map((doc) => {
                    const entry = row.documents[doc];

                    /* Absent means the document is not required for this
                       person's role. Present with a null trained_revision
                       means it IS required and no training has ever been
                       recorded - a gap of its own kind. */
                    if (!entry) return el("td", { class: "dim", text: "-" });
                    if (entry.ok) current++;

                    const cell = entry.trained_revision === null
                        ? el("td", {}, pill("Never trained", "open"))
                        : el("td", {}, entry.ok
                            ? pill("rev " + entry.trained_revision, "done")
                            : pill("rev " + entry.trained_revision + " stale", "open"));

                    if (entry.training_record_id) {
                        cell.classList.add("row-clickable");
                        cell.dataset.trainingId = entry.training_record_id;
                    }
                    return cell;
                });

                return el("tr", {}, [
                    el("td", { text: row.operator }),
                    el("td", { class: "sm dim", text: humanize(row.role) }),
                    ...cells,
                    el("td", { class: "num", text: current + " / " + trainingDocs.length })
                ]);
            });

            table.replaceChildren(el("thead", {}, head), el("tbody", {}, body));
        }

        if (recordsBody) {
            fillTable(recordsBody, records, [
                { render: (row) => row.user_name },
                { className: "mono sm", render: (row) => row.doc_number },
                { className: "mono sm", render: (row) => "rev " + row.revision_trained
                    + (row.is_current ? "" : " (superseded)") },
                { className: "sm", render: (row) => formatDate(row.trained_on) },
                { className: "sm", render: (row) => row.next_review ? formatDate(row.next_review) : "-" },
                { className: "sm dim", render: (row) => row.trained_by_name || "-" }
            ], "No training recorded yet");

            recordsBody.querySelectorAll("tr").forEach((tr, index) => {
                if (!records[index]) return;
                tr.dataset.trainingId = records[index].id;
                tr.classList.add("row-clickable");
            });
        }

        fillTable(gapsBody, gaps, [
            { render: (row) => row.operator },
            { className: "sm dim", render: (row) => humanize(row.role) },
            { className: "mono sm", render: (row) => row.doc_number + " rev " + row.current_revision },
            { render: (row) => row.gap_type === "never_trained"
                ? pill("Never trained", "open")
                : pill("Superseded rev", "prog") }
        ], "No training gaps");

        gapsBody.querySelectorAll("tr").forEach((tr, index) => {
            const gap = gaps[index];
            if (gap && gap.training_record_id) {
                tr.dataset.trainingId = gap.training_record_id;
                tr.classList.add("row-clickable");
            }
        });
    } catch (error) {
        if (gapsBody) errorRow(gapsBody, 4, error);
        if (recordsBody) errorRow(recordsBody, 6, error);
    }
}

/* One form for a whole session: pick the document, revision and date,
   tick everyone who attended, attach the sign-off sheet once. Ticking
   a single person is the "one person" case. */
function openRecordTrainingForm() {
    openEntityForm({
        title: "Record training",
        fields: [
            { key: "document", label: "Document", type: "select", required: true, options: trainingDocs },
            { key: "revision_trained", label: "Revision trained", type: "text", required: true,
              hint: "The revision they were trained on - usually the current released one." },
            { key: "trained_on", label: "Date", type: "date", required: true },
            { key: "next_review", label: "Next review", type: "date" },
            { key: "people", label: "People trained", type: "checklist", required: true,
              options: trainingPeople },
            { key: "notes", label: "Notes", type: "memo" },
            { key: "evidence", label: "Sign-off sheet / certificate", type: "file",
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv" }
        ],
        values: { trained_on: new Date().toISOString().slice(0, 10) },
        submitLabel: "Record",
        successMessage: (result) => "Training recorded for " + result.count
            + (result.count === 1 ? " person" : " people"),
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            form.append("document", values.document);
            form.append("revision_trained", values.revision_trained);
            form.append("trained_on", values.trained_on);
            if (values.next_review) form.append("next_review", values.next_review);
            if (values.notes) form.append("notes", values.notes);
            form.append("users", JSON.stringify(values.people || []));
            if (files.evidence) form.append("evidence", files.evidence);
            return api.recordTraining(form);
        },
        onSaved: () => renderTraining()
    });
}

function openTrainingEditForm(record) {
    openEntityForm({
        title: "Edit training - " + record.user_name + " / " + record.doc_number,
        fields: [
            { key: "revision_trained", label: "Revision trained", type: "text", required: true },
            { key: "trained_on", label: "Date", type: "date", required: true },
            { key: "next_review", label: "Next review", type: "date" },
            { key: "notes", label: "Notes", type: "memo" },
            { key: "evidence", label: "Replace sign-off sheet", type: "file",
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv",
              hint: record.has_evidence ? "Leave blank to keep the current file." : undefined }
        ],
        values: {
            revision_trained: record.revision_trained,
            trained_on: record.trained_on ? String(record.trained_on).slice(0, 10) : "",
            next_review: record.next_review ? String(record.next_review).slice(0, 10) : "",
            notes: record.notes || ""
        },
        submitLabel: "Save changes",
        successMessage: "Training record updated",
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            form.append("revision_trained", values.revision_trained);
            form.append("trained_on", values.trained_on);
            form.append("next_review", values.next_review || "");
            form.append("notes", values.notes || "");
            if (files.evidence) form.append("evidence", files.evidence);
            return api.updateTraining(record.id, form);
        },
        onSaved: () => renderTraining()
    });
}

async function openTrainingRecord(id) {
    const node = ensureDialog();
    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Training record" })),
        el("div", { class: "modal-body" }, el("p", { class: "sm dim", text: "Loading..." }))
    );
    node.showModal();

    try {
        const record = await api.trainingRecord(id);

        const rows = [
            ["Person", record.user_name + " (" + record.user_initials + ")"],
            ["Document", record.doc_number + " - " + record.doc_title],
            ["Revision trained", record.revision_trained
                + (record.revision_trained === record.current_revision ? " (current)" : " (superseded by " + record.current_revision + ")")],
            ["Trained on", formatDate(record.trained_on)],
            ["Next review", record.next_review ? formatDate(record.next_review) : "-"],
            ["Recorded by", record.trained_by_name || "-"],
            ["Notes", record.notes || "-"]
        ];

        const evidence = record.has_evidence
            ? el("a", { class: "btn btn-xs", href: api.trainingEvidenceUrl(id), target: "_blank",
                text: "Open evidence" + (record.evidence_filename ? " - " + record.evidence_filename : "") })
            : el("span", { class: "sm dim", text: "No evidence attached" });

        const editButton = el("button", { class: "btn btn-primary", type: "button",
            dataset: { requires: "training.record" }, text: "Edit" });
        editButton.addEventListener("click", () => { node.close(); openTrainingEditForm(record); });

        node.replaceChildren(
            el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Training record" })),
            el("div", { class: "modal-body" }, [
                el("dl", { class: "kv" }, rows.flatMap(([k, v]) => [
                    el("dt", { text: k }), el("dd", { text: v })
                ])),
                el("div", { class: "row", style: "margin-top:12px", }, evidence)
            ]),
            el("div", { class: "modal-foot" }, [
                el("button", { class: "btn", type: "button", text: "Close", onClick: () => node.close() }),
                editButton
            ])
        );
        applyPermissions(node);
    } catch (error) {
        node.querySelector(".modal-body").replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
        );
    }
}

export function wireTraining() {
    const recordButton = document.getElementById("training-record");
    if (recordButton) recordButton.addEventListener("click", openRecordTrainingForm);

    for (const id of ["training-matrix-table", "training-records-table", "training-gaps-table"]) {
        const container = document.getElementById(id);
        if (!container) continue;
        container.addEventListener("click", (event) => {
            const hit = event.target.closest("[data-training-id]");
            if (hit) openTrainingRecord(hit.dataset.trainingId);
        });
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
                row.effective_date ? formatDate(row.effective_date) : "-" },
            { className: "nowrap", render: (row) => revisionActions(docNumber, row) }
        ], "No revision history recorded");

        applyPermissions(revisionsBody);
    } catch (error) {
        errorRow(revisionsBody, 6, error);
    }
}

/* View - opens a real, trackable window for this revision
   (doc-windows.js): a PDF or image shows right there, anything else
   (Excel, Word) opens for real in its own application, same as
   Download always did, but now something you can see is still open
   rather than a link that fires once and leaves no trace. Release,
   shown only on a revision still waiting (no approved_by yet) and
   only to someone who can actually do it. Uploading a revision was
   deliberately never enough to make it current (see the upload
   endpoint's own comment); this is where that finishes. */
function revisionActions(docNumber, row) {
    const nodes = [];

    if (row.has_file) {
        const view = el("button", { class: "btn btn-xs no-print", type: "button", text: "View" });
        view.addEventListener("click", () => {
            openDocumentWindow(docNumber, row.revision, docNumber + " rev " + row.revision);
        });
        nodes.push(view);
    }

    if (!row.approved_by) {
        const release = el("button", {
            class: "btn btn-xs no-print", type: "button",
            "data-requires": "document.release", text: "Release"
        });
        release.addEventListener("click", async () => {
            release.disabled = true;
            try {
                await api.releaseDocumentRevision(docNumber, row.revision);
                toast("Revision " + row.revision + " released");
                await renderDocuments();
            } catch (error) {
                toast(error.message, "error");
                release.disabled = false;
            }
        });
        nodes.push(release);
    }

    return nodes;
}

/* ---------- uploading (a real file, every time) ---------- */

function openUploadDocumentDialog(defaultRecord, onSaved) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const docNumberInput = el("input", { type: "text", id: "doc-number", placeholder: "e.g. FMEA-2210-C" });
    const titleInput = el("input", { type: "text", id: "doc-title" });
    const summaryInput = el("input", { type: "text", id: "doc-summary", value: "Initial upload" });
    const recordInput = el("input", {
        type: "text", id: "doc-record", value: defaultRecord || "",
        readonly: defaultRecord ? "readonly" : undefined
    });
    const fileInput = el("input", { type: "file", id: "doc-file" });

    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload");

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "Attach a document" })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [
                el("label", { for: "doc-number", text: "Document number" }), docNumberInput
            ]),
            el("div", { class: "field-group" }, [
                el("label", { for: "doc-title", text: "Title" }), titleInput
            ]),
            el("div", { class: "field-group" }, [
                el("label", { for: "doc-summary", text: "Change summary" }), summaryInput
            ]),
            el("div", { class: "field-group" }, [
                el("label", { for: "doc-record", text: "Linked record" }), recordInput,
                el("span", {
                    class: "field-hint",
                    text: defaultRecord ? "Attached to this record." : "Optional - a record number, if this belongs to one."
                })
            ]),
            el("div", { class: "field-group" }, [
                el("label", { for: "doc-file", text: "File" }), fileInput,
                el("span", { class: "field-hint", text: "Excel, Word, PDF, or CSV." })
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            save
        ])
    );

    save.addEventListener("click", async () => {
        errorBox.hidden = true;

        if (!docNumberInput.value.trim() || !titleInput.value.trim() || !fileInput.files[0]) {
            errorBox.textContent = "Document number, title, and a file are all required.";
            errorBox.hidden = false;
            return;
        }

        save.disabled = true;
        save.textContent = "Uploading...";

        const formData = new FormData();
        formData.append("doc_number", docNumberInput.value.trim());
        formData.append("title", titleInput.value.trim());
        formData.append("change_summary", summaryInput.value.trim() || "Initial upload");
        if (recordInput.value.trim()) formData.append("record", recordInput.value.trim());
        formData.append("file", fileInput.files[0]);

        try {
            const result = await api.uploadDocument(formData);
            node.close();
            toast(result.document.doc_number + " uploaded");
            if (onSaved) await onSaved();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Upload";
        }
    });

    node.showModal();
}

function openUploadRevisionDialog(docNumber, onSaved) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const summaryInput = el("textarea", { id: "rev-summary", rows: 2, placeholder: "What changed in this revision?" });
    const fileInput = el("input", { type: "file", id: "rev-file" });

    const save = el("button", { class: "btn btn-primary", type: "button" }, "Upload revision");

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: "New revision - " + docNumber })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [
                el("label", { for: "rev-summary", text: "Change summary" }), summaryInput
            ]),
            el("div", { class: "field-group" }, [
                el("label", { for: "rev-file", text: "File" }), fileInput,
                el("span", {
                    class: "field-hint",
                    text: "Uploading does not make this the released revision - the current one stays in force until this is released."
                })
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            save
        ])
    );

    save.addEventListener("click", async () => {
        errorBox.hidden = true;

        if (!fileInput.files[0]) {
            errorBox.textContent = "A file is required.";
            errorBox.hidden = false;
            return;
        }

        save.disabled = true;
        save.textContent = "Uploading...";

        const formData = new FormData();
        formData.append("change_summary", summaryInput.value.trim() || "Revision uploaded");
        formData.append("file", fileInput.files[0]);

        try {
            const result = await api.uploadDocumentRevision(docNumber, formData);
            node.close();
            toast("Revision " + result.revision + " uploaded");
            if (onSaved) await onSaved();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Upload revision";
        }
    });

    node.showModal();
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

    const uploadButton = document.getElementById("document-upload");
    if (uploadButton) {
        uploadButton.addEventListener("click", () => {
            openUploadDocumentDialog(null, renderDocuments);
        });
    }

    const newRevisionButton = document.getElementById("document-new-revision");
    if (newRevisionButton) {
        newRevisionButton.addEventListener("click", () => {
            if (!selectedDocument) return;
            openUploadRevisionDialog(selectedDocument, () => renderDocumentDetail(selectedDocument));
        });
    }
}

/* ---------- a compact documents panel, embeddable on any record's
   own detail view ----------

   The general library above is a full register + revision-history
   split; a record's own detail page needs something smaller - which
   documents are attached, their current revision, one click to
   download it, one to attach another. Reuses the exact same upload
   dialog and the exact same API this whole file already uses -
   "documents attached to a record" is not a different kind of thing
   from "documents," just a filtered view of them. */
export async function renderDocumentsPanel(recordNumber, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    try {
        const { documents } = await api.documents(recordNumber);

        const rows = documents.length === 0
            ? [el("p", { class: "sm dim", text: "No documents attached." })]
            : documents.map((doc) => {
                const [label, kind] = DOC_STATUS[doc.status] || ["Unknown", "hold"];

                let action = el("span", { class: "sm dim", text: "No released revision yet" });

                if (doc.current_revision) {
                    action = el("button", {
                        class: "btn btn-xs no-print", type: "button",
                        text: "View " + doc.current_revision
                    });
                    action.addEventListener("click", () => {
                        openDocumentWindow(doc.doc_number, doc.current_revision, doc.doc_number + " - " + doc.title);
                    });
                }

                return el("div", { class: "row", style: "justify-content:space-between;gap:8px" }, [
                    el("div", {}, [
                        el("span", { class: "mono sm", text: doc.doc_number }),
                        el("span", { class: "sm", text: "  " + doc.title + "  " }),
                        pill(label, kind)
                    ]),
                    action
                ]);
            });

        const uploadButton = el("button", {
            class: "btn btn-xs no-print", type: "button", "data-requires": "document.create",
            style: "margin-top:8px"
        }, "+ Attach document");
        uploadButton.addEventListener("click", () => {
            openUploadDocumentDialog(recordNumber, () => renderDocumentsPanel(recordNumber, containerId));
        });

        container.replaceChildren(...rows, uploadButton);
        applyPermissions(container);
    } catch (error) {
        container.replaceChildren(
            el("p", { class: "sm", style: "color:var(--crit)", text: error.message })
        );
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
    const note = document.getElementById("vendors-note");
    loadingRow(tbody, 7);

    try {
        const { vendors } = await api.vendors();

        if (note) {
            const active = vendors.filter((v) => v.status !== "onboarding" && v.status !== "suspended").length;
            const scarOpen = vendors.filter((v) => v.open_scars > 0).length;
            note.textContent = active + " active"
                + (scarOpen > 0 ? " / " + scarOpen + " SCAR open" : "");
        }

        fillTable(tbody, vendors, [
            { render: (row) => row.name },
            { className: "sm", render: (row) => row.scope },
            { className: "mono sm", render: (row) => row.cert_type || "-" },
            { className: "mono sm", render: (row) => formatDate(row.cert_expires) },
            { className: "num", render: (row) => row.otd_pct != null ? row.otd_pct + "%" : "-" },
            { className: "num", render: (row) => row.ppm != null ? row.ppm.toLocaleString() : "-" },
            { render: (row) => {
                const [label, kind] = VENDOR_STATUS[row.status] || ["Unknown", "hold"];
                /* "live" vs "entered" mirrors the exact chip the
                   Scorecards screen already uses for the same
                   distinction - a grade computed from real receiving
                   volume against one still resting on a typed-in
                   figure because there is not enough history yet. */
                return el("span", { class: "row", style: "gap:6px" }, [
                    pill(label, kind),
                    el("span", {
                        class: "chip",
                        title: row.scoring === "computed"
                            ? "Calculated from real receiving history"
                            : "Not enough receiving volume yet - entered figure",
                        text: row.scoring === "computed" ? "live" : "entered"
                    })
                ]);
            } }
        ], "No vendors tracked yet");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            if (!vendors[index]) return;
            tr.dataset.vendor = vendors[index].name;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 7, error);
    }
}

/* Periodic re-evaluation, clause 8.4.1 - separate from the live PPM/
   grade above, which recomputes every time this screen loads. This
   is the dated, documented review an auditor asks to see: someone
   looked at this vendor on a specific day and recorded what they
   found. A dialog rather than its own screen, since it is one short
   history list plus one short form. */
async function openVendorEvaluations(name) {
    const node = ensureDialog();
    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: name })),
        el("div", { class: "modal-body" }, el("p", { class: "sm dim", text: "Loading..." }))
    );
    node.showModal();

    try {
        const { evaluations } = await api.vendorEvaluations(name);

        const history = evaluations.length > 0
            ? el("div", { class: "chip-list" }, evaluations.map((e) => el("span", {
                class: "chip",
                title: e.notes || "",
                text: formatDate(e.audit_date)
                      + (e.performance_score != null ? "  score " + e.performance_score : "")
                      + "  " + e.non_conformance_count + " NC"
                      + (e.evaluated_by ? "  by " + e.evaluated_by : "")
              })))
            : el("p", { class: "sm dim", text: "No evaluations recorded yet." });

        const body = [
            el("div", { class: "section-label", text: "History" }),
            history
        ];

        if (can("vendor.approve")) {
            const auditDate = el("input", { type: "date" });
            const score = el("input", { type: "number", min: "0", max: "100", step: "0.1", placeholder: "0-100" });
            const ncCount = el("input", { type: "number", min: "0", step: "1", value: "0" });
            const notes = el("textarea", { rows: 2, placeholder: "Optional" });
            const add = el("button", { class: "btn btn-primary no-print", type: "button" }, "Record evaluation");

            add.addEventListener("click", async () => {
                if (!auditDate.value) {
                    toast("Audit date is required", "error");
                    return;
                }

                try {
                    await api.addVendorEvaluation(name, {
                        audit_date: auditDate.value,
                        performance_score: score.value === "" ? null : Number(score.value),
                        non_conformance_count: Number(ncCount.value) || 0,
                        notes: notes.value.trim() || null
                    });
                    toast("Evaluation recorded");
                    await openVendorEvaluations(name);
                } catch (error) {
                    toast(error.message, "error");
                }
            });

            body.push(
                el("div", { class: "section-label", text: "Record a new evaluation" }),
                el("div", { class: "field-group" }, [el("label", { text: "Audit date" }), auditDate]),
                el("div", { class: "field-group" }, [el("label", { text: "Performance score" }), score]),
                el("div", { class: "field-group" }, [el("label", { text: "Non-conformances found" }), ncCount]),
                el("div", { class: "field-group" }, [el("label", { text: "Notes" }), notes]),
                el("div", { class: "row" }, add)
            );
        }

        node.replaceChildren(
            el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: name })),
            el("div", { class: "modal-body" }, body),
            el("div", { class: "modal-foot" },
                el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Close"))
        );
    } catch (error) {
        node.replaceChildren(
            el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: name })),
            el("div", { class: "modal-body" }, el("p", { class: "sm", style: "color:var(--crit)", text: error.message }))
        );
    }
}

export function wireVendors() {
    const tbody = document.getElementById("vendors-table");
    if (tbody) {
        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-vendor]");
            if (!row) return;
            openVendorEvaluations(row.dataset.vendor);
        });
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
