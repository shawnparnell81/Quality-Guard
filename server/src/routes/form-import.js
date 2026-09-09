/* ============================================================
   Excel -> form schema importer.

   An admin uploads a spreadsheet (a PFMEA, a Control Plan, an 8D
   template). The server reads it with exceljs, infers a form schema
   in the app's own shape - { fields: [{ key, label, type, section?,
   options?, columns? }], rules: [] } - and hands it back for the
   admin to correct in the same field-row editor the Form Builder
   uses. "Apply" then creates a new record type (POST-equivalent) or
   publishes a version of an existing one.

   The inference is best-effort and always followed by human review;
   it does not have to be right, only close.
   ============================================================ */

import { Router } from "express";
import ExcelJS from "exceljs";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { xlsxUpload, assertSaneWorkbook } from "../uploads.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { problemWith, slugKey } from "./masterdata.js";
import { buildDefaultMap } from "../excel-fill.js";

export const formImport = Router();

const XLSX_EXTENSIONS = new Set([".xlsx"]);

/* ---------- reading the sheet into a plain grid ---------- */

function slugColumn(label, taken) {
    let base = slugKey(label) || "col";
    let key = base;
    let n = 2;
    while (taken.has(key)) key = base + "_" + (n++);
    taken.add(key);
    return key;
}

/* A 0-indexed grid of trimmed strings, plus which cells are bold and
   how wide a merged cell runs, any data-validation list options, and
   any cell formula (so an "=E2*F2*G2" column can become computed). */
export function readGrid(worksheet) {
    const rows = [];
    const bold = new Set();
    const wide = new Map();      // "r,c" -> merged column span
    const lists = new Map();     // "r,c" -> string[]
    const formulas = new Map();  // "r,c" -> formula string, no leading "="

    /* exceljs stores merges as "A1:D2" ranges. */
    for (const range of worksheet.model.merges || []) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
        if (!m) continue;
        const c1 = colToNum(m[1]);
        const c2 = colToNum(m[3]);
        wide.set((Number(m[2]) - 1) + "," + (c1 - 1), c2 - c1 + 1);
    }

    /* rowCount is the last populated row index; actualRowCount is how
       many rows carry content. A form with blank rows between blocks
       needs the former, or whole sections get truncated. */
    const lastRow = Math.max(worksheet.rowCount || 0, worksheet.actualRowCount || 0);
    for (let r = 1; r <= lastRow; r++) {
        const row = worksheet.getRow(r);
        const out = [];
        const lastCol = Math.max(row.actualCellCount || 0, row.cellCount || 0, 1);
        for (let c = 1; c <= lastCol; c++) {
            const cell = row.getCell(c);
            /* exceljs reports the master's value on every cell of a
               merge; only the top-left one is real content. */
            const isFollower = cell.isMerged && cell.master && cell.master.address !== cell.address;
            out.push(isFollower ? "" : cellText(cell));
            if (!isFollower && cell.font && cell.font.bold) bold.add((r - 1) + "," + (c - 1));
            const dv = cell.dataValidation;
            if (dv && dv.type === "list" && Array.isArray(dv.formulae) && dv.formulae[0]) {
                const opts = String(dv.formulae[0]).replace(/^"|"$/g, "")
                    .split(",").map((s) => s.trim()).filter(Boolean);
                if (opts.length) lists.set((r - 1) + "," + (c - 1), opts);
            }
            if (!isFollower && cell.formula) {
                formulas.set((r - 1) + "," + (c - 1),
                    String(cell.formula).replace(/^=/, "").trim());
            }
        }
        rows.push(out);
    }
    return { rows, bold, wide, lists, formulas };
}

function colToNum(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
}

function cellText(cell) {
    const v = cell.value;
    if (v == null) return "";
    if (typeof v === "object") {
        if (v.richText) return v.richText.map((t) => t.text).join("").trim();
        if (v.text != null) return String(v.text).trim();
        if (v.result != null) return String(v.result).trim();
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (v.formula) return "";
        return "";
    }
    return String(v).trim();
}

/* ---------- type inference ----------

   These templates are AIAG / PPAP forms (PFMEA, Control Plan, Process
   Flow, 8D, Dimensional / FAIR, APQP Summary). They share a shape: a
   block of "Label" cells down the left, one big data-entry grid, and
   often a legend or rating scale tacked on below. The heuristics
   below target that shape. It is always followed by human review, so
   the aim is "close and low-noise", not "exact". */

/* A memo hint wins over a number hint: "Current Process Controls
   Detection" is a paragraph, "Detection" on its own is a 1-10 score.
   A short label that carries a strong text hint ("Control Plan
   Number", "Part Name/Description") stays text even if it also
   brushes a memo word. */
const MEMO_RX = /(description|specification|tolerance|statement|\bnotes?\b|comments?|\bdetails?\b|justification|\bactions?\b|root cause|\bcause|mechanism|\bmethod|\bscope\b|instruction|symptom|\bresults?\b|criteria|definition|effects? of|requirement|reaction|controls?\b|containment|\bsummary\b)/i;
const DATE_RX = /(\bdate\b|d\/o|\bdue\b|deadline|timing|dated|completion date|target close|date open)/i;
const NUM_RX = /(\bqty\b|quantity|\bcount\b|\bno\.|\bseverity\b|\boccurrence\b|\bdetection\b|\brpn\b|r\.\s?p\.\s?n|\bscore\b|priority|percent|%|\beffective\b|contribution|\bppk\b|\bcpk\b|\bsize\b|\bfreq)/i;
const TEXT_RX = /(\bname\b|number|\bno\.?\b|\bcode\b|\bid\b|supplier|customer|vendor|contact|phone|address|e-?mail|\btitle\b|revision level|\bpart\b|initiator|champion|leader|\bby\b|facility|organi[sz]ation|location|\bcity\b|\bstate\b)/i;

function fieldType(label, options) {
    if (options && options.length) return "select";
    const l = String(label).toLowerCase();
    if (l.length <= 28 && TEXT_RX.test(l) && !DATE_RX.test(l)) return "text";
    if (MEMO_RX.test(l)) return "memo";
    if (DATE_RX.test(l)) return "date";
    if (NUM_RX.test(l)) return "number";
    if (TEXT_RX.test(l)) return "text";
    return "text";
}

const COLUMN_TYPES = new Set(["text", "memo", "number", "date", "select", "boolean"]);

const BOOL_TOKENS = new Set(["true", "false", "yes", "no", "y", "n", "x", "✓", "✔", "checked", "unchecked"]);
const BOOL_YES = new Set(["true", "yes", "y", "x", "✓", "✔", "checked"]);

/* A table column can only be a scalar; sample the cells beneath to
   sharpen the guess from the header text. Returns { type, options? } -
   options is set only when the body cells themselves spell out a small
   fixed set. */
/* Also returns a rough confidence (0-1) and a one-line reason, so the
   import review screen can flag the guesses worth a second look. These
   ride on the column as _confidence / _reason and are stripped before
   the schema is published (see /forms/imports/:id/apply). */
function columnType(label, samples, listOpts) {
    if (listOpts && listOpts.length) {
        return { type: "select", options: listOpts, _confidence: 0.95,
            _reason: "a data-validation dropdown in the sheet" };
    }

    const nonEmpty = samples.filter((s) => s !== "");
    const n = nonEmpty.length;

    if (n >= 2) {
        if (nonEmpty.every((s) => /^-?\d+(\.\d+)?$/.test(s))) {
            return { type: "number", _confidence: 0.9, _reason: "all " + n + " sampled cells are numbers" };
        }
        if (nonEmpty.every((s) => !Number.isNaN(Date.parse(s)) && /\d{4}|[/-]/.test(s))) {
            return { type: "date", _confidence: 0.85, _reason: "all " + n + " sampled cells parse as dates" };
        }

        const low = nonEmpty.map((s) => s.toLowerCase());
        if (low.every((s) => BOOL_TOKENS.has(s)) && low.some((s) => BOOL_YES.has(s))) {
            return { type: "boolean", _confidence: 0.85, _reason: "sampled cells are all yes/no values" };
        }

        /* A short, repeating set of words in the body is a pick list
           the form never bothered to make a real dropdown. */
        const distinct = [...new Set(nonEmpty)];
        if (n >= 3 && distinct.length >= 2 && distinct.length <= 6
            && distinct.length < n
            && distinct.every((s) => s.length <= 24 && !/^-?\d/.test(s))) {
            return { type: "select", options: distinct, _confidence: 0.6,
                _reason: distinct.length + " distinct values repeating over " + n + " rows" };
        }
    }

    const t = fieldType(label, null);
    const known = COLUMN_TYPES.has(t) && t !== "text";
    return {
        type: known ? t : "text",
        _confidence: known ? 0.45 : (n === 0 ? 0.3 : 0.4),
        _reason: known
            ? "guessed \"" + t + "\" from the column name"
            : (n === 0 ? "no data under the header - defaulted to text"
                       : "only " + n + " sample cell(s) - defaulted to text")
    };
}

function numToCol(n) {
    let s = "";
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
}

/* "E2*F2*G2" -> { op:"*", refs:["E2","F2","G2"] }; "SUM(E2:G2)" and
   "E2+F2+G2" -> { op:"+", ... }. Only a single operator over plain
   same-row cell refs; anything fancier is left as a number column. */
function parseArithmetic(formula) {
    const s = String(formula).replace(/\s+/g, "");

    const sum = /^SUM\(([A-Z]+)(\d+):([A-Z]+)\d+\)$/i.exec(s);
    if (sum) {
        const a = colToNum(sum[1]);
        const b = colToNum(sum[3]);
        if (b <= a) return null;
        const refs = [];
        for (let c = a; c <= b; c++) refs.push(numToCol(c) + sum[2]);
        return { op: "+", refs };
    }

    if (!/^[A-Z]+\d+([*+][A-Z]+\d+)+$/.test(s)) return null;
    const hasMul = s.includes("*");
    const hasAdd = s.includes("+");
    if (hasMul === hasAdd) return null;              // mixed or neither
    const op = hasMul ? "*" : "+";
    return { op, refs: s.split(op) };
}

/* Turn a column whose body cells are a spreadsheet formula over its
   sibling number columns into a { type:"computed" } column - the same
   shape the record engine recomputes on save. */
function applyFormulaColumns(columns, head, headerRow, formulas) {
    const colAtIndex = (idx) => {
        const pos = head.findIndex((c) => c.i === idx);
        return pos >= 0 ? columns[pos] : null;
    };
    columns.forEach((col, pos) => {
        if (col.type === "computed") return;
        const ci = head[pos].i;
        let formula = null;
        for (let k = 1; k <= 6; k++) {
            const cand = formulas.get((headerRow + k) + "," + ci);
            if (cand) { formula = cand; break; }
        }
        if (!formula) return;

        const parsed = parseArithmetic(formula);
        if (!parsed) return;

        const inputs = parsed.refs.map((ref) => {
            const m = /^([A-Z]+)\d+$/.exec(ref);
            return m ? colAtIndex(colToNum(m[1]) - 1) : null;
        });
        if (inputs.length < 2 || inputs.some((c) => !c)) return;
        if (inputs.some((c) => c === col || c.type !== "number")) return;

        col.type = "computed";
        col.compute = parsed.op === "+" ? "sum" : "product";
        col.inputs = inputs.map((c) => c.key);
        delete col.options;
    });
}

/* ---------- the inference itself ---------- */

const ENUMERATOR_RX = /^(d\s?\d\b|\(?\d+\)?[.)]\s|step\s?\d)/i;
const SKIP_LABEL_RX = /^(x{1,3}|n\/?a|na|tbd|none|\d+([.)])?)$/i;

function cleanLabel(text) {
    return String(text).replace(/\s+/g, " ").replace(/\s*[:.]\s*$/, "").trim();
}

/* Drop every advisory "_"-prefixed key (the inference's _confidence /
   _reason) from a field list and its columns, so what gets published
   is a clean schema. */
function stripHints(fields) {
    if (!Array.isArray(fields)) return fields;
    const clean = (obj) => Object.fromEntries(
        Object.entries(obj).filter(([k]) => !k.startsWith("_")));
    return fields.map((f) => {
        const out = clean(f);
        if (Array.isArray(f.columns)) out.columns = f.columns.map(clean);
        return out;
    });
}

/* Section headings in these forms are sometimes a whole paragraph of
   instructions ("D7 ... : How are you going to ensure ..."). Keep the
   part before the first colon, and never longer than a line. */
function sectionLabel(text) {
    let s = String(text).replace(/\s+/g, " ").trim();
    const cut = s.indexOf(": ");
    if (cut >= 4) s = s.slice(0, cut);
    return cleanLabel(s).slice(0, 70);
}

export function inferSchema(sheetName, grid, shared = {}) {
    const { rows, bold, wide, lists, formulas = new Map() } = grid;
    const fields = [];
    /* usedKeys / tableSigs can be shared across the sheets of one
       workbook so keys stay unique and the same grid on two sheets is
       not emitted twice. Each defaults to a fresh set for a lone call. */
    const usedKeys = shared.usedKeys || new Set();
    const tableSigs = shared.tableSigs || new Set();
    let section = null;
    /* How many wide (6+ column) grids have been taken. The first is
       almost always the form's real body; a legend or a second page
       repeat comes after. A genuine second data-backed grid is still
       allowed, up to a small cap, so multi-table sheets work. */
    let bigTables = 0;

    const realCells = (ri) => (rows[ri] || [])
        .map((text, i) => ({ text, i }))
        .filter((c) => c.text !== "");

    /* Columns a row "occupies" - text cells plus the columns their
       horizontal merges run over (so a header split across a merge
       still reads as one contiguous band). */
    const occupied = (ri) => {
        const set = new Set();
        const row = rows[ri] || [];
        for (let i = 0; i < row.length; i++) {
            if (row[i] === "") continue;
            set.add(i);
            const span = wide.get(ri + "," + i) || 1;
            for (let k = 1; k < span; k++) set.add(i + k);
        }
        return [...set].sort((a, b) => a - b);
    };

    /* The leftmost column that carries any text - the "label column"
       for forms whose body starts at C or D rather than A. */
    let leftCol = Infinity;
    for (let i = 0; i < Math.min(rows.length, 80); i++) {
        for (const c of realCells(i)) if (c.i < leftCol) leftCol = c.i;
    }
    if (!Number.isFinite(leftCol)) leftCol = 0;

    const looksSectionHeading = (ri) => {
        const real = realCells(ri);
        if (real.length !== 1) return false;
        const { text, i } = real[0];
        if (text.length > 90) return false;
        const isBold = bold.has(ri + "," + i);
        const span = wide.get(ri + "," + i) || 1;
        if (isBold && span >= 3) return true;
        if (isBold && ENUMERATOR_RX.test(text)) return true;
        if (isBold && /\s/.test(text) && text.length >= 6 && text === text.toUpperCase()) return true;
        return false;
    };

    const headerCols = (ri) => {
        const occ = occupied(ri);
        if (occ.length < 3) return null;
        /* One blank column between header cells is fine (grid headers
           often sit on every other column); a wider gap means this is
           a two-up label row, not a table header. */
        for (let k = 1; k < occ.length; k++) if (occ[k] - occ[k - 1] > 2) return null;
        const real = realCells(ri);
        if (real.length < 3) return null;
        if (real.filter((c) => c.text.length > 60).length > 1) return null;  // a sentence, not headers
        /* A cell merged four or more columns wide is a banner, not a
           column header. */
        if ((wide.get(ri + "," + real[0].i) || 1) >= 4) return null;
        return real;
    };

    const bodyish = (ri, cols) => {
        const real = realCells(ri);
        if (real.length === 0) return true;
        const lo = cols[0].i;
        const hi = cols[cols.length - 1].i;
        if (real.some((c) => c.i < lo || c.i > hi)) return false;   // content outside the grid
        return real.length <= Math.max(1, Math.floor(cols.length / 3));
    };

    const dataUnder = (ri, cols) => {
        for (let k = 1; k <= 6 && rows[ri + k]; k++) {
            const row = rows[ri + k];
            const filled = cols.filter((c) => (row[c.i] || "") !== "").length;
            if (filled >= Math.max(2, Math.ceil(cols.length / 2))) return true;
        }
        return false;
    };

    const acceptTable = (ri, cols) => {
        const boldCount = cols.filter((c) => bold.has(ri + "," + c.i)).length;
        if (boldCount >= Math.ceil(cols.length / 2)) return true;
        if (dataUnder(ri, cols)) return true;
        let body = 0;
        for (let k = 1; k <= 14 && rows[ri + k]; k++) if (bodyish(ri + k, cols)) body++;
        return body >= 2;
    };

    const skipBody = (ri, cols) => {
        let k = ri;
        while (k < rows.length) {
            if (realCells(k).length === 0) { k++; continue; }
            if (looksSectionHeading(k)) break;
            if (headerCols(k)) break;
            if (bodyish(k, cols)) { k++; continue; }
            break;
        }
        return k;
    };

    let r = 0;
    while (r < rows.length) {
        let real = realCells(r);
        if (real.length === 0) { r++; continue; }

        if (looksSectionHeading(r)) {
            section = sectionLabel(real[0].text) || section;
            r++;
            continue;
        }

        /* A heading that leads a row rather than owning it alone: the
           leftmost cell is bold and either merged wide or numbered
           ("D3 ...", "1. ..."). It names a section; any labels further
           along the row still belong to that section. */
        const lead = real[0];
        if (lead.i === leftCol && bold.has(r + "," + lead.i)
            && ((wide.get(r + "," + lead.i) || 1) >= 4 || ENUMERATOR_RX.test(lead.text))) {
            section = sectionLabel(lead.text) || section;
            real = real.slice(1);
            if (real.length === 0) { r++; continue; }
        } else {

        const head = headerCols(r);

        /* Past the first wide grid, what is left is almost always a
           legend or a second-page repeat - skip it. The exception is a
           genuine second grid that has real data under it (a workbook
           with two populated tables), up to a small cap. */
        if (bigTables >= 1 && !(head && acceptTable(r, head) && dataUnder(r, head) && bigTables < 3)) {
            r++;
            continue;
        }

        if (head && acceptTable(r, head)) {
            const colKeys = new Set();
            const seenLabels = new Map();
            const columns = head.map((c) => {
                let label = c.text.replace(/\s+/g, " ").trim();
                const dup = seenLabels.get(label.toLowerCase());
                if (dup) {
                    label += /severity|occurrence|detection|r\.?\s?p\.?\s?n/i.test(label)
                        ? " (revised)" : " (" + (dup + 1) + ")";
                    seenLabels.set(c.text.toLowerCase(), dup + 1);
                } else {
                    seenLabels.set(label.toLowerCase(), 1);
                }
                const samples = [];
                for (let k = 1; k <= 12 && rows[r + k]; k++) samples.push(rows[r + k][c.i] || "");
                const listOpts = lists.get((r + 1) + "," + c.i);
                const ct = columnType(label, samples, listOpts);
                const col = { key: slugColumn(label, colKeys), label, type: ct.type };
                if (ct.options && ct.options.length) col.options = ct.options;
                col._confidence = ct._confidence;
                col._reason = ct._reason;
                return col;
            });
            /* A repeater 6+ columns wide has no room for textareas. */
            if (columns.length > 6) for (const col of columns) if (col.type === "memo") col.type = "text";

            /* "=E2*F2*G2" columns become computed (RPN, and the like). */
            applyFormulaColumns(columns, head, r, formulas);
            for (const col of columns) {
                if (col.type === "computed") {
                    col._confidence = 0.9;
                    col._reason = "a spreadsheet formula over sibling columns";
                }
            }

            const sig = columns.map((c) => c.label.toLowerCase()).join("|");
            if (columns.length >= 2 && !tableSigs.has(sig)) {
                tableSigs.add(sig);
                const hasData = dataUnder(r, head);
                fields.push({
                    key: slugColumn((section || sheetName || "table") + " rows", usedKeys),
                    label: (section ? cleanLabel(section) : (sheetName || "Line")) + " rows",
                    type: "table",
                    ...(section ? { section } : {}),
                    _confidence: hasData ? 0.8 : 0.55,
                    _reason: "a header row of " + columns.length + " columns"
                        + (hasData ? " with data under it" : " (no data rows sampled)"),
                    columns
                });
                if (columns.length >= 6) bigTables++;
            }
            r = skipBody(r + 1, head);
            continue;
        }

        }

        /* Label rows. The leftmost cell is a label; a further cell on
           the same row is a label only if it ends with a colon (the
           second column of a two-up form) - otherwise it is example
           or answer text. An all-caps left cell with no colon is a
           matrix row heading ("DIMENSIONAL", "VISUAL AIDS"), not a
           field. */
        for (const { text, i } of real) {
            const hasColon = /:\s*$/.test(text);
            if (i !== leftCol && !hasColon) continue;
            if (i === leftCol && real.length > 1 && !hasColon && !/^[\w /().#-]{2,60}$/.test(text)) continue;
            if (i === leftCol && !hasColon && /[A-Z]/.test(text) && text === text.toUpperCase()) continue;
            const label = cleanLabel(text);
            if (!label || label.length > 60 || SKIP_LABEL_RX.test(label)) continue;

            const options = lists.get(r + "," + (i + 1)) || lists.get(r + "," + i) || null;
            const field = {
                key: slugColumn(label, usedKeys),
                label,
                type: fieldType(label, options),
                ...(section ? { section } : {})
            };
            if (options) field.options = options;
            field._confidence = options ? 0.8 : (field.type !== "text" ? 0.5 : 0.35);
            field._reason = options
                ? "a data-validation dropdown beside the label"
                : (field.type !== "text" ? "guessed \"" + field.type + "\" from the field name"
                                         : "no strong signal - defaulted to text");
            fields.push(field);
        }
        r++;
    }

    return { name: sheetName, fields, rules: [] };
}

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const IGNORE_SHEET_RX = /instruction|intruction|example|guide|legend|scale|notes?$|rating|glossary|revision history|cover/i;

/* Pick the sheet most likely to be the form: the most-filled one,
   with instruction / legend sheets discounted and a sheet whose name
   the file name contains promoted. */
export function chooseSheet(workbook, preferName) {
    const sheets = workbook.worksheets.filter((s) => (s.actualRowCount || 0) > 0);
    if (!sheets.length) return workbook.worksheets[0] || null;
    const want = normName(preferName);
    const score = (s) => {
        let v = (s.actualRowCount || 0) * (s.actualColumnCount || 1);
        if (IGNORE_SHEET_RX.test(s.name)) v *= 0.3;
        if (want && normName(s.name) && want.includes(normName(s.name))) v *= 3;
        return v;
    };
    return sheets.slice().sort((a, b) => score(b) - score(a))[0];
}

/* Every sheet worth reading, in workbook order: has content, and is
   not an obvious instructions / legend / cover sheet. Falls back to
   the single best sheet if that filter would leave nothing. */
export function chooseSheets(workbook) {
    const withRows = workbook.worksheets.filter((s) => (s.actualRowCount || 0) > 0);
    const real = withRows.filter((s) => !IGNORE_SHEET_RX.test(s.name));
    if (real.length) return real;
    return withRows.length ? [withRows[0]] : [];
}

/* Infer one schema from a whole workbook. Each contributing sheet
   keeps its own section headings, and when more than one sheet feeds
   in, the sheet name becomes the outermost section so fields from
   different sheets stay grouped. Keys and table signatures are shared
   across sheets. */
export function inferWorkbook(workbook, baseName) {
    const sheets = chooseSheets(workbook);
    if (!sheets.length) return { name: baseName, fields: [], rules: [] };

    const shared = { usedKeys: new Set(), tableSigs: new Set() };
    const multi = sheets.length > 1;
    const fields = [];

    for (const sheet of sheets) {
        const one = inferSchema(sheet.name || baseName, readGrid(sheet), shared);
        for (const field of one.fields) {
            if (multi) {
                const own = field.section ? sheet.name + " · " + field.section : sheet.name;
                field.section = own.slice(0, 90);
            }
            fields.push(field);
        }
    }

    return { name: baseName, fields, rules: [], sheets: sheets.map((s) => s.name) };
}

/* ============================================================
   Routes  (all forms.manage)
   ============================================================ */

formImport.post("/forms/import", requirePermission("forms.manage"),
    xlsxUpload.single("file"), async (request, response, next) => {
        try {
            if (!request.file) return response.status(400).json({ error: "An .xlsx file is required" });

            const storagePath = await saveUploadedFile(
                "form-imports", XLSX_EXTENSIONS, request.file.originalname, request.file.buffer);

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(request.file.buffer);
            assertSaneWorkbook(workbook);

            const baseName = (request.file.originalname || "Imported form").replace(/\.[^.]+$/, "");

            const schema = inferWorkbook(workbook, baseName);

            if (schema.fields.length === 0) {
                return response.status(422).json({
                    error: "No fields could be inferred from that workbook",
                    detail: "Expected labelled rows (\"Customer:\") or a header row over a table."
                });
            }

            const saved = await query(`
                insert into imported_forms
                    (org_id, name, original_name, storage_path, schema, created_by)
                values ($1, $2, $3, $4, $5, $6)
                returning id, name, status, created_at
            `, [request.user.org_id, baseName, request.file.originalname,
                storagePath, JSON.stringify({ name: baseName, fields: schema.fields, rules: [] }),
                request.user.id]);

            response.status(201).json({
                import_id: saved.rows[0].id,
                name: baseName,
                sheet: (schema.sheets || [])[0] || null,
                sheet_names: workbook.worksheets.map((w) => w.name),
                sheets_used: schema.sheets || [],
                fields: schema.fields
            });
        } catch (error) {
            if (error.status) return response.status(error.status).json({ error: error.message });
            next(error);
        }
    });

formImport.get("/forms/imports", requirePermission("forms.manage"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select f.id, f.name, f.original_name, f.status, f.applied_key,
                       f.created_at, u.full_name as created_by,
                       jsonb_array_length(coalesce(f.schema->'fields', '[]'::jsonb)) as field_count
                  from imported_forms f
             left join users u on u.id = f.created_by
                 where f.org_id = $1
                 order by f.created_at desc
            `, [request.user.org_id]);
            response.json({ count: result.rowCount, imports: result.rows });
        } catch (error) {
            next(error);
        }
    });

formImport.get("/forms/imports/:id", requirePermission("forms.manage"),
    async (request, response, next) => {
        try {
            const found = await query(
                "select id, name, schema, status, applied_key from imported_forms where org_id = $1 and id = $2",
                [request.user.org_id, request.params.id]
            );
            if (found.rowCount === 0) return response.status(404).json({ error: "No such import" });
            response.json(found.rows[0]);
        } catch (error) {
            next(error);
        }
    });

/* POST /api/forms/imports/:id/apply
   { target: "new" | "<existing key>", key?, name?, prefix?, clause?, fields } */
formImport.post("/forms/imports/:id/apply", requirePermission("forms.manage"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            /* The inference attaches _confidence / _reason hints for the
               review screen; they are advisory and must not end up in
               the published schema. */
            const fields = stripHints(body.fields);
            const bad = problemWith(fields);
            if (bad) return response.status(422).json({ error: bad });

            const imp = await query(
                "select id, name, storage_path from imported_forms where org_id = $1 and id = $2",
                [request.user.org_id, request.params.id]
            );
            if (imp.rowCount === 0) return response.status(404).json({ error: "No such import" });

            const target = (body.target || "new").trim();

            const result = await withTransaction(async (client) => {
                if (target === "new") {
                    const name = (body.name || imp.rows[0].name || "").trim();
                    const key = slugKey(body.key || name);
                    const prefix = (body.prefix || "").trim().toUpperCase();
                    if (!name) return { bad: "A name is required" };
                    if (!/^[A-Z][A-Z0-9-]{0,11}$/.test(prefix)) {
                        return { bad: "prefix must be 1-12 chars, uppercase, starting with a letter" };
                    }

                    const clash = await client.query(
                        "select 1 from record_types where org_id = $1 and (key = $2 or prefix = $3)",
                        [request.user.org_id, key, prefix]
                    );
                    if (clash.rowCount > 0) return { conflict: "A record type already uses that key or prefix" };

                    const typeRow = await client.query(`
                        insert into record_types (org_id, key, name, prefix, clause)
                        values ($1, $2, $3, $4, $5) returning id
                    `, [request.user.org_id, key, name, prefix, (body.clause || "").trim() || null]);
                    const recordTypeId = typeRow.rows[0].id;

                    await client.query(`
                        insert into workflow_states (record_type_id, key, name, position, is_terminal)
                        values ($1, 'open', 'Open', 1, false), ($1, 'closed', 'Closed', 2, true)
                    `, [recordTypeId]);
                    await client.query(`
                        insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
                        values ($1, 'open', 'closed', 'forms.manage')
                    `, [recordTypeId]);
                    await client.query(`
                        insert into form_versions (record_type_id, version, schema, published_at, published_by)
                        values ($1, 1, $2, now(), $3)
                    `, [recordTypeId, JSON.stringify({ fields, rules: [] }), request.user.id]);

                    await client.query(`
                        insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                        values ($1, 'record_types', $2, 'created_from_import', $3, $4)
                    `, [request.user.org_id, recordTypeId, key + " (" + prefix + ")", request.user.id]);

                    return { applied_key: key, created: true, name, prefix, version: 1 };
                }

                /* publish a new version of an existing type */
                const existing = await client.query(
                    "select id from record_types where org_id = $1 and key = $2",
                    [request.user.org_id, target]
                );
                if (existing.rowCount === 0) return { bad: "No such record type: " + target };
                const recordTypeId = existing.rows[0].id;

                const prev = await client.query(
                    "select version, schema from form_versions where record_type_id = $1 order by version desc limit 1",
                    [recordTypeId]
                );
                const nextVersion = prev.rowCount > 0 ? prev.rows[0].version + 1 : 1;
                const rules = prev.rowCount > 0 ? (prev.rows[0].schema.rules || []) : [];

                await client.query(`
                    insert into form_versions (record_type_id, version, schema, published_at, published_by)
                    values ($1, $2, $3, now(), $4)
                `, [recordTypeId, nextVersion, JSON.stringify({ fields, rules }), request.user.id]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'form_versions', $2, 'published_from_import', $3, $4)
                `, [request.user.org_id, recordTypeId, "v" + nextVersion, request.user.id]);

                return { applied_key: target, created: false, version: nextVersion };
            });

            if (result.bad) return response.status(422).json({ error: result.bad });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            await query(`
                update imported_forms set status = 'applied', applied_key = $3,
                       schema = $4, updated_at = now()
                 where org_id = $1 and id = $2
            `, [request.user.org_id, request.params.id, result.applied_key,
                JSON.stringify({ name: body.name || imp.rows[0].name, fields, rules: [] })]);

            /* Keep the source spreadsheet as this form's Excel template
               and stamp a best-guess cell map onto the version just
               published, so exports come out on the customer's own
               layout from the start (refined later on the Excel-layout
               screen). Best-effort - a failure here never fails the
               apply. */
            try {
                const buf = await readUploadedFile(imp.rows[0].storage_path);
                const wb = new ExcelJS.Workbook();
                await wb.xlsx.load(buf);
                const templatePath = await saveUploadedFile(
                    "excel-templates", XLSX_EXTENSIONS, "template.xlsx", buf);
                const guess = buildDefaultMap(wb, { fields });
                const map = {
                    template_path: templatePath, template_name: imp.rows[0].name + ".xlsx",
                    built_for_version: result.version,   // audit M4
                    ...guess
                };

                await query(`
                    update form_versions set excel_map = $1
                     where record_type_id = (select id from record_types where org_id = $2 and key = $3)
                       and version = (select max(version) from form_versions
                                       where record_type_id = (select id from record_types
                                                                where org_id = $2 and key = $3))
                `, [JSON.stringify(map), request.user.org_id, result.applied_key]);
            } catch { /* no template fill for this form; the generated grid still works */ }

            response.json(result);
        } catch (error) {
            next(error);
        }
    });
