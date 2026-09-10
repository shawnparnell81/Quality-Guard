/* ============================================================
   The repeating-grid editor for a form's `type:"table"` field
   (audit H3).

   One field is an array of row objects. This module owns that array
   as an explicit JS model - `rows: [{ id, cells: { colKey: value } }]`
   - and renders it to a <table>. The DOM inputs are a view of the
   model: an edit updates the model cell, recomputes that row's
   computed columns IN THE MODEL, then reflects the result back into
   the readonly computed inputs. getRows() reads the model, never the
   DOM, so a save cannot disagree with what a person typed.

   Paste-from-Excel, Tab / Enter navigation, the always-one-blank
   trailing row, and the "open a wide row as a stacked form" drawer
   are all methods over that model. The drawer builds a fresh form
   from the row's values and writes edits back to the model - it does
   not relocate the grid's live input nodes, which was the old
   mobile-Safari hazard.

   createTableEditor({ field, options, value, recordNumber, onRowAttach })
     -> { el, getRows(), setRows(rows) }
   ============================================================ */

import { el } from "./dom.js";
import { evaluate as evalExpr } from "./expr.js";
import { ensureDialog, paintThreshold, describeComputed } from "./field-kit.js";

const BOOL_TRUE = /^(1|x|y|yes|true|✓)$/i;

export function createTableEditor({ field, options = {}, value, recordNumber, onRowAttach } = {}) {
    const columns = Array.isArray(field.columns) ? field.columns : [];
    const hasComputed = columns.some((c) => c.type === "computed");
    /* A form with many columns is miserable in a horizontal-scroll
       grid, so those rows also get an "open as a form" drawer. */
    const wide = columns.length > 6;
    const canRowAttach = Boolean(field.rowAttachments && recordNumber && onRowAttach);

    /* ---------- the model ---------- */

    const state = { rows: [] };

    const blankCells = () => {
        const cells = {};
        for (const c of columns) cells[c.key] = c.type === "boolean" ? false : "";
        return cells;
    };

    function rowFrom(seed = {}) {
        const cells = blankCells();
        for (const c of columns) {
            const raw = seed[c.key];
            if (raw === undefined || raw === null) continue;
            cells[c.key] = c.type === "boolean" ? (raw === true || raw === "true")
                : String(raw);
        }
        const row = {
            id: typeof seed._id === "string" && seed._id ? seed._id : null,
            cells
        };
        recompute(row);
        return row;
    }

    function recompute(row) {
        if (!hasComputed) return;
        const scope = {};
        for (const c of columns) {
            const n = Number(row.cells[c.key]);
            if (Number.isFinite(n)) scope[c.key] = n;
        }
        for (const column of columns) {
            if (column.type !== "computed") continue;
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
            row.cells[column.key] = out === undefined ? "" : String(out);
        }
    }

    const rowIsEmpty = (row) => columns.every((c) => {
        if (c.type === "computed") return true;
        const v = row.cells[c.key];
        return c.type === "boolean" ? !v : !String(v || "").trim();
    });

    /* ---------- inputs ---------- */

    /* A grid cell is anonymous on its own - the column label lives on
       the wrapping <td> as data-label, which nothing announces - so
       every control carries its column as an accessible name. */
    function cellInput(column, value) {
        const input = buildCellInput(column, value);
        const name = column.label || column.key;
        if (name) input.setAttribute("aria-label", name);
        return input;
    }

    function buildCellInput(column, value) {
        if (column.type === "memo") {
            const t = el("textarea", { rows: 1 });
            if (value != null && value !== "") t.value = String(value);
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
                ...((options.users || []).map((o) => el("option", { value: o.value, text: o.label })))
            ]);
            s.value = value != null ? String(value) : "";
            return s;
        }
        if (column.type === "computed") {
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
        if (column.type === "number" && column.thresholds) {
            i.step = "any";
            i.addEventListener("input", () => paintThreshold(i, column, i.value));
        }
        if (value != null && value !== "") {
            i.value = column.type === "date" ? String(value).slice(0, 10) : String(value);
        }
        return i;
    }

    const readInput = (input, column) =>
        column.type === "boolean" ? input.checked : input.value;

    /* ---------- rendering ---------- */

    const body = el("tbody");

    function renderRow(row) {
        const tr = el("tr");
        tr._row = row;              // model back-reference (data, not behaviour state)
        tr._inputs = {};

        for (const column of columns) {
            const input = cellInput(column, row.cells[column.key]);
            tr._inputs[column.key] = input;
            input.addEventListener("input", () => onCellEdit(tr, column, input));
            input.addEventListener("change", () => onCellEdit(tr, column, input));
            tr.append(el("td", { "data-label": column.label || column.key }, input));
        }

        const attachBtn = canRowAttach ? el("button", {
            class: "btn sm no-print", type: "button", text: "📎",
            title: row.id ? "Files on this row" : "Save the record first, then attach",
            "aria-label": "Row files",
            disabled: row.id ? undefined : "disabled",
            onClick: () => onRowAttach(field.key + ":" + row.id,
                (field.label || "Row") + " row " + (state.rows.indexOf(row) + 1))
        }) : null;

        tr.append(el("td", { class: "row-tools" }, [
            attachBtn,
            wide ? el("button", {
                class: "btn sm no-print", type: "button", text: "⤡",
                title: "Open this row as a form", "aria-label": "Expand row",
                onClick: () => openDrawer(row)
            }) : null,
            el("button", {
                class: "btn sm no-print", type: "button", text: "×",
                "aria-label": "Remove row", onClick: () => removeRow(row)
            })
        ]));

        reflectComputed(tr, row);
        return tr;
    }

    function reflectComputed(tr, row) {
        for (const column of columns) {
            if (column.type !== "computed") continue;
            const input = tr._inputs[column.key];
            const v = row.cells[column.key];
            input.value = v === undefined ? "" : String(v);
            paintThreshold(input, column, v === "" ? "" : v);
        }
    }

    function onCellEdit(tr, column, input) {
        if (column.type === "computed") return;
        tr._row.cells[column.key] = readInput(input, column);
        recompute(tr._row);
        reflectComputed(tr, tr._row);
        ensureTrailingBlank();
    }

    function trFor(row) {
        return [...body.children].find((tr) => tr._row === row) || null;
    }

    /* ---------- row operations ---------- */

    function addRow(seed = {}) {
        const row = rowFrom(seed);
        state.rows.push(row);
        body.append(renderRow(row));
        return row;
    }

    function removeRow(row) {
        const i = state.rows.indexOf(row);
        if (i < 0) return;
        state.rows.splice(i, 1);
        trFor(row)?.remove();
        ensureTrailingBlank();
    }

    function rerenderRow(row) {
        const old = trFor(row);
        if (!old) return;
        old.replaceWith(renderRow(row));
    }

    /* There is always one blank row waiting: the moment the last row
       gets content another appears, so a table fills continuously. */
    function ensureTrailingBlank() {
        const last = state.rows[state.rows.length - 1];
        if (!last || !rowIsEmpty(last)) addRow();
    }

    /* ---------- the drawer ---------- */

    function openDrawer(row) {
        const node = ensureDialog();
        const idx = state.rows.indexOf(row) + 1;

        const groups = columns.map((column) => {
            const input = cellInput(column, row.cells[column.key]);
            if (column.type === "computed") input.readOnly = true;
            const sync = () => {
                if (column.type === "computed") return;
                row.cells[column.key] = readInput(input, column);
                recompute(row);
                /* keep the drawer's own computed inputs live */
                for (const g of groups) {
                    const c = g._column;
                    if (c && c.type === "computed") {
                        g._input.value = row.cells[c.key] === undefined ? "" : String(row.cells[c.key]);
                    }
                }
            };
            input.addEventListener("input", sync);
            input.addEventListener("change", sync);
            const g = el("div", { class: "field-group" }, [
                el("label", { text: column.label || column.key }), input
            ]);
            g._column = column;
            g._input = input;
            return g;
        });

        node.replaceChildren(
            el("div", { class: "modal-head" },
                el("h2", { class: "modal-title", text: (field.label || "Row") + " - row " + idx })),
            el("div", { class: "modal-body" }, el("form", {}, groups)),
            el("div", { class: "modal-foot" },
                el("button", { class: "btn btn-primary", type: "button", text: "Done",
                    onClick: () => node.close() }))
        );
        /* On close - button or Escape - re-render the row from the
           (now updated) model. No live grid nodes were ever moved. */
        node.addEventListener("close", () => { rerenderRow(row); ensureTrailingBlank(); }, { once: true });
        node.showModal();
    }

    /* ---------- paste + keyboard nav ---------- */

    const typeableInputs = (tr) => columns
        .filter((c) => c.type !== "computed")
        .map((c) => tr._inputs[c.key]);

    const columnIndexByInput = (tr, input) => {
        const entries = columns.map((c, i) => [tr._inputs[c.key], i]);
        const hit = entries.find(([node]) => node === input);
        return hit ? hit[1] : -1;
    };

    body.addEventListener("paste", (event) => {
        const input = event.target.closest("input, select, textarea");
        if (!input || !body.contains(input)) return;
        const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
        if (!/[\t\n\r]/.test(text)) return;
        event.preventDefault();

        const grid = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
            .split("\n").map((line) => line.split("\t"));

        const startTr = input.closest("tr");
        const startRowIdx = [...body.children].indexOf(startTr);
        const startColIdx = columnIndexByInput(startTr, input);
        if (startRowIdx < 0 || startColIdx < 0) return;

        grid.forEach((values, r) => {
            let row = state.rows[startRowIdx + r];
            if (!row) row = addRow();
            values.forEach((value, c) => {
                const column = columns[startColIdx + c];
                if (!column || column.type === "computed") return;
                row.cells[column.key] = column.type === "boolean"
                    ? BOOL_TRUE.test(String(value).trim())
                    : String(value).trim();
            });
            recompute(row);
        });

        /* re-render every touched row from the model */
        for (let r = 0; r < grid.length; r++) {
            const row = state.rows[startRowIdx + r];
            if (row) rerenderRow(row);
        }
        ensureTrailingBlank();

        const anchor = trFor(state.rows[startRowIdx])?._inputs[columns[startColIdx].key];
        if (anchor) anchor.focus();
    });

    body.addEventListener("keydown", (event) => {
        const input = event.target.closest("input, select, textarea");
        if (!input) return;
        const tr = input.closest("tr");
        if (!tr || tr.parentElement !== body) return;

        const rowIdx = [...body.children].indexOf(tr);
        const typeable = typeableInputs(tr);
        const colIdx = typeable.indexOf(input);
        if (colIdx < 0) return;

        if (event.key === "Enter" && input.tagName !== "TEXTAREA") {
            event.preventDefault();
            const step = event.shiftKey ? -1 : 1;
            let nextTr = body.children[rowIdx + step];
            if (step === 1 && !nextTr) { addRow(); nextTr = body.lastElementChild; }
            if (nextTr) {
                const next = typeableInputs(nextTr);
                (next[colIdx] || next[0]).focus();
            }
            return;
        }

        if (event.key === "Tab" && !event.shiftKey
            && colIdx === typeable.length - 1 && rowIdx === body.children.length - 1) {
            event.preventDefault();
            addRow();
            const next = typeableInputs(body.lastElementChild);
            (next[0] || input).focus();
        }
    });

    /* ---------- assemble ---------- */

    function setRows(rows) {
        state.rows = [];
        body.replaceChildren();
        const seed = Array.isArray(rows) && rows.length ? rows : [{}];
        seed.forEach((r) => addRow(r));
        ensureTrailingBlank();
    }

    setRows(Array.isArray(value) ? value : []);

    const table = el("table", { class: "dim-repeater" }, [
        el("thead", {}, el("tr", {}, [
            ...columns.map((c) => el("th", { scope: "col", text: c.label })),
            el("th", { scope: "col" })
        ])),
        body
    ]);

    const root = el("div", {}, [
        el("div", { class: "table-wrap" }, table),
        el("div", { class: "row no-print", style: "gap:6px;margin-top:4px" }, [
            el("button", { class: "btn sm no-print", type: "button", text: "+ Add row",
                onClick: () => addRow() }),
            el("button", { class: "btn sm no-print", type: "button", text: "+ 5 rows",
                onClick: () => { for (let i = 0; i < 5; i++) addRow(); } })
        ]),
        el("span", { class: "field-hint", text:
            "Paste a block straight from Excel. Tab / Enter move between cells"
            + (wide ? "; ⤡ opens a row as a form." : ".") })
    ]);

    function getRows() {
        const out = [];
        for (const row of state.rows) {
            const obj = {};
            let any = false;
            for (const column of columns) {
                const v = row.cells[column.key];
                if (column.type === "boolean") {
                    if (v) { obj[column.key] = true; any = true; }
                    continue;
                }
                const raw = String(v ?? "").trim();
                if (raw === "") continue;
                if (column.type !== "computed") any = true;
                obj[column.key] = (column.type === "number" || column.type === "computed")
                    ? Number(raw) : raw;
            }
            if (!any) continue;
            if (row.id) obj._id = row.id;
            out.push(obj);
        }
        return out;
    }

    return { el: root, getRows, setRows };
}
