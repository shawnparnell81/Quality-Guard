/* ============================================================
   Form Builder.

   Shows the schema the API actually validates against, read from
   form_versions. That matters: a builder that displayed a mock-up of
   a form would be the most misleading screen in the product, because
   the whole promise of the configurable layer is that what you see
   here is what the server enforces.

   Editing publishes a NEW form_versions row rather than changing one
   in place - a record captured under the old field list keeps
   pointing at it, so it still renders the fields it was actually
   raised with. Conditional rules are not editable here yet; they are
   carried forward untouched by the server whenever fields are saved.
   ============================================================ */

import { api } from "../api.js";
import { can } from "../session.js";
import { ensureDialog } from "../forms.js";
import {
    el, pill, fillTable, loadingRow, errorRow, formatDate, humanize, toast
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
    user:      ["USR", "Person"],
    table:     ["TBL", "Table (repeating rows)"]
};

/* A table column can only be one of these scalar types - matches the
   server's TABLE_COLUMN_TYPES in masterdata.js. "computed" is a
   read-only cell derived from other number columns in the same row. */
const COLUMN_TYPES = ["text", "memo", "number", "date", "select", "computed"];

/* Where a "link" field's options come from. The server enforces this
   list for real (LINK_SOURCES in masterdata.js); this copy only has
   to be good enough to build a sensible dropdown. */
const LINK_TARGETS = [
    ["parts", "Parts"],
    ["gages", "Gages"],
    ["lots",  "Lots"]
];

let selectedType = null;
let currentDefinition = null;

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
        currentDefinition = definition;

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
                if (row.section)  bits.push(el("span", { class: "chip", text: "§ " + row.section }));
                if (row.pattern)  bits.push(el("span", { class: "chip", text: "pattern" }));
                if (row.min !== undefined) bits.push(el("span", { class: "chip", text: "min " + row.min }));
                if (row.target)   bits.push(el("span", { class: "chip", text: "links to " + row.target }));
                if (row.options)  bits.push(el("span", { class: "chip", text: row.options.length + " options" }));
                if (row.columns)  bits.push(el("span", { class: "chip", text: row.columns.length + " columns" }));
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
        currentDefinition = null;
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
    if (tbody) {
        tbody.addEventListener("click", (event) => {
            const row = event.target.closest("tr[data-type]");
            if (!row) return;
            mark(tbody, row.dataset.type);
            renderSchema(row.dataset.type);
        });
    }

    const editButton = document.getElementById("edit-fields");
    if (editButton) {
        editButton.addEventListener("click", () => {
            if (!currentDefinition || !can("forms.manage")) return;
            openFieldEditor(currentDefinition);
        });
    }
}

/* ============================================================
   Field editor
   ============================================================ */

export function slugify(label, taken) {
    let base = String(label || "")
        .trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    if (!base) base = "field";

    let key = base;
    let n = 2;
    while (taken.has(key)) key = base + "_" + (n++);
    taken.add(key);
    return key;
}

/* One row = one field, built as a small self-contained block. Order
   is read back from DOM order at save time rather than kept in a
   parallel array, so the up/down buttons only ever have to move a
   node, never resynchronise two copies of the same list. */
export function buildFieldRow(field) {
    const row = el("div", { class: "field-row", dataset: { key: field.key || "" } });

    const label = el("input", { type: "text", value: field.label || "", placeholder: "Field label" });

    const type = el("select", {}, Object.entries(TYPE_LABEL).map(([value, [, name]]) =>
        el("option", { value, text: name, selected: value === field.type ? "selected" : undefined })
    ));

    /* An optional section heading. Fields sharing one (in order) are
       grouped under it on the record form and its detail view. */
    const section = el("input", {
        type: "text", class: "field-section", placeholder: "Section (optional)",
        value: field.section || ""
    });

    const required = el("input", { type: "checkbox", checked: field.required ? "checked" : undefined });

    /* title and aria-label both, not one or the other: title covers
       the mouse tooltip, aria-label is what a screen reader actually
       announces for a button with no readable text content - support
       for reading title as a fallback is inconsistent enough not to
       rely on it alone for an icon-only control. */
    const up = el("button", {
        type: "button", class: "btn", title: "Move up", "aria-label": "Move field up"
    }, "↑");
    const down = el("button", {
        type: "button", class: "btn", title: "Move down", "aria-label": "Move field down"
    }, "↓");
    const remove = el("button", {
        type: "button", class: "btn", title: "Remove field", "aria-label": "Remove field"
    }, "✕");

    up.addEventListener("click", () => {
        const prev = row.previousElementSibling;
        if (prev) row.parentNode.insertBefore(row, prev);
    });
    down.addEventListener("click", () => {
        const next = row.nextElementSibling;
        if (next) row.parentNode.insertBefore(next, row);
    });
    remove.addEventListener("click", () => row.remove());

    const extra = el("div", { class: "field-row-extra" });

    /* One column of a table field: a label, a scalar type, and a
       type-dependent extra (pick-list options, or the recipe for a
       computed column). */
    function columnRow(column = {}) {
        const cLabel = el("input", { type: "text", class: "col-label",
            placeholder: "Column label", value: column.label || "" });
        const cType = el("select", { class: "col-type" }, COLUMN_TYPES.map((t) =>
            el("option", { value: t, text: t, selected: t === column.type ? "selected" : undefined })));
        const cExtra = el("span", { class: "col-extra" });
        const del = el("button", { type: "button", class: "btn", text: "✕", "aria-label": "Remove column" });
        const cr = el("div", { class: "table-col-row" }, [cLabel, cType, cExtra, del]);

        function paintColExtra() {
            cExtra.replaceChildren();
            if (cType.value === "select") {
                cExtra.append(el("input", { type: "text", class: "col-options",
                    placeholder: "Options (if pick list)", value: (column.options || []).join(", ") }));
            } else if (cType.value === "computed") {
                cExtra.append(el("select", { class: "col-compute" }, [
                    el("option", { value: "product", text: "× multiply",
                        selected: column.compute === "sum" ? undefined : "selected" }),
                    el("option", { value: "sum", text: "+ add",
                        selected: column.compute === "sum" ? "selected" : undefined })
                ]));
                cExtra.append(el("input", { type: "text", class: "col-inputs",
                    placeholder: "From columns (labels, comma separated)",
                    value: (column._inputLabels || []).join(", ") }));
                const t = column.thresholds || {};
                cExtra.append(el("input", { type: "text", class: "col-thresholds",
                    placeholder: "Amber, red (optional) — e.g. 100, 150",
                    value: [t.warn, t.crit].filter((n) => n != null).join(", ") }));
            }
        }

        cType.addEventListener("change", paintColExtra);
        paintColExtra();
        del.addEventListener("click", () => cr.remove());
        return cr;
    }

    function paintExtra() {
        extra.replaceChildren();

        if (type.value === "select") {
            extra.append(el("input", {
                type: "text", class: "field-options", placeholder: "Options, comma separated",
                value: (field.options || []).join(", ")
            }));
        } else if (type.value === "link") {
            extra.append(el("select", { class: "field-target" }, LINK_TARGETS.map(([value, name]) =>
                el("option", { value, text: name, selected: value === field.target ? "selected" : undefined })
            )));
        } else if (type.value === "number") {
            extra.append(el("input", {
                type: "number", class: "field-min", placeholder: "Minimum (optional)",
                value: field.min !== undefined ? field.min : ""
            }));
        } else if (type.value === "table") {
            const cols = el("div", { class: "table-col-list" });
            const srcCols = field.columns && field.columns.length ? field.columns : [{ type: "text" }];
            /* A computed column stores input column *keys*; the editor
               works in labels, so map them back for display. */
            const keyToLabel = {};
            for (const c of srcCols) if (c.key) keyToLabel[c.key] = c.label;
            for (const c of srcCols) {
                if (c.type === "computed" && Array.isArray(c.inputs)) {
                    c._inputLabels = c.inputs.map((k) => keyToLabel[k] || k);
                }
            }
            srcCols.forEach((c) => cols.append(columnRow(c)));
            const addCol = el("button", { type: "button", class: "btn", text: "+ Add column" });
            addCol.addEventListener("click", () => cols.append(columnRow()));
            extra.append(el("div", { class: "table-col-editor" }, [
                el("span", { class: "field-hint", text: "Columns of the repeating grid:" }),
                cols, addCol
            ]));
        }
    }

    type.addEventListener("change", paintExtra);
    paintExtra();

    row.append(
        el("div", { class: "field-row-move" }, [up, down]),
        el("div", { class: "field-row-main" }, [
            label,
            type,
            section,
            el("label", { class: "field-row-required" }, [required, " Required"]),
            remove
        ]),
        extra
    );

    return row;
}

/* Reads one row back into the field shape the server expects,
   assigning a key only the first time a field is ever saved - an
   existing field keeps the key it was created with even if its label
   changes later, so records already captured under it stay matched
   up to it. */
export function readFieldRow(row, takenKeys) {
    const label = row.querySelector(".field-row-main input[type=text]").value.trim();
    const type = row.querySelector(".field-row-main select").value;
    const required = row.querySelector(".field-row-required input").checked;

    const field = {
        key: row.dataset.key || slugify(label, takenKeys),
        label,
        type
    };
    if (required) field.required = true;

    const section = row.querySelector(".field-section")?.value.trim();
    if (section) field.section = section;

    if (type === "select") {
        const raw = row.querySelector(".field-options")?.value || "";
        field.options = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (type === "link") {
        field.target = row.querySelector(".field-target")?.value;
    } else if (type === "number") {
        const raw = row.querySelector(".field-min")?.value;
        if (raw !== "" && raw !== undefined) field.min = Number(raw);
    } else if (type === "table") {
        const colKeys = new Set();
        const cells = [...row.querySelectorAll(".table-col-row")]
            .map((cr) => ({
                cr,
                label: cr.querySelector(".col-label").value.trim(),
                type: cr.querySelector(".col-type").value
            }))
            .filter((c) => c.label);

        /* Assign keys first so a computed column can resolve the input
           labels the user typed to their sibling columns' keys. */
        const labelToKey = {};
        for (const c of cells) {
            c.key = slugify(c.label, colKeys);
            labelToKey[c.label.toLowerCase()] = c.key;
        }

        field.columns = cells.map((c) => {
            const col = { key: c.key, label: c.label, type: c.type };
            if (c.type === "select") {
                col.options = (c.cr.querySelector(".col-options")?.value || "")
                    .split(",").map((s) => s.trim()).filter(Boolean);
            } else if (c.type === "computed") {
                col.compute = c.cr.querySelector(".col-compute")?.value === "sum" ? "sum" : "product";
                col.inputs = (c.cr.querySelector(".col-inputs")?.value || "")
                    .split(",").map((s) => s.trim()).filter(Boolean)
                    .map((lbl) => labelToKey[lbl.toLowerCase()]).filter(Boolean);
                const nums = (c.cr.querySelector(".col-thresholds")?.value || "")
                    .split(",").map((s) => s.trim()).filter((s) => s !== "")
                    .map(Number).filter((n) => Number.isFinite(n));
                if (nums.length) {
                    col.thresholds = {};
                    if (nums[0] != null) col.thresholds.warn = nums[0];
                    if (nums[1] != null) col.thresholds.crit = nums[1];
                }
            }
            return col;
        });
    }

    return field;
}

function openFieldEditor(definition) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });
    const list = el("div", { class: "field-row-list" });

    for (const field of definition.fields) {
        list.append(buildFieldRow(field));
    }

    const addButton = el("button", { class: "btn", type: "button" }, "+ Add field");
    addButton.addEventListener("click", () => {
        list.append(buildFieldRow({ type: "text" }));
        list.lastElementChild.querySelector("input[type=text]").focus();
    });

    const save = el("button", { class: "btn btn-primary", type: "button" }, "Save and publish");
    const cancel = el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel");

    save.addEventListener("click", async () => {
        errorBox.hidden = true;

        const takenKeys = new Set(
            [...list.children].map((row) => row.dataset.key).filter(Boolean)
        );

        const fields = [...list.children].map((row) => readFieldRow(row, takenKeys));
        const missingLabel = fields.some((f) => !f.label);

        if (fields.length === 0) {
            errorBox.textContent = "At least one field is required.";
            errorBox.hidden = false;
            return;
        }
        if (missingLabel) {
            errorBox.textContent = "Every field needs a label.";
            errorBox.hidden = false;
            return;
        }
        const badSelect = fields.find((f) => f.type === "select" && f.options.length === 0);
        if (badSelect) {
            errorBox.textContent = "\"" + badSelect.label + "\" needs at least one option.";
            errorBox.hidden = false;
            return;
        }
        const badTable = fields.find((f) => f.type === "table" && (!f.columns || f.columns.length === 0));
        if (badTable) {
            errorBox.textContent = "\"" + badTable.label + "\" needs at least one column.";
            errorBox.hidden = false;
            return;
        }
        const badComputed = fields
            .flatMap((f) => (f.type === "table" ? f.columns || [] : []))
            .find((c) => c.type === "computed" && (!c.inputs || c.inputs.length === 0));
        if (badComputed) {
            errorBox.textContent = "\"" + badComputed.label
                + "\" must compute from at least one number column - check the column labels you listed.";
            errorBox.hidden = false;
            return;
        }

        save.disabled = true;
        save.textContent = "Saving...";

        try {
            const result = await api.updateRecordForm(definition.key, fields);
            node.close();
            toast("Published version " + result.version + " of the " + definition.name + " form");
            await renderForms();
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            save.disabled = false;
            save.textContent = "Save and publish";
        }
    });

    node.replaceChildren(
        el("div", { class: "modal-head" }, [
            el("h2", { class: "modal-title", text: "Edit " + definition.name + " fields" }),
            el("span", { class: "panel-note", text: "Saving publishes a new version. Existing records keep the version they were raised under." })
        ]),
        el("div", { class: "modal-body" }, [errorBox, list, addButton]),
        el("div", { class: "modal-foot" }, [cancel, save])
    );

    node.showModal();
}
