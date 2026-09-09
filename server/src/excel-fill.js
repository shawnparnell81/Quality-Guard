/* ============================================================
   Fill a customer's own Excel template with a record's values,
   instead of building the generic Field / Value sheet from scratch.

   Two jobs:

     buildDefaultMap(workbook, schema)
         A best-guess { fields, tables } map: which cell each flat
         field writes to, and where each table's grid starts. The
         Form Builder's "Excel layout" screen shows this for review;
         it does not have to be right, only close.

     fillTemplate(templateBuffer, map, schema, { data })  -> Buffer
         Load the template, drop the record's values into the mapped
         cells, and stream it back. Merges, column widths, styles,
         images and internal formulas are left exactly as they were;
         a table with more rows than the template has room for spills
         onto an appended "<name> (extra)" sheet.

     readTemplate(templateBuffer, map, schema)  -> { data, errors }
         The inverse - read a filled-in template back into record
         data, for the Excel import path.

   No database, no Express - pure workbook in, workbook (or map) out.
   ============================================================ */

import ExcelJS from "exceljs";
import { readGrid } from "./routes/form-import.js";

/* ---------- address helpers ---------- */

export function colToLetter(n) {
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
}
export function letterToCol(s) {
    let n = 0;
    for (const ch of String(s).toUpperCase()) {
        if (ch >= "A" && ch <= "Z") n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n;
}
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/[\s_/\\-]+/g, " ").replace(/[:.]+$/, "").trim();

/* The real cell to write - if the address lands inside a merged
   range, only its top-left master takes a value. */
function master(ws, address) {
    const cell = ws.getCell(address);
    return cell.isMerged && cell.master ? cell.master : cell;
}

/* Leave a cell alone when it already carries a formula, UNLESS that
   formula points at another workbook (the "[1]" marker in
   =IF('[1]List'!...) - the linked file is usually long gone) or it
   evaluates to an error. Those we are glad to overwrite. `force`
   (from the map's overwrite_formula / overwrite_cols) drops the
   protection entirely for a cell the person chose to fill anyway. */
function isProtectedFormula(cell, force) {
    if (force) return false;
    const v = cell && cell.value;
    const formula = cell && (cell.formula
        || (v && typeof v === "object" && (v.formula || v.sharedFormula)));
    if (!formula) return false;
    const text = String(cell.formula || (v && (v.formula || v.sharedFormula)) || "");
    if (/\[\d+\]/.test(text)) return false;                       // external workbook ref
    const result = v && typeof v === "object" ? v.result : undefined;
    if (typeof result === "string" && result.startsWith("#")) return false;   // #REF!, #VALUE! ...
    if (result && typeof result === "object" && result.error) return false;
    return true;
}

/* ---------- value rendering ---------- */

function renderValue(field, value) {
    if (value === null || value === undefined || value === "") return null;
    const type = field && field.type;
    if (type === "boolean") return value === true || value === "true" ? "Yes" : "No";
    if (type === "number" || type === "computed") {
        const n = Number(value);
        return Number.isFinite(n) ? n : String(value);
    }
    if (type === "date") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? String(value) : d;
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/* undefined for a blank cell; { __error } for a non-blank cell that
   will not coerce to the field's type (readTemplate turns those into
   the same per-cell messages the Form-sheet reader produces). */
function readCellValue(field, raw) {
    if (raw === null || raw === undefined || raw === "") return undefined;
    let v = raw;
    if (typeof v === "object") {
        if (v instanceof Date) v = v.toISOString();
        else if (v.text !== undefined) v = v.text;
        else if (v.result !== undefined) v = v.result;
        else if (v.richText) v = v.richText.map((t) => t.text).join("");
        else return undefined;
    }
    if (v === null || v === undefined || String(v).trim() === "") return undefined;
    const type = field && field.type;
    if (type === "boolean") {
        const t = String(v).trim().toLowerCase();
        if (["yes", "y", "true", "1", "x", "✓", "checked"].includes(t)) return true;
        if (["no", "n", "false", "0", "-"].includes(t)) return false;
        return { __error: "not yes/no" };
    }
    if (type === "number" || type === "computed") {
        const n = Number(v);
        return Number.isFinite(n) ? n : { __error: "not a number" };
    }
    if (type === "date") {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? { __error: "not a date" } : d.toISOString().slice(0, 10);
    }
    if (type === "select" && Array.isArray(field.options) && field.options.length) {
        const hit = field.options.find((o) => norm(o) === norm(v));
        return hit !== undefined ? hit : { __error: "not one of: " + field.options.join(", ") };
    }
    return String(v).trim();
}

/* ---------- schema helpers ---------- */

const FLAT_TYPES = new Set(["text", "memo", "number", "date", "select", "link", "user", "boolean"]);

/* A field's section may be "<Sheet name> · <section>" when the form
   was inferred from a multi-sheet workbook - that prefix says which
   sheet the field's label lives on. */
function sheetHintFor(field) {
    const s = field && field.section;
    if (typeof s !== "string") return null;
    const cut = s.indexOf(" · ");
    return cut > 0 ? s.slice(0, cut).trim() : null;
}

/* ---------- building the default map ---------- */

/* Where a label cell's value belongs: the cell after its horizontal
   merge, else the next cell to the right. */
function valueCellFor(gridRow, wideByRC, ri, ci) {
    const span = wideByRC.get(ri + "," + ci) || 1;
    let target = ci + span;
    /* skip straight over an immediately-following non-empty cell only
       if it too looks like a label (ends with a colon) */
    const t = gridRow[target];
    if (t && /:\s*$/.test(String(t))) target += 1;
    return target;
}

export function buildDefaultMap(workbook, schema) {
    const fields = Array.isArray(schema && schema.fields) ? schema.fields : [];
    const flat = fields.filter((f) => FLAT_TYPES.has(f.type));
    const tables = fields.filter((f) => f.type === "table" && Array.isArray(f.columns));

    const sheets = workbook.worksheets
        .filter((ws) => (ws.actualRowCount || 0) > 0)
        .map((ws) => ({ ws, grid: readGrid(ws) }));
    if (!sheets.length) return { fields: {}, tables: {} };

    /* index every sheet's cells by normalized text */
    for (const s of sheets) {
        s.byText = new Map();                    // norm(text) -> [{r,c}]
        s.grid.rows.forEach((row, r) => row.forEach((text, c) => {
            if (text === "") return;
            const k = norm(text);
            if (!s.byText.has(k)) s.byText.set(k, []);
            s.byText.get(k).push({ r, c });
        }));
    }

    const scoreSheetForField = (s, f) =>
        (s.byText.get(norm(f.label)) || s.byText.get(norm(f.key)) || []).length ? 1 : 0;

    /* the sheet that matches the most flat labels is the primary one */
    let primary = sheets[0];
    let best = -1;
    for (const s of sheets) {
        const n = flat.reduce((acc, f) => acc + scoreSheetForField(s, f), 0);
        if (n > best) { best = n; primary = s; }
    }

    const fieldsMap = {};
    for (const f of flat) {
        const hint = sheetHintFor(f);
        const candidates = hint
            ? sheets.filter((s) => norm(s.ws.name) === norm(hint)).concat(primary)
            : [primary, ...sheets];
        for (const s of candidates) {
            const hits = s.byText.get(norm(f.label)) || s.byText.get(norm(f.key));
            if (!hits || !hits.length) continue;
            const { r, c } = hits[0];
            const vc = valueCellFor(s.grid.rows[r] || [], s.grid.wide, r, c);
            const address = colToLetter(vc + 1) + (r + 1);
            fieldsMap[f.key] = { sheet: s.ws.name, cell: master(s.ws, address).address };
            break;
        }
    }

    const tablesMap = {};
    for (const f of tables) {
        const wantHint = sheetHintFor(f);
        const ordered = wantHint
            ? sheets.filter((s) => norm(s.ws.name) === norm(wantHint)).concat(sheets)
            : sheets;
        let found = null;
        for (const s of ordered) {
            const labels = f.columns.map((col) => norm(col.label || col.key));
            /* Score a header candidate over a two-row band: an AIAG grid
               often splits its header into a merged category row
               ("Characteristics", "Methods") above a row of real column
               labels, and readGrid leaves the vertically-merged cells
               (Part No., Reaction Plan) only in the top row. Count a
               label as present if it sits in row r OR row r+1. */
            const bandPresent = (r) => {
                const set = new Set();
                for (const t of (s.grid.rows[r] || [])) { const n = norm(t); if (n) set.add(n); }
                for (const t of (s.grid.rows[r + 1] || [])) { const n = norm(t); if (n) set.add(n); }
                return set;
            };
            let bestRow = -1;
            let bestCount = 0;
            s.grid.rows.forEach((row, r) => {
                const present = bandPresent(r);
                const count = labels.filter((l) => present.has(l)).length;
                if (count > bestCount) { bestCount = count; bestRow = r; }
            });
            if (bestCount < Math.max(2, Math.ceil(labels.length / 2))) continue;

            /* Resolve each column against the header row, then fill any
               gap from the row just above or below (the other half of a
               split band). first_data_row is anchored to whichever of
               the two band rows carries the most plain column labels. */
            const rowAbove = s.grid.rows[bestRow - 1] || [];
            const rowBelow = s.grid.rows[bestRow + 1] || [];
            const labelsIn = (row) => labels.filter(
                (l) => row.some((t) => norm(t) === l)).length;
            const headerIdx = labelsIn(rowBelow) > labelsIn(s.grid.rows[bestRow])
                ? bestRow + 1 : bestRow;
            const headerRow = s.grid.rows[headerIdx];
            const otherRows = [s.grid.rows[headerIdx - 1] || [], s.grid.rows[headerIdx + 1] || []];
            const columns = {};
            for (const col of f.columns) {
                const want = norm(col.label || col.key);
                let idx = headerRow.findIndex((t) => norm(t) === want);
                if (idx < 0) {
                    for (const r of otherRows) {
                        const i = r.findIndex((t) => norm(t) === want);
                        if (i >= 0) { idx = i; break; }
                    }
                }
                if (idx >= 0) columns[col.key] = colToLetter(idx + 1);
            }
            const colIdxs = Object.values(columns).map(letterToCol);
            const lo = Math.min(...colIdxs, 1) - 1;
            const hi = Math.max(...colIdxs, 1) - 1;

            /* the first grid column often numbers the rows 1,2,3... */
            let rowNumberCol = null;
            const under = s.grid.rows[headerIdx + 1] || [];
            for (let c = 0; c <= hi; c++) {
                if (String(under[c] || "").trim() === "1") { rowNumberCol = colToLetter(c + 1); break; }
            }

            /* how many template rows sit below the header before real
               content or the sheet runs out */
            let capacity = 0;
            for (let r = headerIdx + 1; r < s.grid.rows.length; r++) {
                const span = (s.grid.rows[r] || []).slice(lo, hi + 1);
                const solid = span.some((t) => t !== "" && !/^-?\d+(\.\d+)?$/.test(String(t))
                    && !String(t).startsWith("="));
                if (solid) break;
                capacity += 1;
                if (capacity > 400) break;
            }

            found = {
                sheet: s.ws.name,
                first_data_row: headerIdx + 2,
                columns,
                ...(rowNumberCol ? { row_number_col: rowNumberCol } : {}),
                capacity: Math.max(capacity, 25)
            };
            break;
        }
        if (found) tablesMap[f.key] = found;
    }

    return {
        primary_sheet: primary.ws.name,
        sheets: workbook.worksheets.map((w) => w.name),
        fields: fieldsMap,
        tables: tablesMap
    };
}

/* ---------- validation & version reconcile (audit M4) ----------

   The excel_map is free-form jsonb. mapProblem catches a
   structurally bad one on save (a cell that is not a real address, a
   negative row, a column letter that is not a letter). reconcileMap
   is run on export: it drops entries for fields the schema no longer
   has and reports which schema fields nothing maps to, so a form
   edit turns "field silently stopped exporting" into a visible
   state. The map is stamped with built_for_version - the form
   version it was authored against - so "stale" is a fact, not a
   guess. */

const CELL_RE = /^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/;
const COL_RE = /^[A-Za-z]{1,3}$/;

export function mapProblem(map) {
    if (!map || typeof map !== "object" || Array.isArray(map)) return "The map must be an object";
    if (!map.template_path || typeof map.template_path !== "string") {
        return "The map needs a template_path";
    }
    for (const k of ["primary_sheet", "template_name"]) {
        if (map[k] !== undefined && typeof map[k] !== "string") return k + " must be text";
    }
    if (map.built_for_version !== undefined
        && !(Number.isInteger(map.built_for_version) && map.built_for_version > 0)) {
        return "built_for_version must be a positive whole number";
    }

    if (map.fields !== undefined) {
        if (typeof map.fields !== "object" || Array.isArray(map.fields)) return "fields must be an object";
        for (const [key, spec] of Object.entries(map.fields)) {
            if (!spec || typeof spec !== "object") return "field \"" + key + "\" has a bad mapping";
            if (spec.sheet !== undefined && typeof spec.sheet !== "string") {
                return "field \"" + key + "\" has a bad sheet";
            }
            if (typeof spec.cell !== "string" || !CELL_RE.test(spec.cell.replace(/\$/g, ""))) {
                return "field \"" + key + "\" maps to \"" + spec.cell + "\", which is not a cell address";
            }
        }
    }

    if (map.tables !== undefined) {
        if (typeof map.tables !== "object" || Array.isArray(map.tables)) return "tables must be an object";
        for (const [key, spec] of Object.entries(map.tables)) {
            if (!spec || typeof spec !== "object") return "table \"" + key + "\" has a bad mapping";
            if (spec.sheet !== undefined && typeof spec.sheet !== "string") {
                return "table \"" + key + "\" has a bad sheet";
            }
            if (!Number.isInteger(spec.first_data_row) || spec.first_data_row < 1) {
                return "table \"" + key + "\" needs a first_data_row of 1 or more";
            }
            if (spec.row_number_col !== undefined
                && (typeof spec.row_number_col !== "string" || !COL_RE.test(spec.row_number_col))) {
                return "table \"" + key + "\" has a bad row_number_col";
            }
            if (spec.capacity !== undefined
                && (!Number.isInteger(spec.capacity) || spec.capacity < 1)) {
                return "table \"" + key + "\" has a bad capacity";
            }
            if (spec.stop_on_blank_col !== undefined
                && (typeof spec.stop_on_blank_col !== "string" || !COL_RE.test(spec.stop_on_blank_col))) {
                return "table \"" + key + "\" has a bad stop_on_blank_col";
            }
            if (spec.columns === undefined || typeof spec.columns !== "object" || Array.isArray(spec.columns)) {
                return "table \"" + key + "\" needs a columns object";
            }
            for (const [ck, letter] of Object.entries(spec.columns)) {
                if (typeof letter !== "string" || !COL_RE.test(letter)) {
                    return "table \"" + key + "\" column \"" + ck + "\" maps to \"" + letter + "\", not a column letter";
                }
            }
        }
    }
    return null;
}

/* Returns { map, dropped, unmapped } - `map` with entries for
   schema-absent fields removed, `dropped` those keys, `unmapped` the
   schema fields (real inputs, not computed / section headers) that
   nothing places. */
export function reconcileMap(map, schema) {
    const fields = Array.isArray(schema && schema.fields) ? schema.fields : [];
    const real = fields.filter((f) => f.type !== "computed");
    const byKey = new Set(real.map((f) => f.key));
    const tableKeys = new Set(fields.filter((f) => f.type === "table").map((f) => f.key));

    const out = { ...(map || {}) };
    const dropped = [];

    for (const bag of ["fields", "tables"]) {
        if (!out[bag] || typeof out[bag] !== "object") continue;
        const kept = {};
        for (const [k, v] of Object.entries(out[bag])) {
            /* "__"-prefixed keys are reserved placeholders (e.g. the
               record title), not schema fields - leave them be */
            if (k.startsWith("__")) { kept[k] = v; continue; }
            const belongs = bag === "tables" ? tableKeys.has(k) : (byKey.has(k) && !tableKeys.has(k));
            if (belongs) kept[k] = v;
            else dropped.push(k);
        }
        out[bag] = kept;
    }

    const placed = new Set([
        ...Object.keys(out.fields || {}),
        ...Object.keys(out.tables || {})
    ]);
    const unmapped = real
        .filter((f) => !placed.has(f.key))
        /* a section-only heading with no data key does not count */
        .filter((f) => f.key)
        .map((f) => f.key);

    return { map: out, dropped, unmapped };
}

/* ---------- filling ---------- */

/* "<label, trimmed> +extra", kept inside Excel's 31-char sheet-name
   limit and made unique. The " +extra" suffix always survives. */
function overflowSheetName(label, taken) {
    const base = (String(label || "Rows").replace(/[[\]*?/\\:]/g, " ").trim().slice(0, 20).trim()
        || "Rows") + " +extra";
    let name = base;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = (base + " " + n++).slice(0, 31);
    taken.add(name.toLowerCase());
    return name.slice(0, 31);
}

/* Classify the merges that sit under a grid's header, inside its
   column span:
     regular  - none, or every merged body row carries the same set of
                single-row horizontal merges (Process Flow's "F:G on
                every row"). Such a grid can grow: write past the
                template's rows, carry the row style, and re-apply that
                merge pattern on each new row.
     irregular - multi-row merges, or the pattern varies row to row
                (the 8-D decision worksheets). Those cap and spill.
   `through` is the last row already covered by the pattern; `spans`
   is the per-row [c1, c2] pairs to replicate. */
function mergePattern(ws, headerRowNo, loCol, hiCol) {
    const byRow = new Map();
    let irregular = false;
    let through = headerRowNo;

    for (const range of ws.model.merges || []) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
        if (!m) continue;
        const top = Number(m[2]);
        const bottom = Number(m[4]);
        const c1 = letterToCol(m[1]);
        const c2 = letterToCol(m[3]);
        if (bottom <= headerRowNo) continue;              // header or above
        if (c2 < loCol || c1 > hiCol) continue;           // outside the grid's columns
        if (top !== bottom) { irregular = true; continue; }
        if (!byRow.has(top)) byRow.set(top, []);
        byRow.get(top).push([c1, c2]);
        if (top > through) through = top;
    }

    if (byRow.size === 0) return { spans: [], regular: !irregular, through };

    const keyOf = (spans) => spans.map((s) => s.join(":")).sort().join("|");
    const distinct = new Set([...byRow.values()].map(keyOf));
    const regular = !irregular && distinct.size === 1;
    return { spans: regular ? [...byRow.values()][0] : [], regular, through };
}

/* A blank template body row to copy cell styling from when a grid
   grows past its own rows - the first row under the header that has
   no text in the grid's columns, else the first body row. */
function styleSourceRow(ws, firstDataRow, loCol, hiCol) {
    for (let r = firstDataRow; r < firstDataRow + 40; r++) {
        let blank = true;
        for (let c = loCol; c <= hiCol; c++) {
            const v = ws.getCell(r, c).value;
            if (v !== null && v !== undefined && String(v).trim() !== "") { blank = false; break; }
        }
        if (blank) return r;
    }
    return firstDataRow;
}

export async function fillTemplate(templateBuffer, map, schema, values) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuffer);

    const data = (values && values.data) || {};
    const byKey = new Map((schema.fields || []).map((f) => [f.key, f]));
    const written = [];

    for (const [key, spot] of Object.entries((map && map.fields) || {})) {
        const field = byKey.get(key);
        if (!field || field.type === "table" || !spot || !spot.cell) continue;
        const rendered = renderValue(field, data[key]);
        if (rendered === null) continue;
        const ws = workbook.getWorksheet(spot.sheet) || workbook.worksheets[0];
        if (!ws) continue;
        const cell = master(ws, spot.cell);
        if (isProtectedFormula(cell, spot.overwrite_formula)) continue;
        cell.value = rendered;
        written.push(key);
    }

    const takenSheetNames = new Set(workbook.worksheets.map((w) => w.name.toLowerCase()));
    for (const [key, t] of Object.entries((map && map.tables) || {})) {
        const field = byKey.get(key);
        const rows = Array.isArray(data[key]) ? data[key] : null;
        if (!field || !Array.isArray(field.columns) || !rows || !t) continue;
        const ws = workbook.getWorksheet(t.sheet);
        if (!ws) continue;
        const cols = new Map(field.columns.map((c) => [c.key, c]));
        const overwriteCols = new Set(Array.isArray(t.overwrite_cols) ? t.overwrite_cols : []);
        const letters = Object.values(t.columns || {}).map(letterToCol);
        const loCol = Math.min(...letters, 1);
        const hiCol = Math.max(...letters, 1);
        const firstRow = Number(t.first_data_row);
        const headerRowNo = firstRow - 1;

        /* A grid with no merges under its header, or one whose merges
           are a regular per-row pattern, can grow past the template's
           rows; an irregular one caps and spills. */
        const pattern = mergePattern(ws, headerRowNo, loCol, hiCol);
        const canGrow = pattern.regular;
        const templateRows = Number(t.capacity) > 0 ? Number(t.capacity) : 25;
        const capacity = canGrow ? rows.length : templateRows;
        const styleFrom = canGrow ? styleSourceRow(ws, firstRow, loCol, hiCol) : firstRow;
        const cols1 = [...letters, ...(t.row_number_col ? [letterToCol(t.row_number_col)] : [])];
        const overflow = [];

        rows.forEach((row, i) => {
            if (!row || typeof row !== "object") return;
            if (i >= capacity) { overflow.push(row); return; }
            const excelRowNo = firstRow + i;

            /* Past the template's own rows: carry the body style, and
               re-apply the merge pattern so the grid keeps its look. */
            const isGrownRow = i >= templateRows;
            if (isGrownRow && styleFrom !== excelRowNo) {
                for (const c of cols1) ws.getCell(excelRowNo, c).style = ws.getCell(styleFrom, c).style;
                if (excelRowNo > pattern.through) {
                    for (const [c1, c2] of pattern.spans) {
                        try { ws.mergeCells(excelRowNo, c1, excelRowNo, c2); } catch { /* already merged */ }
                    }
                }
            }

            if (t.row_number_col) {
                const rnc = master(ws, t.row_number_col + excelRowNo);
                if (!isProtectedFormula(rnc)) rnc.value = i + 1;
            }
            for (const [colKey, letter] of Object.entries(t.columns || {})) {
                const col = cols.get(colKey);
                if (!col) continue;
                const rendered = renderValue(col, row[colKey]);
                if (rendered === null) continue;
                const cell = master(ws, letter + excelRowNo);
                if (isProtectedFormula(cell, overwriteCols.has(colKey))) continue;
                cell.value = rendered;
            }
        });

        if (overflow.length) {
            const sheet = workbook.addWorksheet(
                overflowSheetName(field.label || key, takenSheetNames));
            sheet.columns = field.columns.map((c) => ({
                header: c.label || c.key, key: c.key,
                width: Math.max(12, (c.label || c.key).length + 3)
            }));
            sheet.getRow(1).font = { bold: true };
            for (const row of overflow) {
                const line = {};
                for (const c of field.columns) {
                    const r = renderValue(c, row[c.key]);
                    line[c.key] = r === null ? "" : r;
                }
                sheet.addRow(line);
            }
        }
    }

    return { buffer: await workbook.xlsx.writeBuffer(), written };
}

/* ---------- reading a filled template back ---------- */

export async function readTemplate(templateBuffer, map, schema) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuffer);

    const byKey = new Map((schema.fields || []).map((f) => [f.key, f]));
    const data = {};
    const errors = [];

    for (const [key, spot] of Object.entries((map && map.fields) || {})) {
        const field = byKey.get(key);
        if (!field || field.type === "table" || !spot) continue;
        const ws = workbook.getWorksheet(spot.sheet);
        if (!ws) continue;
        const v = readCellValue(field, master(ws, spot.cell).value);
        if (v && typeof v === "object" && v.__error) {
            errors.push((field.label || key) + ": " + v.__error);
        } else if (v !== undefined) {
            data[key] = v;
        }
    }

    for (const [key, t] of Object.entries((map && map.tables) || {})) {
        const field = byKey.get(key);
        if (!field || !Array.isArray(field.columns) || !t) continue;
        const ws = workbook.getWorksheet(t.sheet);
        if (!ws) continue;
        const cols = new Map(field.columns.map((c) => [c.key, c]));

        /* Anchor check: the map pins each column to a letter, but the
           customer may have inserted or moved a column in their own
           template since. If the header cell above a mapped letter no
           longer reads that column's label, the whole grid has shifted
           - say so loudly and drop that column rather than silently
           read the wrong data into it. */
        const headerRowNo = Number(t.first_data_row) - 1;
        const headerRow = headerRowNo >= 1 ? (ws.getRow(headerRowNo).values || []) : [];
        const readColumns = {};
        for (const [colKey, letter] of Object.entries(t.columns || {})) {
            const col = cols.get(colKey);
            if (!col) continue;
            const want = norm(col.label || colKey);
            const got = norm(headerRow[letterToCol(letter)]);
            if (want && got && got !== want) {
                errors.push("\"" + (field.label || key) + "\": column " + letter
                    + " of the template now reads \"" + headerRow[letterToCol(letter)]
                    + "\", not \"" + (col.label || colKey) + "\". The layout has shifted -"
                    + " re-check the Excel layout mapping before importing.");
                continue;   // leave this column out of the read
            }
            readColumns[colKey] = letter;
        }

        const out = [];
        /* Read to the first fully-empty row (a clean grid may have grown
           past t.capacity on fill); 5000 is just a runaway guard.
           `stop_on_blank_col` (a column letter, set on bundled maps
           whose template ends in a totals / summary row) also stops the
           read as soon as that key column is blank, so a "Totals" line
           below the data is not mistaken for a record row. */
        for (let i = 0; i < 5000; i++) {
            const excelRowNo = Number(t.first_data_row) + i;
            if (t.stop_on_blank_col) {
                const keyCell = readCellValue({ type: "text" },
                    master(ws, String(t.stop_on_blank_col) + excelRowNo).value);
                if (keyCell === undefined || keyCell === "") break;
            }
            const obj = {};
            let any = false;
            for (const [colKey, letter] of Object.entries(readColumns)) {
                const col = cols.get(colKey);
                if (!col) continue;
                const v = readCellValue(col, master(ws, letter + excelRowNo).value);
                if (v && typeof v === "object" && v.__error) {
                    errors.push("\"" + (field.label || key) + "\" row " + (i + 1) + ", "
                        + (col.label || colKey) + ": " + v.__error);
                    any = true;
                } else if (v !== undefined && v !== "") {
                    obj[colKey] = v;
                    any = true;
                }
            }
            if (!any) break;
            if (Object.keys(obj).length) out.push(obj);
        }

        /* plus any rows the fill had to spill onto a "<label> +extra"
           sheet (a grid with merges below its header) */
        const extra = workbook.worksheets.find((w) =>
            /\+extra( \d+)?$/i.test(w.name)
            && norm(w.name).startsWith(norm(String(field.label || key).slice(0, 20))));
        if (extra) {
            const header = (extra.getRow(1).values || []).map((h) => norm(h));
            const colAt = {};
            for (const c of field.columns) {
                const idx = header.findIndex((h) => h === norm(c.label || c.key));
                if (idx >= 0) colAt[c.key] = idx;
            }
            for (let r = 2; r <= extra.rowCount; r++) {
                const vals = extra.getRow(r).values || [];
                const obj = {};
                for (const [colKey, idx] of Object.entries(colAt)) {
                    const v = readCellValue(cols.get(colKey), vals[idx]);
                    if (v && typeof v === "object" && v.__error) {
                        errors.push("\"" + (field.label || key) + "\" (extra) row " + (r - 1) + ", "
                            + (cols.get(colKey).label || colKey) + ": " + v.__error);
                    } else if (v !== undefined && v !== "") {
                        obj[colKey] = v;
                    }
                }
                if (Object.keys(obj).length) out.push(obj);
            }
        }

        if (out.length) data[key] = out;
    }

    return { title: "", data, errors };
}
