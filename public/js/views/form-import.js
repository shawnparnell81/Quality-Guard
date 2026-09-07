/* ============================================================
   Import Form.

   Upload an .xlsx, the server hands back an inferred field list, and
   the same field-row editor the Form Builder uses lets an admin
   correct types / labels / sections before it becomes a record type
   (new) or a new version of an existing one.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { buildFieldRow, readFieldRow } from "./formbuilder.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, toast
} from "../dom.js";

const BUILT_IN = new Set([
    "ncr", "capa", "eightd", "complaint", "scar", "audit", "ecn", "risk", "apqp", "di"
]);

let currentImport = null;   // { id, name, fields }

export async function renderFormImport() {
    const tbody = document.getElementById("form-import-list");
    if (!tbody) return;
    loadingRow(tbody, 5);

    try {
        const { imports } = await api.formImports();
        fillTable(tbody, imports, [
            { className: "sm", render: (r) => r.original_name || r.name },
            { className: "num", render: (r) => r.field_count },
            { render: (r) => r.status === "applied"
                ? pill("Applied", "done") : pill("Inferred", "prog") },
            { className: "mono sm", render: (r) => r.applied_key || "-" },
            { className: "mono sm dim", render: (r) => formatDate(r.created_at) }
        ], "Nothing imported yet");

        tbody.querySelectorAll("tr").forEach((tr, i) => {
            if (!imports[i]) return;
            tr.dataset.id = imports[i].id;
            tr.classList.add("row-clickable");
        });
    } catch (error) {
        errorRow(tbody, 5, error);
    }
}

/* ---------- the preview / correct / apply panel ---------- */

async function loadTypesForApply() {
    try {
        return (await api.recordTypes()).record_types
            .filter((t) => !BUILT_IN.has(t.key) && t.version)
            .map((t) => ({ key: t.key, name: t.name }));
    } catch {
        return [];
    }
}

async function showPreview(imp) {
    currentImport = imp;
    const panel = document.getElementById("form-import-preview-panel");
    const host = document.getElementById("form-import-preview");
    const name = document.getElementById("form-import-name");
    if (!panel || !host) return;

    panel.hidden = false;
    if (name) name.textContent = imp.name + " — " + imp.fields.length + " fields";
    host.replaceChildren(el("p", { class: "sm dim", text: "Adjust types, labels and sections, then choose where to save." }));

    /* the field rows, reusing the Form Builder editor */
    const list = el("div", { class: "field-row-list", style: "max-height:420px" });
    for (const field of imp.fields) list.append(buildFieldRow(field));
    const addField = el("button", { class: "btn no-print", type: "button", text: "+ Add field" });
    addField.addEventListener("click", () => list.append(buildFieldRow({ type: "text" })));

    /* save-as controls */
    const asNew = el("input", { type: "radio", name: "form-import-target", value: "new", checked: "checked" });
    const asExisting = el("input", { type: "radio", name: "form-import-target", value: "existing" });

    const newName = el("input", { type: "text", value: imp.name, placeholder: "Form name" });
    const newPrefix = el("input", { type: "text", placeholder: "Prefix, e.g. PFMEA", maxlength: "12" });
    const newClause = el("input", { type: "text", placeholder: "ISO clause (optional)" });
    const newBlock = el("div", { class: "field-grid" }, [
        el("div", { class: "field-group" }, [el("label", { text: "Name" }), newName]),
        el("div", { class: "field-group" }, [el("label", { text: "Number prefix" }), newPrefix]),
        el("div", { class: "field-group" }, [el("label", { text: "Clause" }), newClause])
    ]);

    const types = await loadTypesForApply();
    const existingSelect = el("select", {}, [
        el("option", { value: "", text: types.length ? "Choose a form type..." : "No custom types yet" }),
        ...types.map((t) => el("option", { value: t.key, text: t.name }))
    ]);
    const existingBlock = el("div", { class: "field-group", hidden: "hidden" },
        [el("label", { text: "Publish a new version of" }), existingSelect]);

    const syncTarget = () => { existingBlock.hidden = !asExisting.checked; newBlock.hidden = asExisting.checked; };
    asNew.addEventListener("change", syncTarget);
    asExisting.addEventListener("change", syncTarget);

    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });
    const apply = el("button", { class: "btn btn-primary no-print", type: "button", text: "Save form" });

    apply.addEventListener("click", async () => {
        errorBox.hidden = true;
        const taken = new Set();
        const fields = [...list.children].map((r) => readFieldRow(r, taken)).filter((f) => f.label);
        if (fields.length === 0) {
            errorBox.textContent = "Keep at least one field.";
            errorBox.hidden = false;
            return;
        }

        const payload = { fields };
        if (asExisting.checked) {
            if (!existingSelect.value) {
                errorBox.textContent = "Pick a form type to add a version to.";
                errorBox.hidden = false;
                return;
            }
            payload.target = existingSelect.value;
        } else {
            payload.target = "new";
            payload.name = newName.value.trim();
            payload.prefix = newPrefix.value.trim();
            payload.clause = newClause.value.trim() || undefined;
            if (!payload.name || !payload.prefix) {
                errorBox.textContent = "Name and prefix are both required for a new form type.";
                errorBox.hidden = false;
                return;
            }
        }

        apply.disabled = true;
        apply.textContent = "Saving...";
        try {
            const result = await api.applyFormImport(imp.id, payload);
            toast(result.created
                ? result.name + " created (" + result.applied_key + ")"
                : "Published v" + result.version + " of " + result.applied_key);
            panel.hidden = true;
            currentImport = null;
            await renderFormImport();
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "form-record" } }));
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            apply.disabled = false;
            apply.textContent = "Save form";
        }
    });

    host.append(
        list, addField,
        el("div", { class: "section-label", text: "Save as" }),
        el("label", { class: "row", style: "gap:6px" }, [asNew, " New form type"]),
        newBlock,
        el("label", { class: "row", style: "gap:6px;margin-top:6px" }, [asExisting, " New version of an existing type"]),
        existingBlock,
        errorBox,
        el("div", { class: "row", style: "margin-top:12px" }, apply)
    );
}

/* ---------- wiring ---------- */

export function wireFormImport() {
    const uploadBtn = document.getElementById("form-import-upload");
    const fileInput = document.getElementById("form-import-file");
    const status = document.getElementById("form-import-status");

    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener("click", async () => {
            if (!can("forms.manage")) return;
            if (!fileInput.files || !fileInput.files[0]) {
                toast("Choose an .xlsx file first", "error");
                return;
            }
            const form = new FormData();
            form.append("file", fileInput.files[0]);
            uploadBtn.disabled = true;
            uploadBtn.textContent = "Reading...";
            if (status) status.textContent = "";
            try {
                const res = await api.importForm(form);
                if (status) {
                    status.textContent = "Read sheet \"" + res.sheet + "\""
                        + (res.sheet_names.length > 1 ? " (of " + res.sheet_names.length + ")" : "")
                        + " — " + res.fields.length + " fields inferred. Review below.";
                }
                await showPreview({ id: res.import_id, name: res.name, fields: res.fields });
                await renderFormImport();
            } catch (error) {
                if (status) status.textContent = error.message;
                toast(error.message, "error");
            } finally {
                uploadBtn.disabled = false;
                uploadBtn.textContent = "Infer schema";
            }
        });
    }

    const list = document.getElementById("form-import-list");
    if (list) {
        list.addEventListener("click", async (event) => {
            const row = event.target.closest("tr[data-id]");
            if (!row) return;
            try {
                const detail = await api.formImportDetail(row.dataset.id);
                const schema = detail.schema || {};
                await showPreview({
                    id: detail.id, name: detail.name,
                    fields: Array.isArray(schema.fields) ? schema.fields : []
                });
            } catch (error) {
                toast(error.message, "error");
            }
        });
    }
}
