/* ============================================================
   Record forms, built from the schema the server publishes.

   Nothing here knows what an NCR contains. It reads the field list
   from /api/record-types/<key>/form and renders whatever it finds,
   so adding a field in the Form Builder adds it to this form without
   a line of UI code changing. That is the whole promise of the
   configurable layer, made real.

   Uses the native <dialog>, which brings focus trapping, Escape to
   close and the backdrop with it.
   ============================================================ */

import { api } from "./api.js";
import { currentUser } from "./session.js";
import { el, toast } from "./dom.js";

/* ---------- one dialog, reused ---------- */

let dialog = null;

export function ensureDialog() {
    if (dialog) return dialog;

    dialog = el("dialog", { class: "modal" });
    document.body.append(dialog);

    /* Clicking the backdrop closes. The dialog element reports clicks
       on the backdrop as clicks on itself, so compare the target. */
    dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
    });

    return dialog;
}

/* ---------- field rendering ---------- */

/* currentValue is undefined when raising a new record, and whatever
   is already stored under field.key when editing one - the only
   difference between the two forms is which values arrive filled in. */
export function buildField(field, options, currentValue) {
    const id = "field-" + field.key;
    const wrapper = el("div", { class: "field-group" });

    wrapper.append(el("label", { for: id }, [
        field.label,
        field.required ? el("span", { class: "req", text: " *" }) : null
    ]));

    let input;

    switch (field.type) {
        case "memo":
            input = el("textarea", { id, name: field.key, rows: 3, text: currentValue ?? "" });
            break;

        case "number":
            input = el("input", {
                type: "number", id, name: field.key, step: "any",
                value: currentValue ?? ""
            });
            if (field.min !== undefined) input.min = field.min;
            break;

        case "date":
            input = el("input", {
                type: "date", id, name: field.key,
                value: currentValue ? String(currentValue).slice(0, 10) : ""
            });
            break;

        case "select":
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...(field.options || []).map((value) => el("option", {
                    value, text: value,
                    selected: currentValue === value ? "selected" : undefined
                }))
            ]);
            break;

        case "link": {
            const list = options[field.target] || [];
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...list.map((item) => {
                    const option = el("option", {
                        value: item.value, text: item.label,
                        selected: currentValue === item.value ? "selected" : undefined
                    });
                    /* A gage past its calibration date, or on hold after
                       failing one, cannot be used to judge a part. The
                       form rule says block; this is where that becomes
                       visible, and why is whatever the server actually
                       says it is - a hold from a failed calibration is
                       not the same fact as one that just expired. */
                    if (item.disabled) {
                        option.disabled = true;
                        option.textContent = item.label + "  (" + (item.disabled_reason || "unavailable") + ")";
                    }
                    return option;
                })
            ]);
            break;
        }

        case "user": {
            const list = options.users || [];
            input = el("select", { id, name: field.key }, [
                el("option", { value: "", text: "Choose..." }),
                ...list.map((item) => el("option", { value: item.value, text: item.label }))
            ]);
            break;
        }

        case "signature": {
            /* Editing a record must not silently re-sign it in whoever
               happens to be making the correction - the stored value,
               once there is one, wins. Only a brand-new record signs
               as the person raising it. */
            const me = currentUser();
            const signed = currentValue || (me ? me.name + " - " + me.role_name : "");
            input = el("input", {
                type: "text", id, name: field.key, value: signed,
                readonly: "readonly", class: "readonly"
            });
            wrapper.append(input);
            wrapper.append(el("span", {
                class: "field-hint",
                text: currentValue ? "Signed when this record was created." : "Signed as you, with the time, when you save."
            }));
            return { wrapper, input, field };
        }

        case "file":
            input = el("input", { type: "text", id, name: field.key, disabled: "disabled" });
            wrapper.append(input);
            wrapper.append(el("span", {
                class: "field-hint",
                text: "Attachments are not built yet."
            }));
            return { wrapper, input, field };

        case "table":
            return buildTableField(field, wrapper, currentValue);

        default:
            input = el("input", { type: "text", id, name: field.key, value: currentValue ?? "" });
            if (field.pattern) input.pattern = field.pattern;
    }

    if (field.required) input.required = true;

    wrapper.append(input);

    if (field.pattern) {
        wrapper.append(el("span", {
            class: "field-hint",
            text: "Format: " + describePattern(field.pattern)
        }));
    }

    return { wrapper, input, field };
}

/* A "table" field: DFMEA, PFMEA, control plan, process flow diagram
   - a real repeating-row grid instead of a memo standing in for one.
   currentValue, when present, is the array of row objects already
   stored under field.key; a brand-new record starts with one blank
   row rather than none, so the table is never presented empty with
   no visible way to begin.

   The row-building logic lives here rather than being spread across
   readValue/validate: a table field's "input" is the whole <table>,
   not one control, so those two functions special-case field.type
   === "table" and call back into rowsFrom() below instead of reading
   a single element's .value. */
function buildTableField(field, wrapper, currentValue) {
    const columns = field.columns || [];
    const table = el("table", { class: "field-table" });
    const tbody = el("tbody");

    table.append(
        el("thead", {}, el("tr", {}, [
            ...columns.map((column) => el("th", { text: column.label })),
            el("th", { text: "" })
        ])),
        tbody
    );

    /* Severity x occurrence x detection = RPN is exactly the
       computation already made real for the Risk record type
       (withComputedRpn, server-side) - mirrored here only so a row
       being typed shows its own number back immediately. The server
       recomputes it again on save regardless, so a value typed
       directly into a "computed" column here never actually sticks;
       nothing but that recalculation is authoritative. */
    function recomputeRpn(tr) {
        const rpnInput = tr.querySelector('input[data-col="rpn"]');
        if (!rpnInput) return;

        const read = (key) => {
            const cell = tr.querySelector('input[data-col="' + key + '"]');
            const n = cell ? Number(cell.value) : NaN;
            return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
        };

        const [s, o, d] = [read("severity"), read("occurrence"), read("detection")];
        rpnInput.value = (s !== null && o !== null && d !== null) ? String(s * o * d) : "";
    }

    function addRow(initial) {
        const tr = el("tr");

        for (const column of columns) {
            const raw = initial ? initial[column.key] : undefined;
            const computed = column.key === "rpn"
                && columns.some((c) => c.key === "severity")
                && columns.some((c) => c.key === "occurrence")
                && columns.some((c) => c.key === "detection");

            let cellInput;
            if (column.type === "number") {
                cellInput = el("input", {
                    type: "number", step: "any", "data-col": column.key,
                    value: raw ?? ""
                });
            } else if (column.type === "date") {
                cellInput = el("input", {
                    type: "date", "data-col": column.key,
                    value: raw ? String(raw).slice(0, 10) : ""
                });
            } else {
                cellInput = el("input", { type: "text", "data-col": column.key, value: raw ?? "" });
            }

            if (computed) {
                cellInput.readOnly = true;
                cellInput.classList.add("readonly");
                cellInput.title = "Severity x occurrence x detection - recalculated on save";
            } else {
                cellInput.addEventListener("input", () => recomputeRpn(tr));
            }

            tr.append(el("td", {}, cellInput));
        }

        const remove = el("button", { type: "button", class: "btn btn-xs btn-danger", text: "Remove" });
        remove.addEventListener("click", () => {
            tr.remove();
            if (tbody.children.length === 0) addRow(null);
        });
        tr.append(el("td", { class: "table-row-remove" }, remove));

        tbody.append(tr);
        recomputeRpn(tr);
    }

    if (Array.isArray(currentValue) && currentValue.length > 0) {
        currentValue.forEach((row) => addRow(row));
    } else {
        addRow(null);
    }

    const addButton = el("button", { type: "button", class: "btn btn-xs", text: "+ Add row" });
    addButton.addEventListener("click", () => addRow(null));

    wrapper.append(el("div", { class: "field-table-wrap table-wrap" }, table), addButton);

    return { wrapper, input: table, field };
}

/* Every non-empty cell in a row counts as "the row has something in
   it" - a row where someone only typed a severity and nothing else
   is still real, partial data, not yet worth discarding. A row where
   every cell was left blank (the default extra row an empty table
   starts with, if it is never used) is the one case actually meant
   to be dropped rather than saved as an empty object. */
function rowsFromTable(tableEl) {
    const rows = [];

    for (const tr of tableEl.querySelectorAll("tbody tr")) {
        const row = {};
        let hasValue = false;

        for (const cellInput of tr.querySelectorAll("input[data-col]")) {
            const value = cellInput.value;
            if (value === "") continue;

            row[cellInput.dataset.col] = cellInput.type === "number" ? Number(value) : value;
            hasValue = true;
        }

        if (hasValue) rows.push(row);
    }

    return rows;
}

/* Turns the handful of patterns actually in use into something a
   person can act on. An unrecognised one is shown as written rather
   than guessed at. */
function describePattern(pattern) {
    if (pattern === "^L-[0-9]{5}$") return "L- followed by five digits, for example L-88213";
    return pattern;
}

export function readValue(entry) {
    if (entry.field.type === "table") {
        const rows = rowsFromTable(entry.input);
        return rows.length > 0 ? rows : undefined;
    }

    const raw = entry.input.value;

    if (raw === "" || raw === null) return undefined;
    if (entry.field.type === "number") return Number(raw);

    return raw;
}

export function validate(entries) {
    const problems = [];

    for (const entry of entries) {
        const { field, input } = entry;
        const value = readValue(entry);

        if (field.required && value === undefined && field.type !== "file") {
            problems.push(field.label + " is required");
            continue;
        }

        if (value === undefined) continue;

        if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
            problems.push(field.label + " must be " + describePattern(field.pattern));
        }

        if (field.min !== undefined && Number(value) < field.min) {
            problems.push(field.label + " must be at least " + field.min);
        }

        if (input.disabled && field.required) {
            problems.push(field.label + " cannot be set yet");
        }
    }

    return problems;
}

/* ---------- full page: create or edit a record ----------

   Every type shares one screen (index.html's #view-record-editor)
   rather than one dialog per type, because the fields are schema-
   driven either way - the only thing that differs between "New NCR"
   and "Edit NCR-2026-0142" is whether values arrive already filled
   in and whether the save button calls create or update. */

const SEVERITY_OPTIONS = [["ok", "OK"], ["warn", "Warning"], ["crit", "Critical"]];

/* Where "Cancel" and "Back" return to, and where a successful save
   lands. Set on every open rather than read once, since the same
   screen is reached from a different register each time. */
let returnView = null;

export function wireRecordEditor() {
    const back = document.getElementById("record-editor-back");
    if (!back) return;

    back.addEventListener("click", () => {
        if (returnView) {
            document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
        }
    });
}

/* Fields are rendered in the order the form defines, and an optional
   field.section starts a new labelled group whenever it changes -
   the same section-label look already used for "Linked records" and
   "Permission matrix" elsewhere in the app, not a new visual idiom. */
function appendFieldsGrouped(container, entries) {
    let lastSection;
    let first = true;

    for (const entry of entries) {
        const section = entry.field.section || null;

        if (first || section !== lastSection) {
            if (section) container.append(el("div", { class: "section-label", text: section }));
            lastSection = section;
            first = false;
        }

        container.append(entry.wrapper);
    }
}

export async function openRecordEditor(typeKey, { number, onSaved, returnView: fromView } = {}) {
    if (fromView) returnView = fromView;

    const body = document.getElementById("record-editor-body");
    const titleEl = document.getElementById("record-editor-title");
    const subEl = document.getElementById("record-editor-sub");
    if (!body) return;

    body.replaceChildren(el("p", { class: "sm dim", text: "Loading..." }));

    let definition;
    let existing = null;

    try {
        definition = await api.recordForm(typeKey);
        if (number) {
            const result = await api.record(number);
            existing = result.record;
        }
    } catch (error) {
        body.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        return;
    }

    if (titleEl) titleEl.textContent = existing ? "Edit " + existing.number : "New " + definition.name;
    if (subEl) {
        subEl.textContent = "Clause " + (definition.clause || "-")
            + (existing ? " - form v" + existing.form_version : " - form v" + definition.version);
    }

    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const entries = definition.fields.map((field) =>
        buildField(field, definition.options, existing ? existing.data[field.key] : undefined)
    );

    const titleInput = el("input", {
        type: "text", id: "field-title", name: "title", required: true,
        placeholder: "What is wrong, in one line",
        value: existing ? existing.title : ""
    });

    const titleGroup = el("div", { class: "field-group" }, [
        el("label", { for: "field-title" }, ["Summary", el("span", { class: "req", text: " *" })]),
        titleInput,
        el("span", { class: "field-hint", text: "This is what appears in the register." })
    ]);

    const severitySelect = el("select", { id: "field-severity", name: "severity" },
        SEVERITY_OPTIONS.map(([value, label]) => el("option", {
            value, text: label,
            selected: (existing ? existing.severity : "warn") === value ? "selected" : undefined
        }))
    );

    const severityGroup = el("div", { class: "field-group" }, [
        el("label", { for: "field-severity", text: "Severity" }),
        severitySelect
    ]);

    /* Due date lives on the record itself (records.due_at), not in the
       type-specific data payload, so it is asked for here once rather
       than as a per-type field every form has to remember to declare -
       every register's overdue colouring reads this same column. */
    const dueInput = el("input", {
        type: "date", id: "field-due-at", name: "due_at",
        value: existing && existing.due_at ? existing.due_at.slice(0, 10) : ""
    });

    const dueGroup = el("div", { class: "field-group" }, [
        el("label", { for: "field-due-at", text: "Due date" }),
        dueInput,
        el("span", { class: "field-hint", text: "Optional. Drives the overdue colouring in the register." })
    ]);

    const saveLabel = existing ? "Save changes" : "Raise " + definition.name;
    const save = el("button", { class: "btn btn-primary", type: "submit" }, saveLabel);

    const cancel = el("button", { class: "btn", type: "button" }, "Cancel");
    cancel.addEventListener("click", () => {
        if (returnView) document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
    });

    const form = el("form", {}, [errorBox, titleGroup, severityGroup, dueGroup]);
    appendFieldsGrouped(form, entries);
    form.append(el("div", { class: "row", style: "margin-top:18px" }, [save, cancel]));

    body.replaceChildren(form);

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = validate(entries);
        if (!titleInput.value.trim()) problems.unshift("Summary is required");

        if (problems.length > 0) {
            errorBox.replaceChildren(...problems.map((text) => el("div", { text })));
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
        }

        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }

        save.disabled = true;
        save.textContent = "Saving...";

        try {
            let result;

            if (existing) {
                result = await api.updateRecord(existing.number, {
                    title: titleInput.value.trim(),
                    severity: severitySelect.value,
                    due_at: dueInput.value || null,
                    data
                });
                toast(result.number + " updated");
            } else {
                const me = currentUser();
                result = await api.createRecord({
                    type: definition.key,
                    title: titleInput.value.trim(),
                    owner: me ? me.initials : undefined,
                    severity: severitySelect.value,
                    due_at: dueInput.value || undefined,
                    data
                });
                toast(result.number + " created");
            }

            if (onSaved) await onSaved(result);
            if (returnView) document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
        } catch (error) {
            /* The server validates everything again. When it disagrees,
               it is right, and it names the fields. */
            const fields = error.payload?.fields;
            errorBox.replaceChildren(
                el("div", { text: error.message }),
                fields ? el("div", { class: "sm", text: "Missing: " + fields.join(", ") }) : null
            );
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
        } finally {
            save.disabled = false;
            save.textContent = saveLabel;
        }
    });

    titleInput.focus();
}

/* ---------- a small confirm, for workflow moves ---------- */

export function confirmStep({ title, body, confirmLabel, onConfirm }) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const reason = el("textarea", { id: "step-reason", rows: 2,
        placeholder: "Optional. Recorded against this change." });

    const go = el("button", { class: "btn btn-primary", type: "button" }, confirmLabel);

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("p", { class: "sm", style: "margin:0 0 14px", text: body }),
            el("div", { class: "field-group" }, [
                el("label", { for: "step-reason", text: "Reason" }),
                reason
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            go
        ])
    );

    go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Working...";

        try {
            await onConfirm(reason.value.trim() || null);
            node.close();
            toast(title);
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = confirmLabel;
        }
    });

    node.showModal();
}

/* ---------- setting or changing a due date ---------- */

export function editDueDate({ title, currentValue, onSave }) {
    const node = ensureDialog();
    const errorBox = el("div", { class: "signin-error", hidden: "hidden" });

    const dateInput = el("input", {
        type: "date",
        value: currentValue ? currentValue.slice(0, 10) : ""
    });

    const go = el("button", { class: "btn btn-primary", type: "button" }, "Save");

    node.replaceChildren(
        el("div", { class: "modal-head" }, el("h2", { class: "modal-title", text: title })),
        el("div", { class: "modal-body" }, [
            errorBox,
            el("div", { class: "field-group" }, [
                el("label", { for: "due-date-input", text: "Due date" }),
                dateInput,
                el("span", { class: "field-hint", text: "Leave blank to clear it." })
            ])
        ]),
        el("div", { class: "modal-foot" }, [
            el("button", { class: "btn", type: "button", onClick: () => node.close() }, "Cancel"),
            go
        ])
    );

    go.addEventListener("click", async () => {
        go.disabled = true;
        go.textContent = "Saving...";

        try {
            await onSave(dateInput.value || null);
            node.close();
            toast(dateInput.value ? "Due date set" : "Due date cleared");
        } catch (error) {
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        } finally {
            go.disabled = false;
            go.textContent = "Save";
        }
    });

    node.showModal();
}
