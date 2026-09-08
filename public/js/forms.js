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
                text: "Save the record, then attach files from its Attachments section."
            }));
            return { wrapper, input, field };

        case "table": {
            /* A repeating grid: one field, an array of row objects. The
               columns come from the schema; each cell is a small input
               typed by its column. */
            const columns = Array.isArray(field.columns) ? field.columns : [];
            const body = el("tbody");

            const cellInput = (column, value) => {
                if (column.type === "memo") {
                    const t = el("textarea", { rows: 1 });
                    if (value != null) t.value = String(value);
                    return t;
                }
                if (column.type === "select") {
                    const s = el("select", {}, [
                        el("option", { value: "", text: "—" }),
                        ...(column.options || []).map((o) => el("option", { value: o, text: o }))
                    ]);
                    s.value = value != null ? String(value) : "";
                    return s;
                }
                if (column.type === "computed") {
                    /* Filled in by recompute(), never typed into. */
                    const i = el("input", {
                        type: "number", class: "computed-cell", readonly: "readonly", tabindex: "-1",
                        title: describeComputed(column, columns)
                    });
                    if (value != null && value !== "") i.value = String(value);
                    return i;
                }
                const i = el("input", {
                    type: column.type === "number" ? "number"
                        : column.type === "date" ? "date" : "text"
                });
                if (value != null && value !== "") {
                    i.value = column.type === "date" ? String(value).slice(0, 10) : String(value);
                }
                return i;
            };

            const hasComputed = columns.some((c) => c.type === "computed");

            const addRow = (seed = {}) => {
                const tr = el("tr");
                const cellByKey = {};
                for (const column of columns) {
                    const input = cellInput(column, seed[column.key]);
                    cellByKey[column.key] = input;
                    tr.append(el("td", {}, input));
                }
                tr.append(el("td", {}, el("button", {
                    class: "btn sm no-print", type: "button", text: "×",
                    "aria-label": "Remove row", onClick: () => tr.remove()
                })));

                if (hasComputed) {
                    const recompute = () => {
                        for (const column of columns) {
                            if (column.type !== "computed") continue;
                            const cell = cellByKey[column.key];
                            const nums = (column.inputs || []).map((k) => Number(cellByKey[k]?.value));
                            const ready = nums.length > 0 && nums.every((n) => Number.isFinite(n));
                            const out = !ready ? "" : column.compute === "sum"
                                ? nums.reduce((a, b) => a + b, 0)
                                : nums.reduce((a, b) => a * b, 1);
                            cell.value = out === "" ? "" : String(out);
                            paintThreshold(cell, column, out);
                        }
                    };
                    tr.addEventListener("input", recompute);
                    tr.addEventListener("change", recompute);
                    recompute();
                }

                body.append(tr);
            };

            const seedRows = Array.isArray(currentValue) ? currentValue : [];
            (seedRows.length ? seedRows : [{}]).forEach(addRow);

            const table = el("table", { class: "dim-repeater" }, [
                el("thead", {}, el("tr", {}, [
                    ...columns.map((c) => el("th", { text: c.label })),
                    el("th", {})
                ])),
                body
            ]);
            const addBtn = el("button", {
                class: "btn sm no-print", type: "button", text: "+ Add row",
                onClick: () => addRow({})
            });

            /* ---------- paste from Excel + keyboard nav (P0.4) ---------- */

            const cellsInRow = (tr) => [...tr.querySelectorAll("input, select, textarea")];
            /* Cells a person can actually type in - excludes the computed
               cells, which carry tabindex="-1". */
            const typeableCells = (tr) => cellsInRow(tr).filter((c) => c.tabIndex !== -1);

            /* Pasting a block copied from a spreadsheet fills rows and
               columns from the cell it lands in, adding rows as needed.
               A plain single value is left to the browser. Computed
               columns keep their spot in the alignment but are never
               written to - they recompute from the numbers around them. */
            body.addEventListener("paste", (event) => {
                const cell = event.target.closest("input, select, textarea");
                if (!cell || !body.contains(cell)) return;

                const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
                if (!/[\t\n\r]/.test(text)) return;
                event.preventDefault();

                const grid = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
                    .split("\n").map((line) => line.split("\t"));

                const startTr = cell.closest("tr");
                const startRow = [...body.children].indexOf(startTr);
                const startCol = cellsInRow(startTr).indexOf(cell);
                if (startRow < 0 || startCol < 0) return;

                grid.forEach((values, r) => {
                    let tr = body.children[startRow + r];
                    if (!tr) { addRow({}); tr = body.lastElementChild; }
                    const cells = cellsInRow(tr);
                    values.forEach((value, c) => {
                        const target = cells[startCol + c];
                        const column = columns[startCol + c];
                        if (!target || !column || column.type === "computed") return;
                        target.value = String(value).trim();
                        target.dispatchEvent(new Event("input", { bubbles: true }));
                        target.dispatchEvent(new Event("change", { bubbles: true }));
                    });
                });

                const anchor = cellsInRow(body.children[startRow])[startCol];
                if (anchor) anchor.focus();
            });

            body.addEventListener("keydown", (event) => {
                const cell = event.target.closest("input, select, textarea");
                if (!cell) return;
                const tr = cell.closest("tr");
                if (!tr || tr.parentElement !== body) return;

                const rows = [...body.children];
                const rowIndex = rows.indexOf(tr);
                const typeable = typeableCells(tr);
                const colIndex = typeable.indexOf(cell);
                if (colIndex < 0) return;

                /* Enter moves down the column (Shift+Enter up); on the
                   last row it makes a new one. Left alone in a textarea,
                   where Enter is a newline. */
                if (event.key === "Enter" && cell.tagName !== "TEXTAREA") {
                    event.preventDefault();
                    const step = event.shiftKey ? -1 : 1;
                    let nextTr = rows[rowIndex + step];
                    if (step === 1 && !nextTr) { addRow({}); nextTr = body.lastElementChild; }
                    if (nextTr) {
                        const nextCells = typeableCells(nextTr);
                        (nextCells[colIndex] || nextCells[0]).focus();
                    }
                    return;
                }

                /* Tab off the last cell of the last row adds a row and
                   lands in it, so a table fills top to bottom without
                   reaching for the mouse. */
                if (event.key === "Tab" && !event.shiftKey
                    && colIndex === typeable.length - 1 && rowIndex === rows.length - 1) {
                    event.preventDefault();
                    addRow({});
                    const newCells = typeableCells(body.lastElementChild);
                    (newCells[0] || cell).focus();
                }
            });

            /* A wide table (a PFMEA can carry a dozen columns) scrolls
               inside its own box rather than pushing the whole form
               sideways with no way back. */
            wrapper.append(
                el("div", { class: "table-wrap" }, table),
                addBtn,
                el("span", { class: "field-hint", text: "Tab and Enter move between cells. Paste a block straight from Excel." })
            );

            const readTable = () => [...body.querySelectorAll("tr")].map((tr) => {
                const inputs = tr.querySelectorAll("input, select, textarea");
                const row = {};
                let any = false;
                columns.forEach((column, index) => {
                    const raw = (inputs[index]?.value ?? "").trim();
                    if (raw === "") return;
                    /* A computed cell alone does not make a row worth keeping. */
                    if (column.type !== "computed") any = true;
                    row[column.key] = (column.type === "number" || column.type === "computed")
                        ? Number(raw) : raw;
                });
                return any ? row : null;
            }).filter(Boolean);

            return { wrapper, input: null, field, readTable };
        }

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

/* Turns the handful of patterns actually in use into something a
   person can act on. An unrecognised one is shown as written rather
   than guessed at. */
function describePattern(pattern) {
    if (pattern === "^L-[0-9]{5}$") return "L- followed by five digits, for example L-88213";
    return pattern;
}

/* "RPN = Severity x Occurrence x Detection" - the tooltip on a
   computed cell so a reader knows where its number comes from. */
function describeComputed(column, columns) {
    const labelOf = (k) => (columns.find((c) => c.key === k) || {}).label || k;
    const join = column.compute === "sum" ? " + " : " × ";
    return column.label + " = " + (column.inputs || []).map(labelOf).join(join);
}

/* A computed cell wears an amber / red class once it crosses the
   thresholds the column defines (RPN >= 100, >= 150). */
function paintThreshold(cell, column, value) {
    cell.classList.remove("rpn-warn", "rpn-crit");
    const t = column.thresholds;
    const n = Number(value);
    if (!t || value === "" || !Number.isFinite(n)) return;
    if (t.crit != null && n >= t.crit) cell.classList.add("rpn-crit");
    else if (t.warn != null && n >= t.warn) cell.classList.add("rpn-warn");
}

export function readValue(entry) {
    if (entry.field.type === "table") {
        const rows = entry.readTable ? entry.readTable() : [];
        return rows.length ? rows : undefined;
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
            problems.push(field.type === "table"
                ? field.label + " needs at least one row"
                : field.label + " is required");
            continue;
        }

        if (value === undefined || field.type === "table") continue;

        if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
            problems.push(field.label + " must be " + describePattern(field.pattern));
        }

        if (field.min !== undefined && Number(value) < field.min) {
            problems.push(field.label + " must be at least " + field.min);
        }

        if (input && input.disabled && field.required) {
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
