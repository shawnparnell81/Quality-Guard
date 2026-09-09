/* ============================================================
   Custom Forms.

   The register + detail screen for record types that were created
   in-app (POST /api/record-types) or brought in by the Excel
   importer, rather than shipped as a hardcoded screen. Everything
   here is schema-driven: the field list comes from the published
   form version, so a table field or a new section shows up with no
   change to this file.

   The built-in types (NCR, CAPA, 8D, ...) keep their own screens and
   are filtered out here.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { openRecordEditor, ensureDialog } from "../forms.js";
import { buildFieldRow, readFieldRow } from "./formbuilder.js";
import { buildUploader } from "../attach-upload.js";
import { openFileWindow } from "../doc-windows.js";
import { openExcelLayout } from "./excel-layout.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, statusKind, toast
} from "../dom.js";
import { formatValue } from "../format.js";

const BUILT_IN = new Set([
    "ncr", "capa", "eightd", "complaint", "scar", "audit", "ecn", "risk", "apqp", "di"
]);

let currentType = null;
let selectedNumber = null;

export async function renderFormRecord() {
    const select = document.getElementById("form-record-type");
    const table = document.getElementById("form-record-table");
    if (!select || !table) return;

    loadingRow(table, 4);

    let types;
    try {
        types = (await api.recordTypes()).record_types.filter((t) => !BUILT_IN.has(t.key) && t.version);
    } catch (error) {
        errorRow(table, 4, error);
        return;
    }

    if (types.length === 0) {
        select.replaceChildren(el("option", { value: "", text: "No custom forms yet" }));
        table.replaceChildren(el("tr", {}, el("td", {
            colspan: 4, class: "dim sm", style: "text-align:center;padding:24px",
            text: can("forms.manage")
                ? "Create one with “+ New form type”, or import from Excel."
                : "No custom forms have been created yet."
        })));
        document.getElementById("form-record-detail").replaceChildren();
        document.getElementById("form-record-detail-number").textContent = "Select a record";
        return;
    }

    const keep = types.some((t) => t.key === currentType) ? currentType : types[0].key;
    select.replaceChildren(...types.map((t) =>
        el("option", { value: t.key, text: t.name + "  (" + t.prefix + ")", selected: t.key === keep ? "selected" : undefined })));
    currentType = keep;

    await renderTypeRecords(keep);
}

async function renderTypeRecords(typeKey) {
    currentType = typeKey;

    /* keep the "Excel template" link pointed at the chosen form */
    const tpl = document.getElementById("form-record-template");
    if (tpl) tpl.href = api.recordExcelTemplateUrl(typeKey);

    const table = document.getElementById("form-record-table");
    const note = document.getElementById("form-record-note");
    loadingRow(table, 4);

    try {
        const { records } = await api.records({ type: typeKey });
        if (note) note.textContent = records.length + " record" + (records.length === 1 ? "" : "s");

        fillTable(table, records, [
            { className: "mono sm nowrap", render: (r) => r.number },
            { className: "sm", render: (r) => r.title || "-" },
            { render: (r) => pill(humanize(r.status), statusKind(r.status)) },
            { className: "mono sm dim", render: (r) => formatDate(r.opened_at) }
        ], "No records yet");

        table.querySelectorAll("tr").forEach((tr, i) => {
            if (!records[i]) return;
            tr.dataset.number = records[i].number;
            tr.classList.add("row-clickable");
        });

        const target = records.some((r) => r.number === selectedNumber)
            ? selectedNumber : (records[0] && records[0].number);
        if (target) {
            mark(table, target);
            await renderCustomDetail(typeKey, target);
        } else {
            selectedNumber = null;
            document.getElementById("form-record-detail").replaceChildren(
                el("p", { class: "sm dim", text: "No records of this type yet." }));
            document.getElementById("form-record-detail-number").textContent = "Select a record";
        }
    } catch (error) {
        errorRow(table, 4, error);
    }
}

function mark(table, number) {
    table.querySelectorAll("tr").forEach((tr) =>
        tr.classList.toggle("row-selected", tr.dataset.number === number));
}

async function renderCustomDetail(typeKey, number) {
    selectedNumber = number;
    const panel = document.getElementById("form-record-detail");
    const head = document.getElementById("form-record-detail-number");
    panel.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    let record, transitions, definition, signatures;
    try {
        const got = await api.record(number);
        record = got.record;
        transitions = got.transitions;
        signatures = got.signatures || {};
        definition = await api.recordForm(typeKey).catch(() => null);
    } catch (error) {
        panel.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    if (head) head.textContent = record.number;

    const children = [
        el("div", { class: "row", style: "gap:6px;margin-bottom:8px" }, [
            pill(humanize(record.status), statusKind(record.status)),
            el("span", { class: "sm dim", text: (record.title || "") })
        ])
    ];

    const fields = definition && Array.isArray(definition.fields) ? definition.fields : [];
    let kv = null;
    let lastSection;
    let anyValue = false;
    const flushKv = () => { if (kv && kv.childElementCount) children.push(kv); kv = null; };

    for (const field of fields) {
        const value = record.data ? record.data[field.key] : undefined;
        const hasValue = field.type === "table"
            ? Array.isArray(value) && value.length > 0
            : value !== undefined && value !== null && value !== "";
        if (!hasValue) continue;
        anyValue = true;

        if ((field.section || null) !== (lastSection || null)) {
            lastSection = field.section || null;
            if (lastSection) { flushKv(); children.push(el("div", { class: "section-label", text: lastSection })); }
        }

        if (field.type === "table") {
            flushKv();
            const columns = Array.isArray(field.columns) ? field.columns : [];
            children.push(el("div", { class: "sm", style: "font-weight:600;margin:6px 0 4px", text: field.label }));
            children.push(el("div", { class: "table-wrap" }, el("table", { class: "sm" }, [
                el("thead", {}, el("tr", {}, columns.map((c) => el("th", { text: c.label })))),
                el("tbody", {}, value.map((r) => el("tr", {},
                    columns.map((c) => el("td", { class: "sm", text: formatValue(c, r[c.key], { empty: "-" }) })))))
            ])));
        } else {
            if (!kv) kv = el("dl", { class: "kv" });
            const dd = el("dd", { text: formatValue(field, value) });
            const sig = field.type === "signature" ? signatures[field.key] : null;
            if (sig && !sig.legacy) {
                dd.append(el("span", {
                    class: "chip sm",
                    style: "margin-left:6px;" + (sig.intact
                        ? "background:var(--ok-bg,#e6f4ea);color:var(--ok,#1a7f37)"
                        : "background:var(--crit-bg,#fdeaea);color:var(--crit,#b3261e)"),
                    text: sig.intact ? "✓ unchanged since signing" : "⚠ record edited after signing"
                }));
            }
            kv.append(el("dt", { text: field.label }), dd);
        }
    }
    flushKv();

    if (!anyValue) children.push(el("p", { class: "sm dim", text: "No fields filled in yet." }));

    /* ---------- attachments (record-level, plus any pinned to a row) ---------- */

    children.push(el("div", { class: "section-label", text: "Attachments" }));

    /* row_ref = "<fieldKey>:<rowId>" -> "Field label · row 3" */
    const rowRefLabel = (rowRef) => {
        const [key, rowId] = String(rowRef).split(":");
        const field = fields.find((f) => f.key === key);
        const rows = record.data && Array.isArray(record.data[key]) ? record.data[key] : [];
        const idx = rows.findIndex((r) => r && r._id === rowId);
        const name = field ? field.label : humanize(key || "row");
        return idx >= 0 ? name + " · row " + (idx + 1) : name;
    };

    let attachments = [];
    try {
        attachments = (await api.attachments(number)).attachments || [];
    } catch { /* a fresh record with none, or a transient error - show the uploader anyway */ }

    if (attachments.length) {
        children.push(el("div", { class: "chip-list" }, attachments.map((a) => {
            const tag = a.row_ref ? "[" + rowRefLabel(a.row_ref) + "]  " : "";
            const meta = "  " + formatDate(a.uploaded_at) + (a.uploaded_by ? "  " + a.uploaded_by : "");
            if (a.has_file) {
                return el("button", {
                    class: "chip chip-link no-print", type: "button", title: "Open " + a.filename,
                    onClick: () => openFileWindow(
                        api.attachmentFileUrl(number, a.id), a.filename, a.mime_type)
                }, tag + a.filename + meta);
            }
            return el("span", { class: "chip", title: a.storage_key || "", text: tag + a.filename + meta + "  (link)" });
        })));
    } else {
        children.push(el("p", { class: "sm dim", text: "No attachments yet." }));
    }

    children.push(buildUploader({
        url: api.recordAttachmentsUrl(number),
        onComplete: () => renderCustomDetail(typeKey, number)
    }));

    const edit = el("button", { class: "btn no-print", type: "button", text: "Edit" });
    edit.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
        openRecordEditor(typeKey, {
            number: record.number,
            returnView: "form-record",
            onSaved: () => { selectedNumber = record.number; }
        });
    });

    const duplicate = el("button", { class: "btn no-print", type: "button", text: "Duplicate" });
    duplicate.addEventListener("click", async () => {
        duplicate.disabled = true;
        try {
            const r = await api.cloneRecord(record.number);
            toast(r.number + " created from " + record.number);
            selectedNumber = r.number;
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
            openRecordEditor(typeKey, {
                number: r.number, returnView: "form-record",
                onSaved: () => { selectedNumber = r.number; }
            });
        } catch (error) {
            toast(error.message, "error");
            duplicate.disabled = false;
        }
    });

    const print = el("button", { class: "btn no-print", type: "button", text: "Print",
        title: "Open the full-page form to print",
        onClick: () => window.open(
            "/api/records/" + encodeURIComponent(record.number) + "/pdf?inline=1", "_blank") });
    const pdf = el("a", { class: "btn no-print", text: "PDF",
        href: "/api/records/" + encodeURIComponent(record.number) + "/pdf" });
    const excel = el("a", { class: "btn no-print", text: "Excel",
        href: api.recordExcelUrl(record.number) });

    const row = el("div", { class: "row no-print", style: "margin-top:12px" }, [edit, duplicate, print, pdf, excel]);

    if (can("forms.manage")) {
        const layout = el("button", { class: "btn no-print", type: "button", text: "Excel layout" });
        const typeName = document.getElementById("form-record-type")
            ?.selectedOptions[0]?.textContent || typeKey;
        layout.addEventListener("click", () => openExcelLayout(typeKey, typeName));
        row.append(layout);
    }

    if (transitions) {
        for (const step of transitions) {
            if (!step.allowed) continue;
            const b = el("button", { class: "btn no-print", type: "button", text: step.label });
            b.addEventListener("click", async () => {
                try {
                    await api.transition(record.number, { to: step.to, reason: "" });
                    await renderTypeRecords(typeKey);
                } catch (error) { toast(error.message, "error"); }
            });
            row.append(b);
        }
    }
    children.push(row);

    panel.replaceChildren(...children);
}

/* ---------- create a new form type ---------- */

function openNewTypeDialog() {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const name = el("input", { type: "text", placeholder: "e.g. Control Plan" });
    const prefix = el("input", { type: "text", placeholder: "e.g. CP", maxlength: "12" });
    const clause = el("input", { type: "text", placeholder: "ISO clause (optional)" });

    const list = el("div", { class: "field-row-list" });
    list.append(buildFieldRow({ type: "text", label: "" }));
    const addField = el("button", { class: "btn", type: "button", text: "+ Add field" });
    addField.addEventListener("click", () => list.append(buildFieldRow({ type: "text" })));

    const create = el("button", { class: "btn btn-primary", type: "button", text: "Create form type" });
    create.addEventListener("click", async () => {
        errorBox.hidden = true;
        const taken = new Set();
        const fields = [...list.children].map((r) => readFieldRow(r, taken)).filter((f) => f.label);
        if (!name.value.trim() || !prefix.value.trim()) {
            errorBox.textContent = "Name and prefix are both required.";
            errorBox.hidden = false;
            return;
        }
        if (fields.length === 0) {
            errorBox.textContent = "Add at least one field (you can add more in the Form Builder later).";
            errorBox.hidden = false;
            return;
        }
        create.disabled = true;
        try {
            const made = await api.createRecordType({
                name: name.value.trim(), prefix: prefix.value.trim(),
                clause: clause.value.trim() || undefined, fields
            });
            node.close();
            toast(made.name + " created");
            currentType = made.key;
            await renderFormRecord();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
            create.disabled = false;
        }
    });

    node.replaceChildren(
        el("div", { class: "modal-head" }, [
            el("h2", { class: "modal-title", text: "New form type" }),
            el("span", { class: "panel-note", text: "Creates a record type with an Open → Closed workflow. Refine the fields in the Form Builder afterwards." })
        ]),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [el("label", { text: "Name" }), name]),
            el("div", { class: "field-group" }, [el("label", { text: "Number prefix" }), prefix]),
            el("div", { class: "field-group" }, [el("label", { text: "Clause" }), clause]),
            el("div", { class: "section-label", text: "Starting fields" }),
            list, addField
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", text: "Cancel", onClick: () => node.close() }),
            create
        ])
    );
    node.showModal();
}

export function wireFormRecord() {
    const select = document.getElementById("form-record-type");
    if (select) select.addEventListener("change", () => {
        if (!select.value) return;
        selectedNumber = null;
        renderTypeRecords(select.value);
    });

    const table = document.getElementById("form-record-table");
    if (table) table.addEventListener("click", (event) => {
        const tr = event.target.closest("tr[data-number]");
        if (!tr) return;
        mark(table, tr.dataset.number);
        renderCustomDetail(currentType, tr.dataset.number);
    });

    const newRecord = document.getElementById("form-record-new");
    if (newRecord) newRecord.addEventListener("click", () => {
        if (!currentType) { toast("Create or pick a form type first", "error"); return; }
        document.dispatchEvent(new CustomEvent("navigate", { detail: { view: "record-editor" } }));
        openRecordEditor(currentType, {
            returnView: "form-record",
            onSaved: (r) => { selectedNumber = r && r.number; }
        });
    });

    const newType = document.getElementById("form-record-newtype");
    if (newType) newType.addEventListener("click", () => {
        if (can("forms.manage")) openNewTypeDialog();
    });

    /* Fill from Excel: pick a file, the server parses the Form sheet
       and every table sheet into one record. */
    const fromExcel = document.getElementById("form-record-fromexcel");
    const excelFile = document.getElementById("form-record-excel-file");
    if (fromExcel && excelFile) {
        fromExcel.addEventListener("click", () => {
            if (!currentType) { toast("Pick a form type first", "error"); return; }
            excelFile.value = "";
            excelFile.click();
        });
        excelFile.addEventListener("change", async () => {
            if (!excelFile.files.length) return;
            const fd = new FormData();
            fd.append("file", excelFile.files[0]);
            fromExcel.disabled = true;
            fromExcel.textContent = "Reading...";
            try {
                const r = await api.importRecordExcel(currentType, fd);
                toast(r.number + " created from Excel");
                selectedNumber = r.number;
                await renderFormRecord();
            } catch (error) {
                const errs = error.payload && error.payload.errors;
                toast(errs && errs.length ? errs[0] : error.message, "error");
                if (errs && errs.length > 1) {
                    window.alert("The sheet has problems:\n\n" + errs.join("\n"));
                }
            } finally {
                fromExcel.disabled = false;
                fromExcel.textContent = "Fill from Excel";
            }
        });
    }
}
