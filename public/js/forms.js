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
import { beginEditing } from "./presence.js";
import { buildUploader } from "./attach-upload.js";
import { openFileWindow } from "./doc-windows.js";
import { evaluate as evalExpr, identifiers as exprIdentifiers } from "./expr.js";

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
   difference between the two forms is which values arrive filled in.
   context carries the record number when editing an existing record,
   so a table with rowAttachments can offer a per-row file button. */
export function buildField(field, options, currentValue, context = {}) {
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
            if (field.thresholds) {
                const repaint = () => paintThreshold(input, field, input.value);
                input.addEventListener("input", repaint);
                repaint();
            }
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

        case "boolean": {
            input = el("input", { type: "checkbox", id, name: field.key });
            input.checked = currentValue === true || currentValue === "true";
            wrapper.append(input);
            return { wrapper, input, field };
        }

        case "link": {
            /* target:"record" links to another record; when it is
               narrowed to a type the options come keyed "record:<type>" */
            const optKey = field.target === "record" && field.record_type
                ? "record:" + field.record_type : field.target;
            const list = options[optKey] || [];
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
            /* A signature is sealed by the server - who, when, which
               form version, and a hash of the rest of the form. Once
               set it is never re-signed by an edit; until then, the
               person completing the record ticks to sign as themself. */
            const me = currentUser();
            const sealed = currentValue && typeof currentValue === "object" && currentValue.signer
                ? currentValue
                : (currentValue ? { signer: String(currentValue), legacy: true } : null);

            if (sealed) {
                input = el("input", {
                    type: "text", id, name: field.key, readonly: "readonly", class: "readonly",
                    value: sealed.signer
                        + (sealed.role ? " (" + sealed.role + ")" : "")
                        + (sealed.at ? " - " + new Date(sealed.at).toLocaleString() : "")
                });
                wrapper.append(input);
                wrapper.append(el("span", { class: "field-hint",
                    text: sealed.legacy
                        ? "Signed (legacy record)."
                        : "Signed. Any change to the record after this is flagged on its detail view." }));
                return { wrapper, input, field };
            }

            input = el("input", { type: "checkbox", id, name: field.key });
            wrapper.append(el("label", { class: "check-inline" }, [
                input,
                el("span", { text: me ? "Sign as " + me.name + (me.role_name ? " (" + me.role_name + ")" : "") : "Sign" })
            ]));
            wrapper.append(el("span", { class: "field-hint",
                text: "The server records who and when, and seals it against later edits." }));
            return { wrapper, input, field };
        }

        case "file": {
            /* A field-scoped file slot: its uploads are ordinary record
               attachments tagged row_ref = "<fieldKey>:_", so they show
               grouped under this field on the detail view. */
            input = el("input", { type: "hidden", id, name: field.key });
            if (context.recordNumber) {
                const btn = el("button", {
                    class: "btn sm", type: "button", text: "📎 Files for “" + field.label + "”",
                    onClick: () => openRowAttachments(
                        context.recordNumber, field.key + ":_", field.label)
                });
                wrapper.append(btn);
            } else {
                wrapper.append(el("input", { type: "text", disabled: "disabled", class: "readonly" }));
                wrapper.append(el("span", { class: "field-hint",
                    text: "Save the record, then attach files here." }));
            }
            return { wrapper, input, field };
        }

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
                if (column.type === "boolean") {
                    const c = el("input", { type: "checkbox" });
                    c.checked = value === true || value === "true";
                    return c;
                }
                if (column.type === "user") {
                    const s = el("select", {}, [
                        el("option", { value: "", text: "—" }),
                        ...(((options && options.users) || []).map((o) =>
                            el("option", { value: o.value, text: o.label })))
                    ]);
                    s.value = value != null ? String(value) : "";
                    return s;
                }
                if (column.type === "number" && column.thresholds) {
                    const i = el("input", { type: "number", step: "any" });
                    if (value != null && value !== "") i.value = String(value);
                    const repaint = () => paintThreshold(i, column, i.value);
                    i.addEventListener("input", repaint);
                    repaint();
                    return i;
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
            /* A form with many columns is miserable to fill in a
               horizontal-scrolling grid, so those rows also get a
               "open as a form" drawer. */
            const wide = columns.length > 6;

            const rowIsEmpty = (tr) => columns.every((c) => {
                if (c.type === "computed") return true;
                const cell = tr._cells[c.key];
                if (c.type === "boolean") return !cell?.checked;
                return !(cell?.value || "").trim();
            });

            const canRowAttach = Boolean(field.rowAttachments && context.recordNumber);

            const addRow = (seed = {}) => {
                const tr = el("tr");
                /* Stable per-row id, assigned by the server on save. A row
                   built here without one gets its id on the next save;
                   readTable passes an existing id straight back through. */
                tr._rowId = (seed && typeof seed._id === "string" && seed._id) ? seed._id : null;
                const cellByKey = {};
                const tdByKey = {};
                for (const column of columns) {
                    const input = cellInput(column, seed[column.key]);
                    cellByKey[column.key] = input;
                    const td = el("td", {}, input);
                    tdByKey[column.key] = td;
                    tr.append(td);
                }
                tr._cells = cellByKey;
                tr._tds = tdByKey;

                let recompute = null;
                if (hasComputed) {
                    recompute = () => {
                        /* the numbers this row currently holds, by column key */
                        const scope = {};
                        for (const c of columns) {
                            const v = Number(cellByKey[c.key]?.value);
                            if (Number.isFinite(v)) scope[c.key] = v;
                        }
                        for (const column of columns) {
                            if (column.type !== "computed") continue;
                            const cell = cellByKey[column.key];
                            let out;
                            if (typeof column.expr === "string" && column.expr.trim()) {
                                out = evalExpr(column.expr, scope);
                            } else {
                                const nums = (column.inputs || []).map((k) => scope[k]);
                                out = nums.length > 0 && nums.every((n) => Number.isFinite(n))
                                    ? (column.compute === "sum"
                                        ? nums.reduce((a, b) => a + b, 0)
                                        : nums.reduce((a, b) => a * b, 1))
                                    : undefined;
                            }
                            cell.value = out === undefined ? "" : String(out);
                            paintThreshold(cell, column, out === undefined ? "" : out);
                        }
                    };
                    tr.addEventListener("input", recompute);
                    tr.addEventListener("change", recompute);
                    recompute();
                }
                tr._recompute = recompute;

                const attachBtn = canRowAttach ? el("button", {
                    class: "btn sm no-print", type: "button", text: "📎",
                    title: tr._rowId ? "Files on this row" : "Save the record first, then attach",
                    "aria-label": "Row files",
                    disabled: tr._rowId ? undefined : "disabled",
                    onClick: () => openRowAttachments(
                        context.recordNumber, field.key + ":" + tr._rowId,
                        (field.label || "Row") + " row " + ([...body.children].indexOf(tr) + 1))
                }) : null;

                const actions = el("td", { class: "row-tools" }, [
                    attachBtn,
                    wide ? el("button", {
                        class: "btn sm no-print", type: "button", text: "⤡",
                        title: "Open this row as a form", "aria-label": "Expand row",
                        onClick: () => openRowDrawer(tr)
                    }) : null,
                    el("button", {
                        class: "btn sm no-print", type: "button", text: "×",
                        "aria-label": "Remove row", onClick: () => tr.remove()
                    })
                ]);
                tr.append(actions);

                body.append(tr);
                return tr;
            };

            /* One shared dialog: pull this row's real cell inputs into a
               stacked form, put them back on close (single source of
               truth - no mirroring). */
            function openRowDrawer(tr) {
                const node = ensureDialog();
                const idx = [...body.children].indexOf(tr) + 1;

                const groups = columns.map((column) => {
                    const input = tr._cells[column.key];
                    const g = el("div", { class: "field-group" }, [
                        el("label", { text: column.label || column.key }),
                        input
                    ]);
                    if (column.type === "computed") input.readOnly = true;
                    return g;
                });

                const form = el("form", {}, groups);
                form.addEventListener("input", () => tr._recompute && tr._recompute());
                form.addEventListener("change", () => tr._recompute && tr._recompute());

                /* Put the real inputs back where they came from - runs
                   once, however the dialog closes (button or Escape). */
                const restore = () => {
                    for (const column of columns) tr._tds[column.key].append(tr._cells[column.key]);
                    tr._recompute && tr._recompute();
                };

                node.replaceChildren(
                    el("div", { class: "modal-head" },
                        el("h2", { class: "modal-title", text: (field.label || "Row") + " - row " + idx })),
                    el("div", { class: "modal-body" }, form),
                    el("div", { class: "modal-foot" },
                        el("button", { class: "btn btn-primary", type: "button", text: "Done",
                            onClick: () => node.close() }))
                );
                node.addEventListener("close", restore, { once: true });
                node.showModal();
            }

            /* Replace every row - used when a saved draft is restored
               into an already-built form. */
            const writeTable = (rows) => {
                body.replaceChildren();
                (Array.isArray(rows) && rows.length ? rows : [{}]).forEach(addRow);
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
                        if (column.type === "boolean") {
                            target.checked = /^(1|x|y|yes|true|✓)$/i.test(String(value).trim());
                        } else {
                            target.value = String(value).trim();
                        }
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

            /* There is always one blank row waiting: the moment the
               last row gets any content, another appears - so a table
               fills continuously without stopping to click "add". */
            const ensureTrailingBlank = () => {
                const last = body.lastElementChild;
                if (last && !rowIsEmpty(last)) addRow({});
            };
            body.addEventListener("input", ensureTrailingBlank);
            body.addEventListener("change", ensureTrailingBlank);
            if (body.children.length === 0 || !rowIsEmpty(body.lastElementChild)) addRow({});

            /* A wide table (a PFMEA can carry a dozen columns) scrolls
               inside its own box rather than pushing the whole form
               sideways with no way back. */
            wrapper.append(
                el("div", { class: "table-wrap" }, table),
                el("div", { class: "row no-print", style: "gap:6px;margin-top:4px" }, [
                    addBtn,
                    el("button", { class: "btn sm no-print", type: "button", text: "+ 5 rows",
                        onClick: () => { for (let i = 0; i < 5; i++) addRow({}); } })
                ]),
                el("span", { class: "field-hint", text:
                    "Paste a block straight from Excel. Tab / Enter move between cells"
                    + (wide ? "; ⤡ opens a row as a form." : ".") })
            );

            const readTable = () => [...body.children].map((tr) => {
                const row = {};
                let any = false;
                for (const column of columns) {
                    const cell = tr._cells[column.key];
                    if (column.type === "boolean") {
                        if (cell?.checked) { row[column.key] = true; any = true; }
                        continue;
                    }
                    const raw = (cell?.value ?? "").trim();
                    if (raw === "") continue;
                    if (column.type !== "computed") any = true;
                    row[column.key] = (column.type === "number" || column.type === "computed")
                        ? Number(raw) : raw;
                }
                if (!any) return null;
                /* Carry the server-assigned row id straight back through
                   so a per-row attachment stays pinned across a save. */
                if (tr._rowId) row._id = tr._rowId;
                return row;
            }).filter(Boolean);

            return { wrapper, input: null, field, readTable, writeTable };
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
   computed cell so a reader knows where its number comes from. Works
   for both an expr column and a compute/inputs column. */
function describeComputed(column, columns) {
    const labelOf = (k) => (columns.find((c) => c.key === k) || {}).label || k;

    if (typeof column.expr === "string" && column.expr.trim()) {
        let text = column.expr;
        try {
            for (const id of exprIdentifiers(column.expr)) {
                text = text.replace(new RegExp("\\b" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "g"), labelOf(id));
            }
        } catch { /* unparseable - show it verbatim */ }
        return column.label + " = " + text.replace(/\*/g, " × ").replace(/\//g, " ÷ ");
    }

    const join = column.compute === "sum" ? " + " : " × ";
    return column.label + " = " + (column.inputs || []).map(labelOf).join(join);
}

/* Files pinned to one row of a table field. The file itself is an
   ordinary record attachment tagged row_ref = "<fieldKey>:<rowId>";
   this dialog just filters the record's attachments to that one row
   and points buildUploader at the same endpoint with the tag. */
async function openRowAttachments(recordNumber, rowRef, title) {
    const node = ensureDialog();
    const listBox = el("div", { class: "chip-list" });

    const load = async () => {
        listBox.replaceChildren(el("span", { class: "sm dim", text: "Loading..." }));
        try {
            const { attachments } = await api.attachments(recordNumber);
            const mine = (attachments || []).filter((a) => a.row_ref === rowRef);
            if (mine.length === 0) {
                listBox.replaceChildren(el("p", { class: "sm dim", text: "No files on this row yet." }));
                return;
            }
            listBox.replaceChildren(...mine.map((a) => a.has_file
                ? el("button", {
                    class: "chip chip-link", type: "button", title: "Open " + a.filename,
                    onClick: () => openFileWindow(
                        api.attachmentFileUrl(recordNumber, a.id), a.filename, a.mime_type)
                }, a.filename)
                : el("span", { class: "chip", text: a.filename + "  (link)" })));
        } catch (error) {
            listBox.replaceChildren(el("p", { class: "sm", style: "color:var(--crit)", text: error.message }));
        }
    };

    node.replaceChildren(
        el("div", { class: "modal-head" },
            el("h2", { class: "modal-title", text: "Files · " + title })),
        el("div", { class: "modal-body" }, [
            listBox,
            buildUploader({
                url: api.recordAttachmentsUrl(recordNumber),
                fields: { row_ref: rowRef },
                onComplete: load
            })
        ]),
        el("div", { class: "modal-foot" },
            el("button", { class: "btn btn-primary", type: "button", text: "Done",
                onClick: () => node.close() }))
    );
    node.showModal();
    load();
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

    /* A checkbox: ticked stores true, unticked is left unset (the same
       "nothing to record" as an empty text box). */
    if (entry.field.type === "boolean") {
        return entry.input.checked ? true : undefined;
    }

    /* A signature: an unsigned field is a checkbox - ticked means
       "sign me", which the server turns into a sealed record. An
       already-signed field renders read-only and is never sent back
       (the server keeps the stored signature regardless). */
    if (entry.field.type === "signature") {
        return entry.input.type === "checkbox" && entry.input.checked ? true : undefined;
    }

    const raw = entry.input.value;

    if (raw === "" || raw === null) return undefined;
    if (entry.field.type === "number") return Number(raw);

    return raw;
}

/* One field's problem, or null. The building block both the plain
   list (validate, below) and the record editor's clickable summary
   are made from. */
export function fieldProblem(entry) {
    const { field, input } = entry;
    const value = readValue(entry);

    /* an already-signed signature field reads back undefined (it is
       never re-sent) but is not "missing" */
    const alreadySigned = field.type === "signature" && input && input.type !== "checkbox";

    if (field.required && value === undefined && field.type !== "file" && !alreadySigned) {
        return field.type === "table"
            ? field.label + " needs at least one row"
            : field.label + " is required";
    }

    if (value === undefined || field.type === "table") return null;

    if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        return field.label + " must be " + describePattern(field.pattern);
    }
    if (field.min !== undefined && Number(value) < field.min) {
        return field.label + " must be at least " + field.min;
    }
    if (input && input.disabled && field.required) {
        return field.label + " cannot be set yet";
    }
    return null;
}

export function validate(entries) {
    const problems = [];
    for (const entry of entries) {
        const message = fieldProblem(entry);
        if (message) problems.push(message);
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

/* An open editor registers a teardown (drop the beforeunload guard,
   stop the autosave timers) and a dirtiness probe, so navigating away
   by the shared Back button can also warn and clean up. */
let editorTeardown = null;
let editorIsDirty = () => false;

export function wireRecordEditor() {
    const back = document.getElementById("record-editor-back");
    if (!back) return;

    back.addEventListener("click", () => {
        if (editorIsDirty()
            && !window.confirm("Leave without saving? Your draft is kept and offered when you come back.")) {
            return;
        }
        if (editorTeardown) editorTeardown();
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

    let existingVersion = null;
    try {
        definition = await api.recordForm(typeKey);
        if (number) {
            const result = await api.record(number);
            existing = result.record;
            existingVersion = result.version || null;
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

    /* Filled by the presence heartbeat (P3.3) when someone else has
       this same record open. */
    const presenceBanner = el("div", { class: "presence-banner", hidden: "hidden" });
    function paintPresence(names) {
        if (!names || names.length === 0) { presenceBanner.hidden = true; return; }
        const who = names.length === 1 ? names[0]
            : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
        presenceBanner.textContent = who
            + (names.length === 1 ? " also has" : " also have")
            + " this record open. Whoever saves last wins.";
        presenceBanner.hidden = false;
    }

    const entries = definition.fields.map((field) =>
        buildField(field, definition.options, existing ? existing.data[field.key] : undefined,
            { recordNumber: existing ? existing.number : null })
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
    const autosaveHint = el("span", { class: "autosave-hint" });
    const cancel = el("button", { class: "btn", type: "button" }, "Cancel");

    const form = el("form", {}, [errorBox, presenceBanner, titleGroup, severityGroup, dueGroup]);
    appendFieldsGrouped(form, entries);
    form.append(el("div", { class: "row", style: "margin-top:18px" }, [save, cancel, autosaveHint]));

    body.replaceChildren(form);

    /* ---------- inline validation (P0.3) ---------- */

    function paintFieldError(entry) {
        const message = fieldProblem(entry);
        let node = entry.wrapper.querySelector(":scope > .field-error");
        if (!message) { if (node) node.remove(); return Boolean(message); }
        if (!node) { node = el("div", { class: "field-error" }); entry.wrapper.append(node); }
        node.textContent = message;
        return true;
    }

    function paintTitleError() {
        const bad = !titleInput.value.trim();
        let node = titleGroup.querySelector(":scope > .field-error");
        if (!bad) { if (node) node.remove(); return false; }
        if (!node) { node = el("div", { class: "field-error" }); titleGroup.append(node); }
        node.textContent = "Summary is required";
        return true;
    }

    function focusProblem(target) {
        if (!target) return;
        const focusable = target.matches && target.matches("input,select,textarea,button")
            ? target
            : (target.querySelector && target.querySelector("input:not([type=hidden]),select,textarea,button"));
        (focusable || target).scrollIntoView({ block: "center", behavior: "smooth" });
        if (focusable && typeof focusable.focus === "function") focusable.focus();
    }

    for (const entry of entries) {
        if (entry.field.type === "table" || !entry.wrapper) continue;
        entry.wrapper.addEventListener("focusout", () => paintFieldError(entry));
        entry.wrapper.addEventListener("input", () => {
            if (entry.wrapper.querySelector(":scope > .field-error")) paintFieldError(entry);
        });
    }
    titleInput.addEventListener("blur", paintTitleError);
    titleInput.addEventListener("input", () => {
        if (titleGroup.querySelector(":scope > .field-error")) paintTitleError();
    });

    /* ---------- autosave + unsaved-changes guard (P0.2) ---------- */

    const draftKey = "qmsg:draft:v1:" + typeKey + ":" + (number || "new");
    const store = {
        read() { try { return JSON.parse(localStorage.getItem(draftKey) || "null"); } catch { return null; } },
        write(value) { try { localStorage.setItem(draftKey, JSON.stringify(value)); } catch { /* full or blocked */ } },
        clear() { try { localStorage.removeItem(draftKey); } catch { /* blocked */ } }
    };

    function snapshot() {
        const data = {};
        for (const entry of entries) {
            const value = readValue(entry);
            if (value !== undefined) data[entry.field.key] = value;
        }
        return {
            title: titleInput.value,
            severity: severitySelect.value,
            due_at: dueInput.value || null,
            data
        };
    }
    const cleanJSON = JSON.stringify(snapshot());
    const isDirty = () => JSON.stringify(snapshot()) !== cleanJSON;
    editorIsDirty = isDirty;

    /* Announce that this record is open for editing, and show a banner
       if anyone else already has it. Only for an existing record - a
       new one has no number to key on yet. */
    const stopPresence = existing ? beginEditing(existing.number, paintPresence) : null;

    function applyDraft(snap) {
        titleInput.value = snap.title || "";
        severitySelect.value = snap.severity || "warn";
        dueInput.value = snap.due_at || "";
        for (const entry of entries) {
            const value = (snap.data || {})[entry.field.key];
            if (entry.field.type === "table") {
                if (entry.writeTable) entry.writeTable(Array.isArray(value) ? value : []);
            } else if (entry.field.type === "boolean") {
                entry.input.checked = value === true || value === "true";
            } else if (entry.input) {
                const raw = value == null ? "" : String(value);
                entry.input.value = entry.field.type === "date" ? raw.slice(0, 10) : raw;
            }
        }
    }

    let savedAt = 0;
    let saveTimer = null;

    function paintHint() {
        if (!savedAt) { autosaveHint.textContent = ""; return; }
        const mins = Math.round((Date.now() - savedAt) / 60000);
        autosaveHint.textContent = "Draft saved " + (mins < 1 ? "just now" : mins + " min ago");
    }
    function autosave() {
        if (isDirty()) {
            savedAt = Date.now();
            store.write({ at: savedAt, snap: snapshot() });
        } else {
            savedAt = 0;
            store.clear();
        }
        paintHint();
    }
    const queueSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(autosave, 700);
    };
    form.addEventListener("input", queueSave);
    form.addEventListener("change", queueSave);
    const hintTicker = setInterval(paintHint, 30000);

    const onBeforeUnload = (event) => {
        if (isDirty()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    function teardown() {
        if (saveTimer) clearTimeout(saveTimer);
        clearInterval(hintTicker);
        window.removeEventListener("beforeunload", onBeforeUnload);
        if (stopPresence) stopPresence();
        if (editorTeardown === teardown) editorTeardown = null;
        if (editorIsDirty === isDirty) editorIsDirty = () => false;
    }
    if (editorTeardown) editorTeardown();   // a previous editor left mounted
    editorTeardown = teardown;

    function leave() {
        teardown();
        if (returnView) document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
    }
    cancel.addEventListener("click", () => {
        if (isDirty()
            && !window.confirm("Leave without saving? Your draft is kept and offered when you come back.")) {
            return;
        }
        leave();
    });

    /* Offer an unsent draft from a previous visit. */
    const draft = store.read();
    if (draft && draft.snap && JSON.stringify(draft.snap) !== cleanJSON) {
        const mins = Math.max(0, Math.round((Date.now() - (draft.at || Date.now())) / 60000));
        const banner = el("div", { class: "draft-banner" }, [
            el("span", {}, "Unsaved draft from " + (mins < 1 ? "moments ago" : mins + " min ago") + "."),
            el("button", {
                type: "button", class: "btn sm",
                onClick: () => { applyDraft(draft.snap); banner.remove(); autosave(); }
            }, "Restore"),
            el("button", {
                type: "button", class: "btn sm",
                onClick: () => { store.clear(); savedAt = 0; paintHint(); banner.remove(); }
            }, "Discard")
        ]);
        form.prepend(banner);
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        errorBox.hidden = true;

        const problems = [];
        if (paintTitleError()) problems.push({ message: "Summary is required", focus: titleInput });
        for (const entry of entries) {
            if (paintFieldError(entry)) {
                problems.push({ message: fieldProblem(entry), focus: entry.input || entry.wrapper });
            }
        }

        if (problems.length > 0) {
            errorBox.replaceChildren(
                el("div", {
                    class: "sm", style: "font-weight:600;margin-bottom:4px",
                    text: problems.length === 1 ? "One thing to fix" : problems.length + " things to fix"
                }),
                ...problems.map((problem) => el("button", {
                    type: "button", class: "err-jump", onClick: () => focusProblem(problem.focus)
                }, problem.message))
            );
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
                    data,
                    /* optimistic concurrency: if someone else saved
                       since this editor opened, the server 409s rather
                       than letting one edit quietly bury the other */
                    ...(existingVersion ? { expected_version: existingVersion } : {})
                });
                existingVersion = result.version || existingVersion;
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

            store.clear();
            teardown();

            if (onSaved) await onSaved(result);
            if (returnView) document.dispatchEvent(new CustomEvent("navigate", { detail: { view: returnView } }));
        } catch (error) {
            /* The server validates everything again. When it disagrees,
               it is right, and it names the fields. */
            const fields = error.payload?.fields;
            const stale = error.payload?.code === "stale";
            errorBox.replaceChildren(
                el("div", { text: stale
                    ? "Someone else saved this record while you were editing. Reopen it to see their change, then re-apply yours."
                    : error.message }),
                fields ? el("div", { class: "sm", text: "Missing: " + fields.join(", ") }) : null
            );
            errorBox.hidden = false;
            errorBox.scrollIntoView({ behavior: "smooth", block: "center" });
        } finally {
            save.disabled = false;
            save.textContent = saveLabel;
        }
    });

    paintHint();
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
