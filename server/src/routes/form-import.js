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
import { upload } from "../uploads.js";
import { saveUploadedFile } from "../file-storage.js";
import { problemWith, slugKey } from "./masterdata.js";

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
   how wide a merged cell runs, and any data-validation list options. */
export function readGrid(worksheet) {
    const rows = [];
    const bold = new Set();
    const wide = new Map();      // "r,c" -> merged column span
    const lists = new Map();     // "r,c" -> string[]

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
        }
        rows.push(out);
    }
    return { rows, bold, wide, lists };
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

const COLUMN_TYPES = new Set(["text", "memo", "number", "date", "select"]);

/* A table column can only be a scalar; sample the cells beneath to
   sharpen the guess from the header text. */
function columnType(label, samples, listOpts) {
    if (listOpts && listOpts.length) return "select";
    const nonEmpty = samples.filter((s) => s !== "");
    if (nonEmpty.length >= 2) {
        if (nonEmpty.every((s) => /^-?\d+(\.\d+)?$/.test(s))) return "number";
        if (nonEmpty.every((s) => !Number.isNaN(Date.parse(s)) && /\d{4}|[/-]/.test(s))) return "date";
    }
    const t = fieldType(label, null);
    return COLUMN_TYPES.has(t) ? t : "text";
}

/* ---------- the inference itself ---------- */

const ENUMERATOR_RX = /^(d\s?\d\b|\(?\d+\)?[.)]\s|step\s?\d)/i;
const SKIP_LABEL_RX = /^(x{1,3}|n\/?a|na|tbd|none|\d+([.)])?)$/i;

function cleanLabel(text) {
    return String(text).replace(/\s+/g, " ").replace(/\s*[:.]\s*$/, "").trim();
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

export function inferSchema(sheetName, grid) {
    const { rows, bold, wide, lists } = grid;
    const fields = [];
    const usedKeys = new Set();
    const tableSigs = new Set();
    let section = null;
    let bigTableSeen = false;

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

        /* Past the main grid, only sections matter - what is left is
           almost always a legend, a rating scale, or a repeat of the
           grid on a second page. */
        if (bigTableSeen) { r++; continue; }

        const head = headerCols(r);
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
                const col = { key: slugColumn(label, colKeys), label, type: columnType(label, samples, listOpts) };
                if (col.type === "select") col.options = listOpts;
                return col;
            });
            /* A repeater 6+ columns wide has no room for textareas. */
            if (columns.length > 6) for (const col of columns) if (col.type === "memo") col.type = "text";

            const sig = columns.map((c) => c.label.toLowerCase()).join("|");
            if (columns.length >= 2 && !tableSigs.has(sig)) {
                tableSigs.add(sig);
                fields.push({
                    key: slugColumn((section || sheetName || "table") + " rows", usedKeys),
                    label: (section ? cleanLabel(section) : (sheetName || "Line")) + " rows",
                    type: "table",
                    ...(section ? { section } : {}),
                    columns
                });
                if (columns.length >= 6) bigTableSeen = true;
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
            fields.push(field);
        }
        r++;
    }

    return { name: sheetName, fields, rules: [] };
}

const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* Pick the sheet most likely to be the form: the most-filled one,
   with instruction / legend sheets discounted and a sheet whose name
   the file name contains promoted. */
export function chooseSheet(workbook, preferName) {
    const sheets = workbook.worksheets.filter((s) => (s.actualRowCount || 0) > 0);
    if (!sheets.length) return workbook.worksheets[0] || null;
    const want = normName(preferName);
    const score = (s) => {
        let v = (s.actualRowCount || 0) * (s.actualColumnCount || 1);
        if (/instruction|intruction|example|guide|legend|scale|notes?$/i.test(s.name)) v *= 0.3;
        if (want && normName(s.name) && want.includes(normName(s.name))) v *= 3;
        return v;
    };
    return sheets.slice().sort((a, b) => score(b) - score(a))[0];
}

/* ============================================================
   Routes  (all forms.manage)
   ============================================================ */

formImport.post("/forms/import", requirePermission("forms.manage"),
    upload.single("file"), async (request, response, next) => {
        try {
            if (!request.file) return response.status(400).json({ error: "An .xlsx file is required" });

            const storagePath = await saveUploadedFile(
                "form-imports", XLSX_EXTENSIONS, request.file.originalname, request.file.buffer);

            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(request.file.buffer);

            const baseName = (request.file.originalname || "Imported form").replace(/\.[^.]+$/, "");

            const sheet = chooseSheet(workbook, baseName);
            if (!sheet) return response.status(422).json({ error: "The workbook has no readable sheet" });

            const schema = inferSchema(sheet.name || baseName, readGrid(sheet));
            schema.name = baseName;

            if (schema.fields.length === 0) {
                return response.status(422).json({
                    error: "No fields could be inferred from that sheet",
                    detail: "Expected labelled rows (\"Customer:\") or a header row over a table."
                });
            }

            const saved = await query(`
                insert into imported_forms
                    (org_id, name, original_name, storage_path, schema, created_by)
                values ($1, $2, $3, $4, $5, $6)
                returning id, name, status, created_at
            `, [request.user.org_id, baseName, request.file.originalname,
                storagePath, JSON.stringify(schema), request.user.id]);

            response.status(201).json({
                import_id: saved.rows[0].id,
                name: baseName,
                sheet: sheet.name,
                sheet_names: workbook.worksheets.map((w) => w.name),
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
            const fields = body.fields;
            const bad = problemWith(fields);
            if (bad) return response.status(422).json({ error: bad });

            const imp = await query(
                "select id, name from imported_forms where org_id = $1 and id = $2",
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

                    return { applied_key: key, created: true, name, prefix };
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

            response.json(result);
        } catch (error) {
            next(error);
        }
    });
