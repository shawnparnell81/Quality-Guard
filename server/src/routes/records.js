/* ============================================================
   Quality events.

   NCR, CAPA, 8D, complaint, SCAR, audit and risk all route through
   this one file, because they are all rows in the records table.
   The record type is a query parameter, not a separate endpoint.
   ============================================================ */

import { Router } from "express";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { query, withTransaction } from "../db.js";
import { requirePermission, createPermissionFor, closePermissionFor } from "../auth.js";
import { upload } from "../uploads.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { INK, INK_2, HAIRLINE, drawLetterhead, drawFooter, humanizeKey } from "../pdf-branding.js";
import { ppapMissing } from "./ppap.js";
import { publish } from "../stream.js";
import { heartbeat, leaveEditing } from "../presence.js";

export const records = Router();

/* Evidence attached to a record - a signed-off sheet, a photo of the
   defect, a supplier's 8D. Generous by design: whatever the quality
   file already holds. */
const ATTACHMENT_EXTENSIONS = new Set([
    ".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".heic",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".csv", ".txt", ".rtf", ".zip", ".msg", ".eml"
]);
const INLINE_ATTACHMENT_MIME = new Set([
    "application/pdf", "image/png", "image/jpeg", "image/tiff", "image/webp"
]);

/* due_at could not be set through this API at all before - it only
   ever got a value from seed data, which is why every overdue count
   in the app was silently correct for the demo and silently useless
   for anything actually raised through the UI.

   Undefined, null or "" all mean "no due date" and are left alone
   rather than treated as an error, since not every record needs one.
   Anything else has to parse as a real date. */
function parseDueAt(value) {
    if (value === undefined || value === null || value === "") {
        return { ok: true, value: null };
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { ok: false, value: null };

    return { ok: true, value: parsed.toISOString() };
}

/* Risk priority numbers are derived, never entered - severity times
   occurrence times detection, computed here so a stored rpn can
   never disagree with the very numbers it comes from. Same idea for
   residual_rpn: the re-evaluation after a mitigation is verified,
   using its own severity/occurrence/detection, not the original
   risk's - a control that lowers occurrence does nothing for
   severity, and the two numbers should say so separately. Only
   touches risk records; every other type's data passes through
   untouched. */
function withComputedRpn(typeKey, data) {
    if (typeKey !== "risk" || !data || typeof data !== "object") return data;

    const computed = { ...data };
    const score = (value) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
    };

    const [s, o, d] = [score(data.severity), score(data.occurrence), score(data.detection)];
    if (s !== null && o !== null && d !== null) computed.rpn = s * o * d;

    const [rs, ro, rd] = [score(data.residual_severity), score(data.residual_occurrence), score(data.residual_detection)];
    if (rs !== null && ro !== null && rd !== null) computed.residual_rpn = rs * ro * rd;

    return computed;
}

/* A form's table field may carry "computed" columns - a cell whose
   value is the product or sum of other number columns in the same
   row (RPN = severity x occurrence x detection). The in-app editor
   fills these live; recomputed here from the schema so a stored value
   can never disagree with the numbers it is made of, the same
   guarantee withComputedRpn gives the built-in risk record. A no-op
   unless the published form actually defines a computed column. */
function applyComputedColumns(schema, data) {
    const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
    if (!data || typeof data !== "object" || fields.length === 0) return data;

    let out = data;
    for (const field of fields) {
        if (field.type !== "table" || !Array.isArray(field.columns)) continue;
        const computed = field.columns.filter((c) => c && c.type === "computed");
        if (computed.length === 0) continue;

        const rows = Array.isArray(out[field.key]) ? out[field.key] : null;
        if (!rows) continue;

        if (out === data) out = { ...data };
        out[field.key] = rows.map((row) => {
            if (!row || typeof row !== "object") return row;
            const next = { ...row };
            for (const col of computed) {
                const nums = (col.inputs || []).map((k) => Number(next[k]));
                if (nums.length === 0 || !nums.every((n) => Number.isFinite(n))) {
                    delete next[col.key];
                    continue;
                }
                next[col.key] = col.compute === "sum"
                    ? nums.reduce((a, b) => a + b, 0)
                    : nums.reduce((a, b) => a * b, 1);
            }
            return next;
        });
    }
    return out;
}

/* First Article Inspection: a measured characteristic conforms when
   its actual falls inside nominal + [tol_minus, tol_plus]. The
   "result" column and the conforming counts are derived here so the
   screen, the PDF and any report all read the same numbers - the
   same guarantee applyComputedColumns / withComputedRpn give. A row
   with no nominal (a visual / attribute check) keeps whatever result
   the inspector typed. A no-op for every type but fair. */
function applyFairResults(typeKey, data) {
    if (typeKey !== "fair" || !data || typeof data !== "object") return data;
    const rows = Array.isArray(data.characteristics) ? data.characteristics : null;
    if (!rows) return data;

    let conforming = 0;
    let checked = 0;
    const out = { ...data };
    out.characteristics = rows.map((row) => {
        if (!row || typeof row !== "object") return row;
        const next = { ...row };
        const nominal = Number(next.nominal);
        const actual = Number(next.actual);
        if (Number.isFinite(nominal) && Number.isFinite(actual)) {
            const lo = nominal + (Number(next.tol_minus) || 0);
            const hi = nominal + (Number(next.tol_plus) || 0);
            const pass = actual >= Math.min(lo, hi) && actual <= Math.max(lo, hi);
            next.result = pass ? "Pass" : "Fail";
            checked += 1;
            if (pass) conforming += 1;
        } else if (next.result !== "Pass" && next.result !== "Fail") {
            next.result = "";
        }
        return next;
    });
    out.checked_count = checked;
    out.conforming_count = conforming;
    out.nonconforming_count = checked - conforming;
    return out;
}

/* Clause 9.2: an auditor must be independent of the area under
   review. "Area" is not an invented category here - it is the same
   discipline column every person record already carries, compared
   against the department an audit now has to declare. runQuery is
   either the module-level query() or a transaction client's query
   bound to it, so this works both before a transaction opens (create)
   and inside one (update, transition). */
async function auditorConflict(runQuery, orgId, data) {
    if (!data || !data.auditor || !data.department) return false;

    const found = await runQuery(
        "select discipline from users where org_id = $1 and initials = $2",
        [orgId, data.auditor]
    );
    if (found.rowCount === 0) return false;

    const discipline = found.rows[0].discipline;
    return Boolean(discipline)
        && discipline.trim().toLowerCase() === String(data.department).trim().toLowerCase();
}

/* Clause 10.2: a CAPA may not close without evidence the corrective
   action was actually validated. */
async function hasAttachment(runQuery, recordId) {
    const found = await runQuery(
        "select 1 from attachments where record_id = $1 limit 1",
        [recordId]
    );
    return found.rowCount > 0;
}

/* Clause 9.2: a Discrepancy Investigation carries the three completed
   forms the finding needs - the NCR form, the 8D report, the CAPA
   form - as documents in di_deliverables. It cannot close until all
   three slots are filled. Returns the labels of the ones still empty. */
async function diFormsMissing(runQuery, recordId) {
    const found = await runQuery(
        "select slot from di_deliverables where record_id = $1",
        [recordId]
    );
    const have = new Set(found.rows.map((r) => r.slot));
    return [
        !have.has("ncr") && "NCR form",
        !have.has("eightd") && "8D report",
        !have.has("capa") && "CAPA form"
    ].filter(Boolean);
}

/* And an audit cannot close while the DI it raised is still open: the
   finding is not resolved until its investigation is. Returns the DI's
   number if it exists and is not yet closed, else null. */
async function openDiForAudit(runQuery, auditId) {
    const found = await runQuery(`
        select r.number, r.status
          from record_links l
          join records r        on r.id = l.to_record_id
          join record_types rt  on rt.id = r.record_type_id
         where l.from_record_id = $1 and l.link_type = 'child_of' and rt.key = 'di'
         limit 1
    `, [auditId]);
    if (found.rowCount === 0) return null;
    return found.rows[0].status === "closed" ? null : found.rows[0].number;
}

/* Which authority an edit needs depends on what is being changed.
   Selecting "Rework" and selecting "Use-as-is" travel through the same
   endpoint but are not the same decision: use-as-is ships a known
   nonconforming part to a customer, and clause 8.7 expects that to be
   a named authority. */
function editPermissionFor(request) {
    const disposition = request.body?.data?.disposition;

    if (disposition === "Use-as-is") return "ncr.use_as_is";
    if (disposition) return "ncr.disposition";

    /* Ordinary field corrections need no special authority. Every one
       of them still lands in audit_log. */
    return null;
}

const SELECT_RECORD = `
    select r.id,
           r.record_type_id,
           r.number,
           r.title,
           r.status,
           r.severity,
           r.data,
           r.form_version,
           r.opened_at,
           r.due_at,
           r.closed_at,
           rt.key   as type,
           rt.name  as type_name,
           rt.clause,
           u.full_name as owner,
           u.initials  as owner_initials
      from records r
      join record_types rt on rt.id = r.record_type_id
 left join users u        on u.id = r.owner_id
     where r.org_id = $1
`;

/* ---------- list ----------
   GET /api/records?type=ncr&status=containment&open=true
                    &q=bore&sort=due&dir=asc&limit=50&offset=50

   Returns `total` (the count under the same filters, before
   limit/offset) so a register can page and say "showing 51-100 of
   214". */
const SORT_COLUMNS = {
    opened:   "r.opened_at",
    due:      "r.due_at",
    number:   "r.number",
    title:    "r.title",
    status:   "r.status",
    severity: "r.severity"
};

/* The shared WHERE for the list and the export: same type / status /
   severity / open / q filters, so an exported sheet is exactly what
   the register shows. Returns the fragment (leading " and ", or "")
   and the params array starting with the org id - no limit/offset. */
function buildRecordFilter(request) {
    const conditions = [];
    const params = [request.user.org_id];

    if (request.query.type) {
        params.push(request.query.type);
        conditions.push("rt.key = $" + params.length);
    }
    if (request.query.status) {
        params.push(request.query.status);
        conditions.push("r.status = $" + params.length);
    }
    if (request.query.severity) {
        params.push(request.query.severity);
        conditions.push("r.severity = $" + params.length);
    }
    if (request.query.open === "true") {
        conditions.push("r.closed_at is null");
    }
    const q = String(request.query.q || "").trim();
    if (q) {
        params.push("%" + q + "%");
        conditions.push("(r.number ilike $" + params.length + " or r.title ilike $" + params.length + ")");
    }

    return { where: conditions.length ? " and " + conditions.join(" and ") : "", params };
}

function sortClause(request) {
    const column = SORT_COLUMNS[request.query.sort] || "r.opened_at";
    const dir = request.query.dir === "asc" ? "asc" : "desc";
    return " order by " + column + " " + dir + " nulls last, r.number desc";
}

records.get("/", async (request, response, next) => {
    try {
        const { where, params } = buildRecordFilter(request);

        const limit = Math.min(Number(request.query.limit) || 100, 500);
        const offset = Math.max(Number(request.query.offset) || 0, 0);
        const paged = params.concat(limit, offset);

        const [rows, totals] = await Promise.all([
            query(SELECT_RECORD + where + sortClause(request)
                + " limit $" + (paged.length - 1) + " offset $" + paged.length, paged),
            query("select count(*)::int as total from records r"
                + " join record_types rt on rt.id = r.record_type_id"
                + " where r.org_id = $1" + where, params)
        ]);

        response.json({
            count: rows.rowCount,
            total: totals.rows[0].total,
            records: rows.rows
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- export ----------
   GET /api/records/export?type=ncr&q=bore&severity=crit&open=true

   The current register, filtered and sorted the same way, as an
   .xlsx. No paging - the whole filtered set, capped so a runaway
   query cannot pin the process. Standard record columns first, then
   one column per data key seen across the set. */
const EXPORT_CAP = 5000;

records.get("/export", async (request, response, next) => {
    try {
        const { where, params } = buildRecordFilter(request);
        const result = await query(
            SELECT_RECORD + where + sortClause(request) + " limit " + EXPORT_CAP, params);

        const dataKeys = [];
        for (const row of result.rows) {
            for (const key of Object.keys(row.data || {})) {
                if (!dataKeys.includes(key)) dataKeys.push(key);
            }
        }

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "QMS Guardian";
        workbook.created = new Date();
        const sheet = workbook.addWorksheet("Records");

        sheet.columns = [
            { header: "Number", key: "number", width: 18 },
            { header: "Type", key: "type_name", width: 20 },
            { header: "Title", key: "title", width: 44 },
            { header: "Status", key: "status", width: 16 },
            { header: "Severity", key: "severity", width: 10 },
            { header: "Owner", key: "owner", width: 20 },
            { header: "Opened", key: "opened_at", width: 20 },
            { header: "Due", key: "due_at", width: 14 },
            { header: "Closed", key: "closed_at", width: 20 },
            ...dataKeys.map((k) => ({ header: humanizeKey(k), key: "data:" + k, width: 22 }))
        ];
        sheet.getRow(1).font = { bold: true };

        for (const row of result.rows) {
            const line = {
                number: row.number, type_name: row.type_name, title: row.title,
                status: humanizeKey(row.status), severity: row.severity,
                owner: row.owner || "",
                opened_at: row.opened_at, due_at: row.due_at, closed_at: row.closed_at
            };
            for (const key of dataKeys) {
                const value = (row.data || {})[key];
                line["data:" + key] = value == null ? ""
                    : (typeof value === "object" ? JSON.stringify(value) : value);
            }
            sheet.addRow(line);
        }

        const label = (request.query.type || "records").toString().replace(/[^a-z0-9_-]/gi, "");
        const stamp = new Date().toISOString().slice(0, 10);
        response.setHeader("Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition",
            'attachment; filename="' + label + "-register-" + stamp + '.xlsx"');
        await workbook.xlsx.write(response);
        response.end();
    } catch (error) {
        next(error);
    }
});

/* ---------- bulk import ----------
   One .xlsx, one record per data row, for a single type. A header
   row names the columns; "Title" is required, "Severity" and
   "Owner" are optional standard columns, and every other header is
   matched to a form field by its key or its human label. Fields that
   cannot come from a flat cell (table, file, signature) are ignored,
   unless one is required for the type - then the whole import is
   refused, because those records have to be built in the app.

   A field the form marks required but that cannot come from a cell
   (a signature, an attachment, a sub-table) does not block the
   import - bulk import is a migration tool, and those sign-offs are
   finished in the app afterwards - but every such field is named in
   a top-level warning so nobody is surprised.

   POST /api/records/import?type=ncr[&dry_run=true]  (multipart, file)
   GET  /api/records/import-template?type=ncr        (the blank sheet) */

const FLAT_FIELD_TYPES = new Set(["text", "memo", "number", "date", "select", "link", "user"]);

async function loadPublishedForm(recordTypeId) {
    const row = await query(`
        select version, schema from form_versions
         where record_type_id = $1 and published_at is not null
         order by version desc limit 1
    `, [recordTypeId]);
    return row.rowCount > 0 ? row.rows[0] : null;
}

const normalizeHeader = (s) => String(s || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");

/* Turn one spreadsheet cell into the value a form field expects. */
function coerceCell(field, raw) {
    if (raw === null || raw === undefined || raw === "") return undefined;
    /* exceljs hands back rich objects for some cells. */
    if (typeof raw === "object") {
        if (raw instanceof Date) raw = raw.toISOString();
        else if (raw.text !== undefined) raw = raw.text;              // hyperlink / rich text
        else if (raw.result !== undefined) raw = raw.result;          // formula
        else raw = String(raw);
    }
    if (field.type === "number") {
        const n = Number(raw);
        return Number.isFinite(n) ? n : { __error: "not a number" };
    }
    if (field.type === "date") {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? { __error: "not a date" } : d.toISOString().slice(0, 10);
    }
    const text = String(raw).trim();
    if (field.type === "select" && Array.isArray(field.options) && field.options.length) {
        const hit = field.options.find((o) => normalizeHeader(o) === normalizeHeader(text));
        return hit !== undefined ? hit : { __error: "not one of: " + field.options.join(", ") };
    }
    return text;
}

/* Parse the upload into
   { rows:[{ row, title, severity, owner, data, errors:[] }], warnings:[], fatal } */
function readImportSheet(buffer, schema) {
    return (async () => {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const sheet = workbook.worksheets[0];
        if (!sheet || sheet.rowCount < 2) return { rows: [], warnings: [], fatal: "The sheet has no data rows" };

        const fields = (schema.fields || []).filter((f) => FLAT_FIELD_TYPES.has(f.type));
        const warnings = [];
        const requiredUnimportable = (schema.fields || [])
            .filter((f) => f.required && !FLAT_FIELD_TYPES.has(f.type))
            .map((f) => (f.label || f.key) + " (" + f.type + ")");
        if (requiredUnimportable.length) {
            warnings.push("Imported records will still need " + requiredUnimportable.join(", ")
                + " completed in the app.");
        }

        const byHeader = new Map();
        for (const f of fields) {
            byHeader.set(normalizeHeader(f.key), f);
            if (f.label) byHeader.set(normalizeHeader(f.label), f);
        }

        const headerCells = sheet.getRow(1).values;   // 1-indexed, [0] empty
        const columns = [];                            // { col, kind:'title'|'severity'|'owner'|'field', field? }
        headerCells.forEach((text, col) => {
            if (col === 0) return;
            const norm = normalizeHeader(text);
            if (norm === "title") columns.push({ col, kind: "title" });
            else if (norm === "severity") columns.push({ col, kind: "severity" });
            else if (norm === "owner" || norm === "owner initials") columns.push({ col, kind: "owner" });
            else if (byHeader.has(norm)) columns.push({ col, kind: "field", field: byHeader.get(norm) });
            /* unknown headers are ignored, not an error */
        });
        if (!columns.some((c) => c.kind === "title")) {
            return { rows: [], warnings, fatal: 'The sheet needs a "Title" column' };
        }

        const rows = [];
        for (let r = 2; r <= sheet.rowCount; r++) {
            const excelRow = sheet.getRow(r);
            const rawByCol = (col) => excelRow.getCell(col).value;
            const nonEmpty = columns.some((c) => {
                const v = rawByCol(c.col);
                return v !== null && v !== undefined && v !== "";
            });
            if (!nonEmpty) continue;   // a blank line in the middle of the sheet

            const entry = { row: r, title: "", severity: "ok", owner: null, data: {}, errors: [] };
            for (const c of columns) {
                const raw = rawByCol(c.col);
                if (c.kind === "title") {
                    entry.title = raw == null ? "" : String(typeof raw === "object" && raw.text !== undefined ? raw.text : raw).trim();
                } else if (c.kind === "severity") {
                    const s = String(raw || "").trim().toLowerCase();
                    entry.severity = ["ok", "warn", "crit"].includes(s) ? s : "ok";
                } else if (c.kind === "owner") {
                    entry.owner = raw == null || raw === "" ? null : String(raw).trim().toUpperCase();
                } else {
                    const value = coerceCell(c.field, raw);
                    if (value && typeof value === "object" && value.__error) {
                        entry.errors.push((c.field.label || c.field.key) + ": " + value.__error);
                    } else if (value !== undefined) {
                        entry.data[c.field.key] = value;
                    }
                }
            }
            if (!entry.title) entry.errors.push("Title is required");
            rows.push(entry);
        }
        return { rows, warnings, fatal: null };
    })();
}

records.get("/import-template", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const type = String(request.query.type || "");
        const typeRow = await query(
            "select id, name from record_types where org_id = $1 and key = $2",
            [request.user.org_id, type]);
        if (typeRow.rowCount === 0) return response.status(400).json({ error: "Unknown record type: " + type });

        const form = await loadPublishedForm(typeRow.rows[0].id);
        const flat = ((form && form.schema.fields) || []).filter((f) => FLAT_FIELD_TYPES.has(f.type));

        const workbook = new ExcelJS.Workbook();
        workbook.creator = "QMS Guardian";
        const sheet = workbook.addWorksheet("Import");
        sheet.columns = [
            { header: "Title", key: "title", width: 44 },
            { header: "Severity", key: "severity", width: 12 },
            { header: "Owner", key: "owner", width: 12 },
            ...flat.map((f) => ({
                header: f.label || humanizeKey(f.key), key: f.key,
                width: Math.max(14, (f.label || f.key).length + 4)
            }))
        ];
        sheet.getRow(1).font = { bold: true };
        /* a hint row so people see the shape, deleted before upload */
        const hint = { title: "Example: bore diameter oversize on lot 4471", severity: "warn", owner: "MO" };
        for (const f of flat) {
            if (f.type === "select" && Array.isArray(f.options) && f.options.length) hint[f.key] = f.options[0];
            else if (f.type === "date") hint[f.key] = new Date().toISOString().slice(0, 10);
            else if (f.type === "number") hint[f.key] = 1;
        }
        sheet.addRow(hint);
        sheet.getRow(2).font = { italic: true, color: { argb: "FF888888" } };

        const stamp = new Date().toISOString().slice(0, 10);
        response.setHeader("Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition",
            'attachment; filename="' + type.replace(/[^a-z0-9_-]/gi, "") + "-import-" + stamp + '.xlsx"');
        await workbook.xlsx.write(response);
        response.end();
    } catch (error) {
        next(error);
    }
});

records.post("/import", requirePermission(createPermissionFor), upload.single("file"),
    async (request, response, next) => {
        try {
            const type = String(request.query.type || request.body?.type || "");
            const dryRun = request.query.dry_run === "true" || request.body?.dry_run === "true";
            if (!request.file) return response.status(400).json({ error: "An .xlsx file is required" });

            const typeRow = await query(
                "select id, prefix from record_types where org_id = $1 and key = $2",
                [request.user.org_id, type]);
            if (typeRow.rowCount === 0) return response.status(400).json({ error: "Unknown record type: " + type });
            const recordType = typeRow.rows[0];

            const form = await loadPublishedForm(recordType.id);
            const schema = form ? form.schema : { fields: [] };
            const formVersion = form ? form.version : 1;

            let parsed;
            try {
                parsed = await readImportSheet(request.file.buffer, schema);
            } catch {
                return response.status(422).json({ error: "That file could not be read as an .xlsx workbook" });
            }
            if (parsed.fatal) return response.status(422).json({ error: parsed.fatal });
            if (parsed.rows.length === 0) return response.status(422).json({ error: "No data rows found in the sheet" });

            const requiredKeys = (schema.fields || [])
                .filter((f) => f.required && FLAT_FIELD_TYPES.has(f.type))
                .map((f) => ({ key: f.key, label: f.label || f.key }));

            /* Finish validating each row: computed columns, then the
               type's own required fields. */
            for (const entry of parsed.rows) {
                entry.data = applyComputedColumns(schema, withComputedRpn(type, entry.data));
                entry.data = applyFairResults(type, entry.data);
                for (const req of requiredKeys) {
                    if (entry.data[req.key] === undefined) entry.errors.push(req.label + " is required");
                }
            }

            const valid = parsed.rows.filter((e) => e.errors.length === 0);
            const errors = parsed.rows
                .filter((e) => e.errors.length > 0)
                .map((e) => ({ row: e.row, title: e.title || "(no title)", messages: e.errors }));

            if (dryRun) {
                return response.json({
                    type, dry_run: true, total_rows: parsed.rows.length,
                    will_create: valid.length, warnings: parsed.warnings, errors,
                    preview: valid.slice(0, 20).map((e) => ({ row: e.row, title: e.title, data: e.data }))
                });
            }

            if (valid.length === 0) {
                return response.status(422).json({
                    error: "Nothing to import - every row has a problem",
                    warnings: parsed.warnings, errors
                });
            }

            const created = await withTransaction(async (client) => {
                const out = [];
                for (const entry of valid) {
                    const row = await insertRecordRow(client, {
                        orgId: request.user.org_id, userId: request.user.id,
                        recordType, type, title: entry.title, severity: entry.severity,
                        ownerInitials: entry.owner, data: entry.data, formVersion, dueAt: null
                    });
                    out.push(row.number);
                }
                return out;
            });

            response.status(201).json({
                type, created_count: created.length, created,
                skipped: errors.length, warnings: parsed.warnings, errors
            });
        } catch (error) {
            next(error);
        }
    });

/* ---------- search, for the command palette ----------
   GET /api/records/search?q=bore

   Registered before /:number on purpose - Express matches routes in
   the order they are declared, and "search" would otherwise be read
   as a record number and 404 against /:number instead of ever
   reaching here.

   Matches against the number and the title only, not the JSONB data
   payload - a query into arbitrary keys per record type is a
   reasonable future step, but number/title already covers "type an
   NCR number, jump to it" and "type a word from the title." */
records.get("/search", async (request, response, next) => {
    try {
        const q = (request.query.q || "").trim();
        if (q.length < 2) return response.json({ records: [] });

        const result = await query(
            SELECT_RECORD + `
               and (r.number ilike $2 or r.title ilike $2)
             order by r.opened_at desc
             limit 8
            `,
            [request.user.org_id, "%" + q + "%"]
        );

        response.json({ records: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- one record, with its graph and history ----------
   GET /api/records/NCR-2026-0142 */
records.get("/:number", async (request, response, next) => {
    try {
        const found = await query(
            SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]
        );

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const record = found.rows[0];

        /* Links run in both directions. A complaint points at its 8D,
           and from the 8D you still want to see the complaint. */
        const links = await query(`
            select l.link_type,
                   'outgoing' as direction,
                   r.number, r.title, r.status, r.severity, rt.key as type
              from record_links l
              join records r      on r.id = l.to_record_id
              join record_types rt on rt.id = r.record_type_id
             where l.from_record_id = $1
             union all
            select l.link_type,
                   'incoming' as direction,
                   r.number, r.title, r.status, r.severity, rt.key as type
              from record_links l
              join records r      on r.id = l.from_record_id
              join record_types rt on rt.id = r.record_type_id
             where l.to_record_id = $1
        `, [record.id]);

        const history = await query(`
            select a.field, a.old_value, a.new_value, a.reason,
                   a.changed_at, u.full_name as changed_by
              from audit_log a
         left join users u on u.id = a.changed_by
             where a.record_id = $1
             order by a.changed_at desc
             limit 50
        `, [record.id]);

        /* Which moves are legal from here, and whether this particular
           person may make them. The UI needs both: an action nobody can
           take should not appear, and one this person cannot take
           should say who can.

           Matched on record_type_id, not rt.key: a type key like
           "eightd" is only unique per organization, not across all of
           them, so filtering on the key alone would return every
           tenant's transitions that happen to share a from_state. */
        const moves = await query(`
            select wt.to_state, wt.required_permission,
                   ws.name as to_name, ws.is_terminal,
                   p.description as permission_description
              from workflow_transitions wt
         left join workflow_states ws
                on ws.record_type_id = wt.record_type_id and ws.key = wt.to_state
         left join permissions p on p.key = wt.required_permission
             where wt.record_type_id = $1 and wt.from_state = $2
             order by ws.position
        `, [record.record_type_id, record.status]);

        const closeKey = closePermissionFor(record.type);

        /* The same closure gates the transition endpoint itself
           enforces (clause 9.2 and 10.2), checked once here so a
           blocked close button says why before anyone clicks it,
           rather than only after a 409 comes back. */
        const capaMissingAttachment = record.type === "capa" && !await hasAttachment(query, record.id);
        const auditHasConflict = record.type === "audit"
            && await auditorConflict(query, request.user.org_id, record.data);
        const diFormsIncomplete = record.type === "di"
            && (await diFormsMissing(query, record.id)).length > 0;
        const auditDiOpen = record.type === "audit"
            ? await openDiForAudit(query, record.id)
            : null;
        const ppapNotReady = record.type === "ppap"
            ? (await ppapMissing(query, record.id, record.data)).length
            : 0;

        const transitions = moves.rows.map((move) => {
            const stepOk = !move.required_permission || request.can(move.required_permission);
            const closeOk = !move.is_terminal || !closeKey || request.can(closeKey);
            const gateBlocked = move.is_terminal
                ? (capaMissingAttachment
                    ? "Needs at least one attachment before closing"
                    : (auditHasConflict
                        ? "The assigned auditor works within the department under review"
                        : (diFormsIncomplete
                            ? "Attach the NCR, 8D and CAPA forms before closing"
                            : (auditDiOpen
                                ? "Discrepancy Investigation " + auditDiOpen + " is not closed"
                                : null))))
                : (move.to_state === "submitted" && ppapNotReady
                    ? ppapNotReady + " required element" + (ppapNotReady === 1 ? "" : "s") + " still to fill"
                    : null);

            return {
                to: move.to_state,
                label: move.to_name || move.to_state,
                is_terminal: move.is_terminal,
                allowed: stepOk && closeOk && !gateBlocked,
                blocked_because: !stepOk
                    ? "Needs permission to " + (move.permission_description || move.required_permission).toLowerCase()
                    : (!closeOk ? "Closing this needs " + closeKey : gateBlocked)
            };
        });

        response.json({
            record,
            links: links.rows,
            history: history.rows,
            transitions
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- PDF export ----------
   GET /api/records/NCR-2026-0142/pdf

   A real, downloadable, branded file - not a browser print-to-PDF.
   Built with pdfkit: pure JS, no native binary, no headless browser,
   so this needed nothing heavier than what the project already
   depends on. Generic across every record type, the same way the
   detail panel is: it lists whatever is actually in data rather than
   knowing NCR has a disposition and CAPA has a root cause. */

function drawRecordHeader(doc, record) {
    doc.fontSize(19).fillColor(INK).font("Helvetica-Bold").text(record.number);
    doc.fontSize(12.5).fillColor(INK_2).font("Helvetica").text(record.title);
    doc.moveDown(0.4);

    doc.fontSize(9).fillColor(INK_2).font("Helvetica").text(
        "Type: " + (record.type_name || record.type)
        + "    Status: " + humanizeKey(record.status)
        + "    Severity: " + String(record.severity).toUpperCase()
    );

    const facts = [];
    if (record.owner) facts.push("Owner: " + record.owner);
    if (record.opened_at) facts.push("Opened: " + new Date(record.opened_at).toLocaleDateString());
    if (record.due_at) facts.push("Due: " + new Date(record.due_at).toLocaleDateString());
    if (record.closed_at) facts.push("Closed: " + new Date(record.closed_at).toLocaleDateString());
    if (facts.length > 0) doc.text(facts.join("    "));

    doc.moveDown(1);
}

/* Fallback for a record type with no form schema to draw from (should
   not happen for anything raised through this app, but a PDF export
   is the wrong place to 500 over it) - the flat, generic dump this
   function used to be the only version of. */
function drawGenericFields(doc, data) {
    const entries = Object.entries(data || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== "");

    if (entries.length === 0) return;

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Details");
    doc.moveDown(0.2);

    for (const [key, value] of entries) {
        doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
            .text(humanizeKey(key) + ":  ", { continued: true })
            .font("Helvetica").fillColor(INK)
            .text(String(value));
    }

    doc.moveDown(1);
}

/* A section banner matching the form itself: bold, uppercase, a
   hairline underneath - the same visual language the letterhead's
   own rule already uses, so a section heading here does not look
   like a new idiom invented just for this. */
function drawSectionHeading(doc, title) {
    doc.moveDown(0.3);
    doc.fontSize(10.5).font("Helvetica-Bold").fillColor(INK).text(title.toUpperCase());
    doc.moveTo(doc.page.margins.left, doc.y + 2)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
        .lineWidth(0.75).stroke(HAIRLINE);
    doc.moveDown(0.5);
}

/* A table field is an array of row objects keyed by the schema's
   column keys. Column counts vary wildly across QMS forms (a 5-Why
   is 3 columns, a PFMEA is 20+), so rather than squash a grid into
   portrait width, each row prints as a small labelled block - only
   its non-empty cells - which reads cleanly at any width. */
function drawTableField(doc, field, rows, userNames) {
    const columns = Array.isArray(field.columns) ? field.columns : [];
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
        .text((field.label || humanizeKey(field.key)) + ":");
    doc.moveDown(0.15);

    rows.forEach((row, index) => {
        if (!row || typeof row !== "object") return;

        doc.fontSize(8.5).font("Helvetica-Bold").fillColor(INK).text("  " + (index + 1) + ".");

        const cells = columns.length > 0
            ? columns.map((col) => [col.label || humanizeKey(col.key), row[col.key], col])
            : Object.entries(row).map(([key, value]) => [humanizeKey(key), value, { type: "text" }]);

        for (const [label, value, col] of cells) {
            if (value === null || value === undefined || value === "") continue;
            const text = formatFieldValue(col, value, userNames);
            doc.fontSize(8.5).font("Helvetica-Bold").fillColor(INK_2)
                .text("     " + label + ":  ", { continued: true, width })
                .font("Helvetica").fillColor(INK).text(text, { width });
        }
        doc.moveDown(0.25);
    });
    doc.moveDown(0.4);
}

/* A date field's value is the plain "YYYY-MM-DD" string forms.js
   stores it as - readable, but not what a person reads on a printed
   form. A "user" field's value is initials, the same short code the
   form's own dropdown carries as its option value; userNames turns
   that back into a name when one is known, without pretending an
   initials code no longer resolves when it does not. */
function formatFieldValue(field, value, userNames) {
    if (field.type === "date") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString();
    }

    if (field.type === "user" && userNames && userNames.has(value)) {
        return userNames.get(value) + " (" + value + ")";
    }

    return String(value);
}

/* The whole point of this export: a PDF laid out like the form that
   was actually filled in, not an alphabetised key/value dump. Reads
   the exact form version the record was raised under - schema.fields
   in their declared order, grouped under the same section headings
   forms.js groups them under on screen (public/js/forms.js,
   appendFieldsGrouped) - so a printed NCR reads the way the on-screen
   form reads, sections and all.

   A key present in data but no longer named by that version's schema
   (an older field, since renamed or removed in a later form version)
   is not dropped - it still happened, and this is meant to carry ALL
   of a record's information, not just what the current form asks
   for - it prints last, under "Additional details". */
function drawFormFields(doc, data, schema, userNames) {
    const values = data || {};
    const fields = (schema && Array.isArray(schema.fields)) ? schema.fields : [];

    if (fields.length === 0) {
        drawGenericFields(doc, values);
        return;
    }

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Form detail");
    doc.moveDown(0.2);

    const shown = new Set();
    let lastSection;
    let first = true;

    for (const field of fields) {
        const value = values[field.key];
        if (value === null || value === undefined || value === "") continue;
        /* an empty table array is nothing to print */
        if (field.type === "table" && (!Array.isArray(value) || value.length === 0)) continue;

        shown.add(field.key);

        const section = field.section || null;
        if (first || section !== lastSection) {
            if (section) drawSectionHeading(doc, section);
            lastSection = section;
            first = false;
        }

        const label = field.label || humanizeKey(field.key);

        if (field.type === "table") {
            drawTableField(doc, field, value, userNames);
            continue;
        }

        const text = formatFieldValue(field, value, userNames);

        if (field.type === "memo") {
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2).text(label + ":");
            doc.fontSize(9).font("Helvetica").fillColor(INK).text(text, {
                width: doc.page.width - doc.page.margins.left - doc.page.margins.right
            });
            doc.moveDown(0.4);
        } else {
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
                .text(label + ":  ", { continued: true })
                .font("Helvetica").fillColor(INK).text(text);
        }
    }

    const leftovers = Object.entries(values).filter(
        ([key, value]) => !shown.has(key) && value !== null && value !== undefined && value !== ""
            && !(Array.isArray(value) && value.length === 0)
    );

    if (leftovers.length > 0) {
        drawSectionHeading(doc, "Additional details");
        for (const [key, value] of leftovers) {
            if (Array.isArray(value)) {
                drawTableField(doc, { key, label: humanizeKey(key), columns: [] }, value, userNames);
                continue;
            }
            const text = value && typeof value === "object" ? JSON.stringify(value) : String(value);
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
                .text(humanizeKey(key) + ":  ", { continued: true })
                .font("Helvetica").fillColor(INK).text(text);
        }
    }

    doc.moveDown(1);
}

function drawHistory(doc, rows) {
    if (rows.length === 0) return;

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Audit trail");
    doc.moveDown(0.2);

    for (const row of rows) {
        const when = new Date(row.changed_at).toLocaleString();
        const who = row.changed_by || "System";
        const what = humanizeKey(row.field) + (row.new_value ? " -> " + row.new_value : "");

        doc.fontSize(8.5).font("Helvetica").fillColor(INK_2).text(when + "   " + who + "   " + what);
    }
}

records.get("/:number/pdf", async (request, response, next) => {
    try {
        const found = await query(
            SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]
        );

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const record = found.rows[0];

        const [org, history, formVersion, users] = await Promise.all([
            query("select name from organizations where id = $1", [request.user.org_id]),
            query(`
                select a.field, a.new_value, a.changed_at, u.full_name as changed_by
                  from audit_log a
             left join users u on u.id = a.changed_by
                 where a.record_id = $1
                 order by a.changed_at desc
                 limit 15
            `, [record.id]),
            query(
                "select schema from form_versions where record_type_id = $1 and version = $2",
                [record.record_type_id, record.form_version]
            ),
            query("select initials, full_name from users where org_id = $1", [request.user.org_id])
        ]);

        const orgName = org.rows[0]?.name || "";
        const schema = formVersion.rows[0]?.schema || null;
        const userNames = new Map(users.rows.map((row) => [row.initials, row.full_name]));

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + record.number + ".pdf\"");

        /* bufferPages holds every page until doc.end() instead of
           flushing each as it fills, so the footer can be stamped onto
           all of them afterward - a full-detail NCR routinely runs
           past one page now, and a footer drawn only once, on
           whichever page happened to be current when the content
           ended, used to mean the first page had none and a second,
           otherwise empty page had nothing else on it. */
        const doc = new PDFDocument({ size: "letter", margin: 54, bufferPages: true });
        doc.pipe(response);

        drawLetterhead(doc, orgName);
        drawRecordHeader(doc, record);
        drawFormFields(doc, record.data, schema, userNames);
        drawHistory(doc, history.rows);

        const pageRange = doc.bufferedPageRange();
        for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
            doc.switchToPage(i);
            drawFooter(doc, orgName);
        }

        doc.end();
    } catch (error) {
        next(error);
    }
});

/* Insert one record inside a caller-supplied transaction: allocate
   the next number for the type and year, resolve the owner initials,
   start it at the workflow's first state, write the creation audit
   row, and wire a SCAR's triggered_by into record_links. Shared by
   the single-record POST and the bulk importer so both number and
   audit records the same way. */
async function insertRecordRow(client, ctx) {
    const {
        orgId, userId, recordType, type, title, severity = "ok",
        ownerInitials, data, formVersion, dueAt = null, idempotencyKey = null
    } = ctx;

    const year = new Date().getFullYear();
    const pattern = recordType.prefix + "-" + year + "-%";

    const last = await client.query(`
        select number from records
         where org_id = $1 and record_type_id = $2 and number like $3
         order by number desc limit 1
    `, [orgId, recordType.id, pattern]);

    const nextSeq = last.rowCount === 0
        ? 1
        : Number(last.rows[0].number.split("-").pop()) + 1;

    const number = recordType.prefix + "-" + year + "-" + String(nextSeq).padStart(4, "0");

    const ownerRow = ownerInitials
        ? await client.query(
            "select id from users where org_id = $1 and initials = $2",
            [orgId, ownerInitials])
        : { rowCount: 0, rows: [] };
    const ownerId = ownerRow.rowCount ? ownerRow.rows[0].id : null;

    /* A new record starts at whatever this type's workflow calls its
       first state, not a literal 'draft'. 8D's first state is 'd1',
       for instance - a type with no workflow defined at all still
       falls back to 'draft' so creating one never hard-fails. */
    const firstState = await client.query(
        "select key from workflow_states where record_type_id = $1 order by position limit 1",
        [recordType.id]
    );
    const initialStatus = firstState.rowCount > 0 ? firstState.rows[0].key : "draft";

    const inserted = await client.query(`
        insert into records
            (org_id, record_type_id, number, title, status, severity,
             owner_id, data, form_version, created_by, due_at, idempotency_key)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        returning id, number, status
    `, [orgId, recordType.id, number, title, initialStatus, severity, ownerId,
        data, formVersion, userId, dueAt, idempotencyKey]);

    await client.query(`
        insert into audit_log
            (org_id, record_id, entity, entity_id, field, new_value, changed_by)
        values ($1, $2, 'records', $2, 'created', $3, $4)
    `, [orgId, inserted.rows[0].id, number, userId]);

    if (type === "scar" && data.triggered_by) {
        const source = await client.query(
            "select id from records where org_id = $1 and number = $2",
            [orgId, String(data.triggered_by).trim()]
        );
        if (source.rowCount > 0 && source.rows[0].id !== inserted.rows[0].id) {
            await client.query(`
                insert into record_links (from_record_id, to_record_id, link_type)
                values ($1, $2, 'caused_by')
                on conflict do nothing
            `, [inserted.rows[0].id, source.rows[0].id]);
        }
    }

    return inserted.rows[0];
}

/* ---------- create ----------
   POST /api/records
   { "type": "ncr", "title": "...", "owner": "MO", "data": { ... } }

   The payload is validated against the published form schema, so
   changing the form in the Form Builder changes what the API
   accepts without touching this file. */
records.post("/", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const { type, title, owner, severity = "ok", due_at, idempotency_key } = request.body || {};
        let data = withComputedRpn(type, request.body?.data || {});

        if (!type || !title) {
            return response.status(400).json({
                error: "type and title are required"
            });
        }

        /* A record queued offline and synced later carries a key it
           generated at creation time, not at sync time. If that key is
           already on a record in this org, the first attempt actually
           landed and only the confirmation was lost - hand back what
           already exists rather than raising a duplicate. */
        if (idempotency_key) {
            const existing = await query(
                "select id, number, status from records where org_id = $1 and idempotency_key = $2",
                [request.user.org_id, idempotency_key]
            );
            if (existing.rowCount > 0) {
                return response.status(200).json(existing.rows[0]);
            }
        }

        const dueAt = parseDueAt(due_at);
        if (!dueAt.ok) {
            return response.status(400).json({ error: "due_at is not a valid date" });
        }

        if (type === "audit" && await auditorConflict(query, request.user.org_id, data)) {
            return response.status(409).json({
                error: "That auditor works within the department under review",
                detail: "Clause 9.2 requires an auditor be independent of the area they audit."
            });
        }

        const typeRow = await query(
            "select id, prefix from record_types where org_id = $1 and key = $2",
            [request.user.org_id, type]
        );

        if (typeRow.rowCount === 0) {
            return response.status(400).json({ error: "Unknown record type: " + type });
        }

        const recordType = typeRow.rows[0];

        /* Validate against the newest published form version. */
        const formRow = await query(`
            select version, schema from form_versions
             where record_type_id = $1 and published_at is not null
             order by version desc limit 1
        `, [recordType.id]);

        let formVersion = 1;

        if (formRow.rowCount > 0) {
            formVersion = formRow.rows[0].version;
            data = applyComputedColumns(formRow.rows[0].schema, data);
            data = applyFairResults(type, data);
            const missing = (formRow.rows[0].schema.fields || [])
                .filter((field) => {
                    if (!field.required) return false;
                    const value = data[field.key];
                    /* a required table wants at least one row */
                    if (field.type === "table") return !Array.isArray(value) || value.length === 0;
                    return value === undefined;
                })
                .map((field) => field.key);

            if (missing.length > 0) {
                return response.status(422).json({
                    error: "Required fields missing",
                    fields: missing
                });
            }
        }

        const created = await withTransaction(async (client) => {
            return insertRecordRow(client, {
                orgId: request.user.org_id, userId: request.user.id,
                recordType, type, title, severity, ownerInitials: owner,
                data, formVersion, dueAt: dueAt.value, idempotencyKey: idempotency_key || null
            });
        }).catch(async (error) => {
            /* Lost a race to a concurrent identical retry - the unique
               index caught what the check above could not. Hand back
               the winner's record instead of failing the request. */
            if (error.code === "23505" && idempotency_key) {
                const winner = await query(
                    "select id, number, status from records where org_id = $1 and idempotency_key = $2",
                    [request.user.org_id, idempotency_key]
                );
                if (winner.rowCount > 0) return { row: winner.rows[0], alreadyExisted: true };
            }
            throw error;
        });

        if (created.alreadyExisted) {
            return response.status(200).json(created.row);
        }

        publish(request.user.org_id, { entity: "records", id: created.number, action: "created" });
        response.status(201).json(created);
    } catch (error) {
        next(error);
    }
});

/* ---------- update ----------
   PATCH /api/records/NCR-2026-0142
   { "data": { "disposition": "Scrap" }, "reason": "MRB decision" }

   Every changed field writes an audit_log row in the same
   transaction. There is no code path that changes a record without
   leaving a trace. */
records.patch("/:number", requirePermission(editPermissionFor), async (request, response, next) => {
    try {
        const { data = {}, severity, reason, due_at, title } = request.body || {};

        /* Distinct from due_at being sent as null or "" (which means
           "clear it"): a PATCH that never mentions due_at at all - the
           common case, editing an ordinary data field - must leave the
           existing due date exactly alone rather than wiping it out. */
        const dueAtProvided = Object.prototype.hasOwnProperty.call(request.body || {}, "due_at");

        const dueAt = dueAtProvided ? parseDueAt(due_at) : { ok: true, value: undefined };
        if (!dueAt.ok) {
            return response.status(400).json({ error: "due_at is not a valid date" });
        }

        const titleProvided = Object.prototype.hasOwnProperty.call(request.body || {}, "title");
        if (titleProvided && !String(title || "").trim()) {
            return response.status(400).json({ error: "title cannot be blank" });
        }

        const updated = await withTransaction(async (client) => {
            const current = await client.query(`
                select r.id, r.title, r.data, r.severity, r.due_at, r.record_type_id,
                       r.form_version, rt.key as type
                  from records r join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return null;

            const record = current.rows[0];

            /* Who made this change is who is signed in, never a value the
               client sends. The audit log is only worth anything if the
               server, not the caller, decides whose name goes on it. */
            const actorId = request.user.id;

            let merged = withComputedRpn(record.type, { ...record.data, ...data });

            /* Recompute any "computed" table columns against the form
               version this record was raised under. */
            const schemaRow = await client.query(
                "select schema from form_versions where record_type_id = $1 and version = $2",
                [record.record_type_id, record.form_version]
            );
            merged = applyComputedColumns(schemaRow.rows[0]?.schema || null, merged);
            merged = applyFairResults(record.type, merged);

            if (record.type === "audit"
                && await auditorConflict((text, params) => client.query(text, params), request.user.org_id, merged)) {
                return { conflict: "That auditor works within the department under review" };
            }

            /* A risk's rpn/residual_rpn are derived, not sent by the
               caller, so they never appear in the plain "what did the
               client ask to change" set below - audited against the
               full merged-and-computed result instead, for this type
               only, so a scores edit still leaves its own trail on the
               number it actually changes. */
            const auditAgainst = record.type === "risk" ? merged : data;

            for (const [key, value] of Object.entries(auditAgainst)) {
                const before = record.data[key];
                if (String(before) === String(value)) continue;

                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, $3, $4, $5, $6, $7)
                `, [request.user.org_id, record.id, key,
                    before === undefined ? null : String(before),
                    String(value), reason || null, actorId]);
            }

            /* Unchanged (undefined) when the caller never mentioned
               due_at at all; otherwise the new value, parsed above,
               which is legitimately null when the intent was to clear
               a date that was set before. */
            const nextDueAt = dueAtProvided ? dueAt.value : record.due_at;

            if (dueAtProvided) {
                const beforeIso = record.due_at ? new Date(record.due_at).toISOString() : null;
                if (beforeIso !== dueAt.value) {
                    await client.query(`
                        insert into audit_log
                            (org_id, record_id, entity, entity_id, field,
                             old_value, new_value, reason, changed_by)
                        values ($1, $2, 'records', $2, 'due_at', $3, $4, $5, $6)
                    `, [request.user.org_id, record.id, beforeIso, dueAt.value, reason || null, actorId]);
                }
            }

            const nextTitle = titleProvided ? title.trim() : record.title;

            if (titleProvided && nextTitle !== record.title) {
                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, 'title', $3, $4, $5, $6)
                `, [request.user.org_id, record.id, record.title, nextTitle, reason || null, actorId]);
            }

            const result = await client.query(`
                update records
                   set data = $2,
                       severity = coalesce($3, severity),
                       due_at = $4,
                       title = $5
                 where id = $1
                returning id, number, title, status, severity, data, due_at
            `, [record.id, merged, severity || null, nextDueAt, nextTitle]);

            return result.rows[0];
        });

        if (!updated) {
            return response.status(404).json({ error: "Record not found" });
        }

        if (updated.conflict) {
            return response.status(409).json({
                error: updated.conflict,
                detail: "Clause 9.2 requires an auditor be independent of the area they audit."
            });
        }

        publish(request.user.org_id, {
            entity: "records", id: request.params.number, action: "updated"
        });
        response.json(updated);
    } catch (error) {
        next(error);
    }
});

/* ---------- links between records ----------
   POST   /api/records/NCR-2026-0142/links   { to: "CAPA-2026-0005", link_type }
   DELETE /api/records/NCR-2026-0142/links/CAPA-2026-0005

   record_links carries no org_id, so both ends are checked against
   the caller's org here. Linking two records anyone can already see
   is low-stakes metadata, so it needs only a session, the same as
   attachments. link_type defaults to 'related'. */
const LINK_TYPES = new Set(["related", "caused_by", "corrects", "supersedes", "child_of"]);

async function findRecordInOrg(orgId, number) {
    const found = await query(
        "select id, number from records where org_id = $1 and number = $2",
        [orgId, number]
    );
    return found.rowCount > 0 ? found.rows[0] : null;
}

/* ---------- concurrent-edit presence (P3.3) ----------
   PUT    /api/records/NCR-2026-0142/editing   heartbeat while the
                                               editor is open
   DELETE /api/records/NCR-2026-0142/editing   editor closed

   The PUT answers with who else has it open right now, so the opener
   sees a warning immediately without waiting for the next SSE frame. */
records.put("/:number/editing", async (request, response, next) => {
    try {
        const record = await findRecordInOrg(request.user.org_id, request.params.number);
        if (!record) return response.status(404).json({ error: "Record not found" });

        const editors = heartbeat(request.user.org_id, record.number, request.user)
            .filter((e) => e.id !== request.user.id);
        response.json({ editors });
    } catch (error) {
        next(error);
    }
});

records.delete("/:number/editing", async (request, response, next) => {
    try {
        leaveEditing(request.user.org_id, request.params.number, request.user.id);
        response.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

records.post("/:number/links", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const targetNumber = (request.body?.to || "").trim();
        if (!targetNumber) return response.status(400).json({ error: "to is required" });

        const linkType = LINK_TYPES.has(request.body?.link_type) ? request.body.link_type : "related";

        const from = await findRecordInOrg(request.user.org_id, request.params.number);
        if (!from) return response.status(404).json({ error: "No such record" });

        const to = await findRecordInOrg(request.user.org_id, targetNumber);
        if (!to) return response.status(404).json({ error: "No record " + targetNumber });

        if (from.id === to.id) {
            return response.status(400).json({ error: "A record cannot link to itself" });
        }

        /* A link is undirected for the reader: don't let A->B and B->A
           of the same kind both exist. */
        const existing = await query(`
            select 1 from record_links
             where link_type = $3
               and ((from_record_id = $1 and to_record_id = $2)
                 or (from_record_id = $2 and to_record_id = $1))
        `, [from.id, to.id, linkType]);
        if (existing.rowCount > 0) {
            return response.status(409).json({ error: from.number + " is already linked to " + to.number });
        }

        await withTransaction(async (client) => {
            await client.query(`
                insert into record_links (from_record_id, to_record_id, link_type)
                values ($1, $2, $3)
            `, [from.id, to.id, linkType]);

            await client.query(`
                insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'record_links', $2, 'linked', $3, $4)
            `, [request.user.org_id, from.id, to.number + " (" + linkType + ")", request.user.id]);
        });

        response.status(201).json({ from: from.number, to: to.number, link_type: linkType });
    } catch (error) {
        next(error);
    }
});

records.delete("/:number/links/:target", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const from = await findRecordInOrg(request.user.org_id, request.params.number);
        const to = await findRecordInOrg(request.user.org_id, request.params.target);
        if (!from || !to) return response.status(404).json({ error: "No such record" });

        const removed = await query(`
            delete from record_links
             where (from_record_id = $1 and to_record_id = $2)
                or (from_record_id = $2 and to_record_id = $1)
            returning id
        `, [from.id, to.id]);

        if (removed.rowCount === 0) {
            return response.status(404).json({ error: from.number + " is not linked to " + to.number });
        }

        await query(`
            insert into audit_log (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'record_links', $2, 'unlinked', $3, $4)
        `, [request.user.org_id, from.id, to.number, request.user.id]);

        response.json({ removed: removed.rowCount });
    } catch (error) {
        next(error);
    }
});

/* ---------- attachments ----------
   GET  /api/records/NCR-2026-0142/attachments
   POST /api/records/NCR-2026-0142/attachments
       multipart with a `file`  ->  the file is stored and served back
       or JSON { filename, storage_key: "\\\\qms\\evidence\\x.pdf" }
                                ->  a link to a file kept elsewhere
   GET  /api/records/NCR-2026-0142/attachments/<id>/file
       streams an uploaded file back

   An uploaded file lives under server/storage via file-storage.js,
   the same place drawings, controlled documents and receiving photos
   go. The older "link to a file elsewhere" form still works for orgs
   that keep evidence on a network share - such a row has a
   storage_key and no storage_path. Either way the row is real, so the
   closure gates that check for an attachment are not checking a
   stub. */
records.get("/:number/attachments", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const record = await query(
            "select id from records where org_id = $1 and number = $2",
            [request.user.org_id, request.params.number]
        );
        if (record.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        const result = await query(`
            select a.id, a.filename, a.mime_type, a.size_bytes, a.storage_key,
                   (a.storage_path is not null) as has_file,
                   a.uploaded_at, u.full_name as uploaded_by
              from attachments a
         left join users u on u.id = a.uploaded_by
             where a.record_id = $1
             order by a.uploaded_at desc
        `, [record.rows[0].id]);

        response.json({ count: result.rowCount, attachments: result.rows });
    } catch (error) {
        next(error);
    }
});

records.post("/:number/attachments", upload.single("file"), async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const record = await query(
            "select id from records where org_id = $1 and number = $2",
            [request.user.org_id, request.params.number]
        );
        if (record.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        let filename;
        let storagePath = null;
        let storageKey = null;
        let mimeType = null;
        let sizeBytes = null;

        if (request.file) {
            filename = request.file.originalname;
            mimeType = request.file.mimetype || null;
            sizeBytes = request.file.size;
            storagePath = await saveUploadedFile(
                "record-attachments", ATTACHMENT_EXTENSIONS,
                request.file.originalname, request.file.buffer);
        } else {
            const body = request.body || {};
            filename = (body.filename || "").trim();
            storageKey = (body.storage_key || "").trim();
            mimeType = body.mime_type || null;
            sizeBytes = Number.isFinite(Number(body.size_bytes)) ? Number(body.size_bytes) : null;
            if (!filename || !storageKey) {
                return response.status(400).json({
                    error: "Attach a file, or give a filename and a storage_key (path or link)"
                });
            }
        }

        const inserted = await query(`
            insert into attachments
                (record_id, filename, mime_type, size_bytes, storage_key, storage_path, uploaded_by)
            values ($1, $2, $3, $4, $5, $6, $7)
            returning id, filename, mime_type, size_bytes, storage_key,
                      (storage_path is not null) as has_file, uploaded_at
        `, [record.rows[0].id, filename, mimeType, sizeBytes,
            storageKey, storagePath, request.user.id]);

        await query(`
            insert into audit_log
                (org_id, record_id, entity, entity_id, field, new_value, changed_by)
            values ($1, $2, 'attachments', $3, 'added', $4, $5)
        `, [request.user.org_id, record.rows[0].id, inserted.rows[0].id, filename, request.user.id]);

        response.status(201).json(inserted.rows[0]);
    } catch (error) {
        if (error.status) return response.status(error.status).json({ error: error.message });
        next(error);
    }
});

/* Streams an uploaded attachment back. A link-only row (storage_key,
   no stored file) has nothing to serve - 404, the client shows the
   path instead. */
records.get("/:number/attachments/:id/file", async (request, response, next) => {
    try {
        if (!request.user) return response.status(401).json({ error: "Not signed in" });

        const found = await query(`
            select a.filename, a.mime_type, a.storage_path
              from attachments a
              join records r on r.id = a.record_id
             where r.org_id = $1 and r.number = $2 and a.id = $3
        `, [request.user.org_id, request.params.number, request.params.id]);

        if (found.rowCount === 0 || !found.rows[0].storage_path) {
            return response.status(404).json({ error: "No file on that attachment" });
        }
        const attachment = found.rows[0];

        const buffer = await readUploadedFile(attachment.storage_path);
        const disposition = INLINE_ATTACHMENT_MIME.has(attachment.mime_type) ? "inline" : "attachment";

        response.setHeader("Content-Type", attachment.mime_type || "application/octet-stream");
        response.setHeader("Content-Disposition",
            disposition + "; filename=\"" + (attachment.filename || "attachment") + "\"");
        response.send(buffer);
    } catch (error) {
        if (error.status) return response.status(error.status).json({ error: error.message });
        next(error);
    }
});

/* ---------- workflow transition ----------
   POST /api/records/NCR-2026-0142/transition
   { "to": "mrb", "actor": "MO" }

   Refuses any move the workflow does not define. This is the rule
   that stops a record skipping containment and going straight to
   closed. */
records.post("/:number/transition", async (request, response, next) => {
    try {
        const { to, reason } = request.body || {};

        if (!to) {
            return response.status(400).json({ error: "to is required" });
        }

        if (!request.user) {
            return response.status(401).json({ error: "Not signed in" });
        }

        const outcome = await withTransaction(async (client) => {
            const current = await client.query(`
                select r.id, r.status, r.record_type_id, r.data, rt.key as type
                  from records r
                  join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return { code: 404 };

            const record = current.rows[0];

            const allowed = await client.query(`
                select required_permission from workflow_transitions
                 where record_type_id = $1 and from_state = $2 and to_state = $3
            `, [record.record_type_id, record.status, to]);

            if (allowed.rowCount === 0) {
                return {
                    code: 409,
                    body: {
                        error: "Transition not allowed",
                        from: record.status,
                        to
                    }
                };
            }

            /* One model of authority, not two. The step names a
               permission; whether this person's role carries it is the
               permission grid's business, and seniority falls out of
               that rather than needing a special case. */
            const stepKey = allowed.rows[0].required_permission;

            if (stepKey && !request.can(stepKey)) {
                return {
                    code: 403,
                    body: {
                        error: "Your role does not permit this step",
                        required: stepKey,
                        your_role: request.user.role_name
                    }
                };
            }

            const terminal = await client.query(`
                select is_terminal from workflow_states
                 where record_type_id = $1 and key = $2
            `, [record.record_type_id, to]);

            const isTerminal = terminal.rowCount > 0 && terminal.rows[0].is_terminal;

            /* Closing a record is a separate authority from working it. */
            const closeKey = isTerminal ? closePermissionFor(record.type) : null;

            if (closeKey && !request.can(closeKey)) {
                return {
                    code: 403,
                    body: {
                        error: "Your role does not permit closing this record",
                        required: closeKey,
                        your_role: request.user.role_name
                    }
                };
            }

            /* Verifying an audit closed is the other half of clause 9.2 -
               a conflict that somehow made it into a record's data
               (raised before this check existed, or edited around it)
               is caught again here, at the moment the audit is actually
               signed off, not only at the moment it was scheduled. */
            if (isTerminal && record.type === "audit"
                && await auditorConflict((text, params) => client.query(text, params), request.user.org_id, record.data)) {
                return {
                    code: 409,
                    body: {
                        error: "That auditor works within the department under review",
                        detail: "Clause 9.2 requires an auditor be independent of the area they audit."
                    }
                };
            }

            /* Clause 10.2: closing a CAPA without evidence the
               corrective action was actually validated is exactly the
               gap between "we planned a fix" and "we proved the fix
               worked" that this clause exists to close. */
            if (isTerminal && record.type === "capa"
                && !await hasAttachment((text, params) => client.query(text, params), record.id)) {
                return {
                    code: 409,
                    body: {
                        error: "At least one validation attachment is required before closing this CAPA",
                        detail: "Clause 10.2 requires evidence the corrective action was verified effective."
                    }
                };
            }

            /* Clause 9.2: a DI is not resolved until all three of its
               forms are on file. */
            if (isTerminal && record.type === "di") {
                const missing = await diFormsMissing(
                    (text, params) => client.query(text, params), record.id);
                if (missing.length > 0) {
                    return {
                        code: 409,
                        body: {
                            error: "Attach all three forms before closing this DI",
                            missing
                        }
                    };
                }
            }

            /* Clause 8.3.4.4: a PPAP cannot be submitted until every
               element its level requires is on file. */
            if (record.type === "ppap" && to === "submitted") {
                const missing = await ppapMissing(
                    (text, params) => client.query(text, params), record.id, record.data);
                if (missing.length > 0) {
                    return {
                        code: 409,
                        body: {
                            error: "Fill every required element before submitting this PPAP",
                            missing: missing.map((m) => m.name)
                        }
                    };
                }
            }

            /* And an audit is not resolved until the DI it raised is. */
            if (isTerminal && record.type === "audit") {
                const openDi = await openDiForAudit(
                    (text, params) => client.query(text, params), record.id);
                if (openDi) {
                    return {
                        code: 409,
                        body: {
                            error: "This audit's Discrepancy Investigation (" + openDi + ") is not closed",
                            detail: "Clause 9.2 - the finding is not resolved until its investigation is closed."
                        }
                    };
                }
            }

            const actorId = request.user.id;

            const moved = await client.query(`
                update records
                   set status = $2,
                       closed_at = case when $3 then now() else closed_at end
                 where id = $1
                returning id, number, status, closed_at
            `, [record.id, to, isTerminal]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field,
                     old_value, new_value, reason, changed_by)
                values ($1, $2, 'records', $2, 'status', $3, $4, $5, $6)
            `, [request.user.org_id, record.id, record.status, to, reason || null, actorId]);

            return { code: 200, body: moved.rows[0] };
        });

        if (outcome.code === 404) {
            return response.status(404).json({ error: "Record not found" });
        }

        if (outcome.code === 200) {
            publish(request.user.org_id, {
                entity: "records", id: outcome.body.number, action: "transitioned"
            });
        }
        response.status(outcome.code).json(outcome.body);
    } catch (error) {
        next(error);
    }
});
