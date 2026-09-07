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
function readGrid(worksheet) {
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

    const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;
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

/* ---------- type inference ---------- */

const DATE_RX = /\b(date|d\/o|when|due|revision date|dated)\b/i;
const NUM_RX = /\b(qty|quantity|count|no\.|number|severity|occurrence|detection|rpn|score|priority|percent|%|rate|amount|hours|days|size)\b/i;
const MEMO_RX = /\b(description|statement|notes?|comments?|summary|detail|details|justification|action|root cause|cause|method|scope|instructions?)\b/i;

function fieldType(label, options) {
    if (options && options.length) return "select";
    if (DATE_RX.test(label)) return "date";
    if (NUM_RX.test(label)) return "number";
    if (MEMO_RX.test(label)) return "memo";
    return "text";
}

/* A table column can only be a scalar; sample the cells beneath to
   sharpen the guess from the header text. */
function columnType(label, samples) {
    const nonEmpty = samples.filter((s) => s !== "");
    if (nonEmpty.length) {
        if (nonEmpty.every((s) => !Number.isNaN(Number(s)))) return "number";
        if (nonEmpty.every((s) => !Number.isNaN(Date.parse(s)) && /\d{4}|\/|-/.test(s))) return "date";
    }
    const t = fieldType(label, null);
    return t === "select" ? "text" : t;
}

/* ---------- the inference itself ---------- */

function isContiguous(indices) {
    for (let i = 1; i < indices.length; i++) {
        if (indices[i] !== indices[i - 1] + 1) return false;
    }
    return true;
}

function inferSchema(sheetName, grid) {
    const { rows, bold, wide, lists } = grid;
    const fields = [];
    const usedKeys = new Set();
    let section = null;
    let r = 0;

    const cellsAt = (rowIndex) => {
        const row = rows[rowIndex] || [];
        return row.map((text, i) => ({ text, i })).filter((c) => c.text !== "");
    };
    const dataUnder = (rowIndex, cols) => {
        const row = rows[rowIndex] || [];
        return cols.filter((c) => (row[c.i] || "") !== "").length >= Math.max(2, Math.ceil(cols.length / 2));
    };

    while (r < rows.length) {
        const cells = cellsAt(r);

        if (cells.length === 0) { r++; continue; }

        /* A section heading: one cell, merged wide or bold, short, no
           trailing colon. */
        if (cells.length === 1) {
            const { text, i } = cells[0];
            const merged = (wide.get(r + "," + i) || 1) >= 2;
            const isBold = bold.has(r + "," + i);
            if ((merged || isBold) && !text.endsWith(":") && text.length <= 70) {
                section = text.replace(/[:\s]+$/, "");
                r++;
                continue;
            }
        }

        /* A table: >= 2 adjacent header cells with data rows beneath. */
        if (cells.length >= 2 && isContiguous(cells.map((c) => c.i)) && dataUnder(r + 1, cells)) {
            const colKeys = new Set();
            const columns = cells.map((c) => {
                const samples = [];
                for (let k = 1; k <= 8 && rows[r + k]; k++) samples.push(rows[r + k][c.i] || "");
                const listOpts = lists.get((r + 1) + "," + c.i);
                const col = {
                    key: slugColumn(c.text, colKeys),
                    label: c.text,
                    type: listOpts && listOpts.length ? "select" : columnType(c.text, samples)
                };
                if (col.type === "select" && listOpts) col.options = listOpts;
                return col;
            });
            fields.push({
                key: slugColumn(section || sheetName || "table", usedKeys),
                label: (section || "Table") + (section ? " rows" : ""),
                type: "table",
                ...(section ? { section } : {}),
                columns
            });
            r++;
            while (r < rows.length && dataUnder(r, cells)) r++;
            continue;
        }

        /* Label rows: the first cell that reads like a label. */
        for (const { text, i } of cells) {
            const looksLabel = text.endsWith(":") || (i === 0 && cells.length <= 2);
            if (!looksLabel) continue;
            const label = text.replace(/\s*:\s*$/, "").trim();
            if (!label || label.length > 80) break;

            const options = lists.get(r + "," + (i + 1)) || null;
            const field = {
                key: slugColumn(label, usedKeys),
                label,
                type: fieldType(label, options),
                ...(section ? { section } : {})
            };
            if (options) field.options = options;
            fields.push(field);
            break;
        }
        r++;
    }

    return { name: sheetName, fields, rules: [] };
}

/* Pick the sheet with the most content. */
function chooseSheet(workbook) {
    let best = null;
    let bestScore = -1;
    workbook.eachSheet((sheet) => {
        const score = (sheet.actualRowCount || 0) * (sheet.actualColumnCount || 1);
        if (score > bestScore) { bestScore = score; best = sheet; }
    });
    return best;
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

            const sheet = chooseSheet(workbook);
            if (!sheet) return response.status(422).json({ error: "The workbook has no readable sheet" });

            const baseName = (request.file.originalname || "Imported form").replace(/\.[^.]+$/, "");
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
