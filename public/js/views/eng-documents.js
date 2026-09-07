/* ============================================================
   Engineering Documents.

   A place for engineering's own controlled documents - specs,
   calculations, standards, analysis reports - that are not drawings.
   Backed by the same controlled-documents store as Document Control
   (documents + document_revisions), filtered to category "engineering"
   so this screen shows only what belongs here. Upload a file, open it
   in a window; revision management and release stay in Document
   Control.
   ============================================================ */

import { api } from "../api.js";
import { applyPermissions } from "../session.js";
import { openEntityForm } from "../entity-form.js";
import { openDocumentWindow } from "../doc-windows.js";
import { el, pill, toast, fillTable, loadingRow, errorRow } from "../dom.js";

const STATUS = {
    draft:       ["Draft", "hold"],
    in_approval: ["In approval", "prog"],
    released:    ["Released", "done"],
    obsolete:    ["Obsolete", "hold"]
};

function openUploadForm() {
    openEntityForm({
        title: "Upload an engineering document",
        fields: [
            { key: "doc_number", label: "Document number", type: "text", required: true,
              hint: "e.g. ENG-SPEC-014, CALC-2026-003." },
            { key: "title", label: "Title", type: "text", required: true },
            { key: "change_summary", label: "Notes", type: "memo" },
            { key: "file", label: "File", type: "file", required: true,
              accept: ".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt" }
        ],
        submitLabel: "Upload",
        successMessage: "Document uploaded",
        onSubmit: ({ values, files }) => {
            const form = new FormData();
            form.append("doc_number", values.doc_number);
            form.append("title", values.title);
            form.append("category", "engineering");
            if (values.change_summary) form.append("change_summary", values.change_summary);
            form.append("file", files.file);
            return api.uploadDocument(form);
        },
        onSaved: () => renderEngDocuments()
    });
}

export async function renderEngDocuments() {
    const tbody = document.getElementById("eng-doc-table");
    if (!tbody) return;
    loadingRow(tbody, 5);

    const addButton = document.getElementById("eng-doc-upload");
    if (addButton && !addButton.dataset.wired) {
        addButton.dataset.wired = "1";
        addButton.addEventListener("click", openUploadForm);
    }

    try {
        const { documents } = await api.documents({ category: "engineering" });

        fillTable(tbody, documents, [
            { className: "mono sm", render: (row) => row.doc_number },
            { render: (row) => row.title },
            { className: "mono sm", render: (row) => row.current_revision || "-" },
            { render: (row) => row.owner || "-" },
            { render: (row) => {
                const [label, kind] = STATUS[row.status] || ["Unknown", "hold"];
                return pill(label, kind);
            } }
        ], "No engineering documents yet. Upload one to start.");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            const row = documents[index];
            if (!row) return;
            tr.classList.add("row-clickable");
            tr.addEventListener("click", () => openDocumentWindow(
                row.doc_number, row.current_revision || "A", row.doc_number + " - " + row.title
            ));
        });

        const host = tbody.closest(".panel");
        if (host) applyPermissions(host);
    } catch (error) {
        errorRow(tbody, 5, error);
        toast(error.message, "error");
    }
}
