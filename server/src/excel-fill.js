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
   evaluates to an error. Those we are glad to overwrite. */
function isProtectedFormula(cell) {
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
    const type = field && field.type;
    if (type === "boolean") {
        const t = String(v).trim().toLowerCase();
        if (["yes", "y", "true", "1", "x", "✓", "checked"].includes(t)) return true;
        if (["no", "n", "false", "0", "-", ""].includes(t)) return false;
        return undefined;
    }
    if (type === "number" || type === "computed") {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    if (type === "date") {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
    }
    if (type === "select" && Array.isArray(field.options) && field.options.length) {
        const hit = field.options.find((o) => norm(o) === norm(v));
        return hit !== undefined ? hit : String(v).trim();
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
            let bestRow = -1;
            let bestCount = 0;
            s.grid.rows.forEach((row, r) => {
                const present = new Set(row.map((t) => norm(t)).filter(Boolean));
                const count = labels.filter((l) => present.has(l)).length;
                if (count > bestCount) { bestCount = count; bestRow = r; }
            });
            if (bestCount < Math.max(2, Math.ceil(labels.length / 2))) continue;

            const headerRow = s.grid.rows[bestRow];
            const columns = {};
            for (const col of f.columns) {
                const want = norm(col.label || col.key);
                const idx = headerRow.findIndex((t) => norm(t) === want);
                if (idx >= 0) columns[col.key] = colToLetter(idx + 1);
            }
            const colIdxs = Object.values(columns).map(letterToCol);
            const lo = Math.min(...colIdxs, 1) - 1;
            const hi = Math.max(...colIdxs, 1) - 1;

            /* the first grid column often numbers the rows 1,2,3... */
            let rowNumberCol = null;
            const under = s.grid.rows[bestRow + 1] || [];
            for (let c = 0; c <= hi; c++) {
                if (String(under[c] || "").trim() === "1") { rowNumberCol = colToLetter(c + 1); break; }
            }

            /* how many template rows sit below the header before real
               content or the sheet runs out */
            let capacity = 0;
            for (let r = bestRow + 1; r < s.grid.rows.length; r++) {
                const span = (s.grid.rows[r] || []).slice(lo, hi + 1);
                const solid = span.some((t) => t !== "" && !/^-?\d+(\.\d+)?$/.test(String(t))
                    && !String(t).startsWith("="));
                if (solid) break;
                capacity += 1;
                if (capacity > 400) break;
            }

            found = {
                sheet: s.ws.name,
                first_data_row: bestRow + 2,
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

/* Merge ranges ("A1:D2") that begin below `headerRowNo` and overlap
   columns [loCol, hiCol] (1-based). Writing extra data rows into a
   grid that has these would collide with a merge, so those tables cap
   at `capacity` and spill; a grid with none can just grow. */
function mergesBelow(ws, headerRowNo, loCol, hiCol) {
    for (const range of ws.model.merges || []) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
        if (!m) continue;
        const top = Number(m[2]);
        const c1 = letterToCol(m[1]);
        const c2 = letterToCol(m[3]);
        if (top > headerRowNo && c2 >= loCol && c1 <= hiCol) return true;
    }
    return false;
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
        if (isProtectedFormula(cell)) continue;
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
        const letters = Object.values(t.columns || {}).map(letterToCol);
        const loCol = Math.min(...letters, 1);
        const hiCol = Math.max(...letters, 1);
        const headerRowNo = Number(t.first_data_row) - 1;

        /* A clean grid (no merges under the header in its columns) can
           just grow past the template's blank rows; one that has merges
           there caps at capacity and spills, so nothing is mangled. */
        const canGrow = !mergesBelow(ws, headerRowNo, loCol, hiCol);
        const capacity = canGrow
            ? rows.length
            : (Number(t.capacity) > 0 ? Number(t.capacity) : rows.length);
        const overflow = [];

        rows.forEach((row, i) => {
            if (!row || typeof row !== "object") return;
            if (i >= capacity) { overflow.push(row); return; }
            const excelRowNo = Number(t.first_data_row) + i;
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
                if (isProtectedFormula(cell)) continue;
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
        if (v !== undefined) data[key] = v;
    }

    for (const [key, t] of Object.entries((map && map.tables) || {})) {
        const field = byKey.get(key);
        if (!field || !Array.isArray(field.columns) || !t) continue;
        const ws = workbook.getWorksheet(t.sheet);
        if (!ws) continue;
        const cols = new Map(field.columns.map((c) => [c.key, c]));
        const out = [];
        /* Read to the first fully-empty row (a clean grid may have grown
           past t.capacity on fill); 5000 is just a runaway guard. */
        for (let i = 0; i < 5000; i++) {
            const excelRowNo = Number(t.first_data_row) + i;
            const obj = {};
            let any = false;
            for (const [colKey, letter] of Object.entries(t.columns || {})) {
                const col = cols.get(colKey);
                if (!col) continue;
                const v = readCellValue(col, master(ws, letter + excelRowNo).value);
                if (v !== undefined && v !== "") { obj[colKey] = v; any = true; }
            }
            if (!any) break;
            out.push(obj);
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
                let any = false;
                for (const [colKey, idx] of Object.entries(colAt)) {
                    const v = readCellValue(cols.get(colKey), vals[idx]);
                    if (v !== undefined && v !== "") { obj[colKey] = v; any = true; }
                }
                if (any) out.push(obj);
            }
        }

        if (out.length) data[key] = out;
    }

    return { title: "", data, errors };
}
