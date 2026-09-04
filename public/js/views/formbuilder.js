/* ============================================================
   Form Builder.

   Shows the schema the API actually validates against, read from
   form_versions. That matters: a builder that displayed a mock-up of
   a form would be the most misleading screen in the product, because
   the whole promise of the configurable layer is that what you see
   here is what the server enforces.

   Editing is not built yet, and the screen says so rather than
   offering controls that do nothing.
   ============================================================ */

import { api } from "../api.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize
} from "../dom.js";

const TYPE_LABEL = {
    text:      ["TXT", "Short text"],
    memo:      ["MEM", "Long text"],
    number:    ["NUM", "Number"],
    date:      ["DAT", "Date"],
    select:    ["SEL", "Pick list"],
    link:      ["LNK", "Record link"],
    file:      ["FIL", "Attachment"],
    signature: ["SIG", "E-signature"],
    user:      ["USR", "Person"]
};

let selectedType = null;

export async function renderForms() {
    const tbody = document.getElementById("record-type-table");
    loadingRow(tbody, 6);

    try {
        const { record_types } = await api.recordTypes();

        fillTable(tbody, record_types, [
            { className: "sm", render: (row) => row.name },
            { className: "mono sm", render: (row) => row.prefix },
            { className: "mono sm dim", render: (row) => row.clause || "-" },
            { className: "num", render: (row) => row.record_count.toLocaleString() },
            { className: "mono sm", render: (row) => row.version
                ? "v" + row.version : el("span", { class: "dim", text: "none" }) },
            { render: (row) => row.version
                ? pill(row.field_count + " fields", "info")
                : pill("No form", "hold") }
        ], "No record types");

        tbody.querySelectorAll("tr").forEach((tr, index) => {
            const row = record_types[index];
            if (!row || !row.version) return;
            tr.dataset.type = row.key;
            tr.classList.add("row-clickable");
        });

        const withForm = record_types.filter((r) => r.version);
        const target = withForm.some((r) => r.key === selectedType)
            ? selectedType
            : (withForm[0] && withForm[0].key);

        if (target) {
            mark(tbody, target);
            await renderSchema(target);
        }
    } catch (error) {
        errorRow(tbody, 6, error);
    }
}

async function renderSchema(typeKey) {
    selectedType = typeKey;

    const heading = document.getElementById("schema-name");
    const note = document.getElementById("schema-note");
    const fieldBody = document.getElementById("schema-fields");
    const rulesPanel = document.getElementById("schema-rules");

    if (fieldBody) loadingRow(fieldBody, 4);

    try {
        const definition = await api.recordForm(typeKey);

        if (heading) heading.textContent = definition.name + " form";
        if (note) {
            note.textContent = "version " + definition.version
                + ", clause " + (definition.clause || "-");
        }

        fillTable(fieldBody, definition.fields, [
            { className: "mono sm dim", render: (row) =>
                (TYPE_LABEL[row.type] || ["?", row.type])[0] },
            { className: "sm", render: (row) => row.label },
            { className: "mono sm dim", render: (row) => row.key },
            { render: (row) => {
                const bits = [];

                if (row.required) bits.push(pill("Required", "open"));
                if (row.pattern)  bits.push(el("span", { class: "chip", text: "pattern" }));
                if (row.min !== undefined) bits.push(el("span", { class: "chip", text: "min " + row.min }));
                if (row.target)   bits.push(el("span", { class: "chip", text: "links to " + row.target }));
                if (row.options)  bits.push(el("span", { class: "chip", text: row.options.length + " options" }));
                if (row.max)      bits.push(el("span", { class: "chip", text: "max " + row.max }));

                return bits.length > 0
                    ? el("span", { class: "row", style: "gap:5px" }, bits)
                    : el("span", { class: "dim sm", text: "-" });
            } }
        ], "This form has no fields");

        /* The conditional rules, which are the part that makes a form
           behave rather than just collect. */
        if (rulesPanel) {
            const rules = definition.rules || [];

            rulesPanel.replaceChildren(
                el("p", { class: "sm dim", style: "margin:0 0 12px", text:
                    rules.length === 0
                        ? "No conditional rules on this form."
                        : "Enforced by the server on every submission, not only in the browser." }),
                el("div", { class: "chip-list" }, rules.map((rule) => {
                    const parts = [rule.when ? "if " + rule.when : null, "then " + rule.then];
                    if (rule.role)  parts.push("by " + humanize(rule.role));
                    if (rule.field) parts.push("field " + rule.field);
                    return el("span", { class: "chip", text: parts.filter(Boolean).join("  ") });
                }))
            );
        }
    } catch (error) {
        errorRow(fieldBody, 4, error);
    }
}

function mark(tbody, typeKey) {
    tbody.querySelectorAll("tr").forEach((tr) => {
        tr.classList.toggle("row-selected", tr.dataset.type === typeKey);
    });
}

export function wireForms() {
    const tbody = document.getElementById("record-type-table");
    if (!tbody) return;

    tbody.addEventListener("click", (event) => {
        const row = event.target.closest("tr[data-type]");
        if (!row) return;
        mark(tbody, row.dataset.type);
        renderSchema(row.dataset.type);
    });
}
