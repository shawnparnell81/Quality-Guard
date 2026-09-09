/* ============================================================
   Quality events.

   NCR, CAPA, 8D, complaint, SCAR, audit and risk all route through
   this one file, because they are all rows in the records table.
   The record type is a query parameter, not a separate endpoint.
   ============================================================ */

import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import { query, withTransaction } from "../db.js";
import {
    requirePermission, createPermissionFor, closePermissionFor,
    readPermissionFor, unreadableTypes
} from "../auth.js";
import { upload } from "../uploads.js";
import { log } from "../logger.js";
import { saveUploadedFile, readUploadedFile } from "../file-storage.js";
import { fillTemplate, readTemplate } from "../excel-fill.js";
import { INK, INK_2, HAIRLINE, drawLetterhead, drawFooter, humanizeKey } from "../pdf-branding.js";
import { formatValue, isEmpty } from "../../../public/js/format.js";
import { evaluate as evalExpr } from "../../../public/js/expr.js";
import { checkRules } from "../../../public/js/rules.js";
import { ppapMissing } from "./ppap.js";
import { notify } from "./notifications.js";
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
   value is worked out from other number columns in the same row.
   Either a fixed op (compute:"product"|"sum" over inputs:[...]) or a
   free expression (expr:"sev * occ * det", evaluated by expr.js). The
   in-app editor fills these live; recomputed here from the schema so
   a stored value can never disagree with the numbers it is made of,
   the same guarantee withComputedRpn gives the built-in risk record.
   A no-op unless the published form actually defines a computed
   column. */
function computeCell(col, row) {
    if (typeof col.expr === "string" && col.expr.trim()) {
        return evalExpr(col.expr, row);   // undefined when not yet computable
    }
    const nums = (col.inputs || []).map((k) => Number(row[k]));
    if (nums.length === 0 || !nums.every((n) => Number.isFinite(n))) return undefined;
    return col.compute === "sum"
        ? nums.reduce((a, b) => a + b, 0)
        : nums.reduce((a, b) => a * b, 1);
}

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
                const value = computeCell(col, next);
                if (value === undefined) delete next[col.key];
                else next[col.key] = value;
            }
            return next;
        });
    }
    return out;
}

const ROW_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Every row of a table field carries a stable "_id" so a per-row
   attachment (attachments.row_ref = "<fieldKey>:<_id>") stays pinned
   to its row across edits, inserts and reorders.

   The id is SERVER-OWNED (audit M5). The client's "_id" is advisory:
   on a write it is honoured only when it is a real uuid that this
   record already carries for that table AND has not been sent twice
   in the same array. Anything else - a made-up id, a collision, an
   id lifted from another record - is replaced with a fresh one, and
   uniqueness within the array is guaranteed. On create (`prior`
   omitted) every row gets a fresh id regardless of what was sent. A
   no-op unless the schema declares a table field carrying rows. */
function ensureRowIds(schema, data, prior) {
    const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
    if (!data || typeof data !== "object" || fields.length === 0) return data;

    let out = data;
    for (const field of fields) {
        if (field.type !== "table") continue;
        const rows = Array.isArray(out[field.key]) ? out[field.key] : null;
        if (!rows) continue;

        const known = new Set(
            (prior && Array.isArray(prior[field.key]) ? prior[field.key] : [])
                .filter((r) => r && typeof r._id === "string" && ROW_ID_RE.test(r._id))
                .map((r) => r._id)
        );
        const taken = new Set();

        let touched = false;
        const next = rows.map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return row;
            const claimed = typeof row._id === "string" ? row._id : "";
            const keep = claimed && known.has(claimed) && !taken.has(claimed);
            const id = keep ? claimed : randomUUID();
            taken.add(id);
            if (id === row._id) return row;
            touched = true;
            return { ...row, _id: id };
        });
        if (touched) {
            if (out === data) out = { ...data };
            out[field.key] = next;
        }
    }
    return out;
}

/* The mirror of ensureRowIds: drop every table row's "_id" so a
   clone starts clean and never shares a row_ref with its source.
   Mutates the object it is given (a fresh seed copy in every caller). */
function stripRowIds(schema, data) {
    const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
    for (const field of fields) {
        if (field.type !== "table" || !Array.isArray(data[field.key])) continue;
        data[field.key] = data[field.key].map((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return row;
            const { _id, ...rest } = row;
            return rest;
        });
    }
}

/* The audit_log lines for a table field that changed: one per row
   added, removed or edited, matched by the row's stable _id, instead
   of a single useless "[object Object] -> [object Object]" for the
   whole array. `after` should be the post-compute rows (so computed
   cells and assigned ids are the ones actually stored). */
function tableRowAudits(fieldKey, beforeRows, afterRows) {
    const strip = (row) => { const { _id, ...rest } = row || {}; return rest; };
    const asMap = (rows) => new Map(
        (Array.isArray(rows) ? rows : [])
            .filter((r) => r && typeof r === "object" && !Array.isArray(r))
            .map((r) => [r._id, r])
    );
    const before = asMap(beforeRows);
    const after = asMap(afterRows);
    const lines = [];

    for (const [id, row] of after) {
        const prev = before.get(id);
        if (!prev) {
            lines.push({ field: fieldKey + " (row added)", old_value: null, new_value: JSON.stringify(strip(row)) });
        } else if (JSON.stringify(strip(prev)) !== JSON.stringify(strip(row))) {
            lines.push({
                field: fieldKey + " (row " + String(id || "").slice(0, 8) + ")",
                old_value: JSON.stringify(strip(prev)),
                new_value: JSON.stringify(strip(row))
            });
        }
    }
    for (const [id, row] of before) {
        if (!after.has(id)) {
            lines.push({ field: fieldKey + " (row removed)", old_value: JSON.stringify(strip(row)), new_value: null });
        }
    }
    return lines;
}

/* ---------- content-bound signatures (audit P2 / M6) ----------
   A signature stops being a free string and becomes a sealed record:
   who signed, when, which form version, and a hash of the rest of the
   form data at that moment. On read the hash is recomputed; if it no
   longer matches, the record was edited after signing and the detail
   view / PDF say so. Legacy string signatures are left untouched. */
function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === "object") {
        return Object.keys(value).sort().reduce((o, k) => { o[k] = stableJson(value[k]); return o; }, {});
    }
    return value;
}

function hashData(schema, data) {
    const sigKeys = new Set(((schema && schema.fields) || [])
        .filter((f) => f.type === "signature").map((f) => f.key));
    const bare = {};
    for (const k of Object.keys(data || {})) if (!sigKeys.has(k)) bare[k] = data[k];
    return createHash("sha256").update(JSON.stringify(stableJson(bare))).digest("hex");
}

/* Replace any signature field the caller is completing (was empty,
   now truthy) with a sealed object. An already-sealed signature is
   kept exactly - an edit never re-signs in whoever made it. */
function stampSignatures(schema, data, before, user, formVersion) {
    const sigFields = ((schema && schema.fields) || []).filter((f) => f.type === "signature");
    if (!sigFields.length || !data || typeof data !== "object") return data;

    let out = data;
    for (const f of sigFields) {
        const prior = before && before[f.key];
        if (prior && typeof prior === "object" && prior.data_hash) {
            if (out[f.key] !== prior) {
                if (out === data) out = { ...data };
                out[f.key] = prior;
            }
            continue;
        }
        const asked = out[f.key];
        const wantsSign = asked !== undefined && asked !== null && asked !== "" && asked !== false;
        if (!wantsSign) continue;

        if (out === data) out = { ...data };
        out[f.key] = {
            signer: user.full_name,
            initials: user.initials,
            role: user.role_name || user.role || null,
            at: new Date().toISOString(),
            form_version: formVersion,
            data_hash: hashData(schema, out)
        };
    }
    return out;
}

/* For the detail view / PDF: per signature field, who signed and
   whether the rest of the record is unchanged since. undefined when
   the form has no signatures. */
function checkSignatures(schema, data) {
    const out = {};
    for (const f of ((schema && schema.fields) || [])) {
        if (f.type !== "signature") continue;
        const v = data && data[f.key];
        if (v === undefined || v === null || v === "") continue;

        if (typeof v !== "object" || !v.data_hash) {
            out[f.key] = { signer: String(v), legacy: true };
            continue;
        }
        const intact = v.data_hash === hashData(schema, data);
        out[f.key] = {
            signer: v.signer, initials: v.initials, role: v.role,
            at: v.at, form_version: v.form_version,
            intact,
            note: intact ? "unchanged since signing" : "record edited after signing"
        };
    }
    return Object.keys(out).length ? out : undefined;
}

/* Push a notification for each notify-rule that matched, to every
   active user in the org holding the named role. Dedup-keyed on the
   record + the rule text so re-saving does not re-notify, and it can
   never fail the write that triggered it. */
async function fireRuleNotifications(orgId, type, number, ruleNotify) {
    for (const n of ruleNotify || []) {
        if (!n.role) continue;
        try {
            const people = await query(
                "select id from users where org_id = $1 and role = $2 and active",
                [orgId, n.role]);
            for (const p of people.rows) {
                await notify(orgId, p.id, {
                    kind: "rule",
                    title: number + " - " + n.message,
                    link_type: type,
                    link_number: number,
                    dedupe_key: "rule:" + number + ":" + n.message
                });
            }
        } catch { /* notifications are best-effort */ }
    }
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

/* An opaque per-record version token for optimistic concurrency. The
   records_touch trigger bumps updated_at on every write, so its epoch
   millis is a monotonic stamp the client can hand back as If-Match /
   expected_version to be told "someone else changed this" (409)
   instead of silently overwriting them. */
function recordVersion(updatedAt) {
    return updatedAt ? String(new Date(updatedAt).getTime()) : null;
}

/* The version the client says it last saw, from an If-Match header
   (weak-validator prefix and quotes tolerated) or an expected_version
   field in the body. null means it sent neither - the write proceeds
   without the concurrency check, so old clients are unaffected. */
function requestedVersion(request) {
    const header = request.headers["if-match"];
    if (header && header !== "*") return header.replace(/^W\//, "").replace(/"/g, "").trim();
    const body = request.body && request.body.expected_version;
    return body === undefined || body === null ? null : String(body);
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
           r.updated_at,
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
/* ---------- data.<key> register filters (audit P2 / M13) ----------
   ?filter=key:op:value  (repeatable). `key` is a published field key,
   or "<tablekey>.<colkey>" to match ANY row of a table field. Every
   value is a bound parameter; every key is checked against the form
   schema and a strict charset, so no caller text is interpolated into
   SQL. Requires ?type - that is where the schema comes from. */
const FILTER_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "present", "absent"]);
const SQL_CMP = { gt: ">", gte: ">=", lt: "<", lte: "<=" };
const FILTER_KEY_RX = /^[a-z0-9_]+$/i;

function fieldCondition(colExpr, op, value, params) {
    if (op === "present") return colExpr + " is not null and " + colExpr + " <> ''";
    if (op === "absent")  return "(" + colExpr + " is null or " + colExpr + " = '')";
    params.push(value);
    const p = "$" + params.length;
    if (op === "eq")       return colExpr + " = " + p;
    if (op === "ne")       return "(" + colExpr + " is distinct from " + p + ")";
    if (op === "contains") return colExpr + " ilike ('%' || " + p + " || '%')";
    /* gt/gte/lt/lte - only compare cells that actually look numeric,
       so a stray text value cannot 500 the query on a bad cast */
    return colExpr + " ~ '^-?[0-9]+(\\.[0-9]+)?$' and (" + colExpr + ")::numeric "
        + SQL_CMP[op] + " " + p + "::numeric";
}

function parseDataFilters(rawList, schema, params) {
    const fields = (schema && schema.fields) || [];
    const flat = new Set(fields.filter((f) => f.type !== "table").map((f) => f.key));
    const tables = new Map(fields.filter((f) => f.type === "table")
        .map((f) => [f.key, new Set((f.columns || []).map((c) => c.key))]));

    const conditions = [];
    const rejected = [];

    for (const raw of rawList) {
        const parts = String(raw).split(":");
        const key = parts[0];
        const op = parts[1];
        const value = parts.slice(2).join(":");

        if (!op || !FILTER_OPS.has(op)) { rejected.push(raw + " (unknown operator)"); continue; }
        if (op !== "present" && op !== "absent" && value === "") {
            rejected.push(raw + " (missing value)"); continue;
        }

        const dot = key.indexOf(".");
        if (dot === -1) {
            if (!FILTER_KEY_RX.test(key) || !flat.has(key)) {
                rejected.push(raw + " (no such field)"); continue;
            }
            conditions.push(fieldCondition("(r.data->>'" + key + "')", op, value, params));
        } else {
            const tkey = key.slice(0, dot);
            const ckey = key.slice(dot + 1);
            if (!FILTER_KEY_RX.test(tkey) || !FILTER_KEY_RX.test(ckey)
                || !(tables.get(tkey) && tables.get(tkey).has(ckey))) {
                rejected.push(raw + " (no such table column)"); continue;
            }
            const inner = fieldCondition("(e->>'" + ckey + "')", op, value, params);
            conditions.push("exists (select 1 from jsonb_array_elements("
                + "coalesce(r.data->'" + tkey + "', '[]'::jsonb)) e where " + inner + ")");
        }
    }
    return { conditions, rejected };
}

async function buildRecordFilter(request) {
    const conditions = [];
    const params = [request.user.org_id];

    /* Read scoping. A ?type the caller cannot read is a 403; without a
       ?type, the register is silently narrowed to the types they can
       read (types with no .read permission are always readable). */
    if (request.query.type) {
        const needed = readPermissionFor(request.query.type);
        if (needed && !request.can(needed)) return { forbidden: needed };
    } else {
        const hidden = unreadableTypes(request);
        if (hidden.length) {
            params.push(hidden);
            conditions.push("rt.key <> all($" + params.length + ")");
        }
    }

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

    /* data.<key> filters, if any - need the type's published schema */
    let filterWarnings = [];
    const rawFilters = [].concat(request.query.filter || []).filter(Boolean);
    if (rawFilters.length) {
        if (!request.query.type) {
            filterWarnings = ["field filters were ignored: add ?type to say which form's fields"];
        } else {
            const schemaRow = await query(`
                select fv.schema from form_versions fv
                  join record_types rt on rt.id = fv.record_type_id
                 where rt.org_id = $1 and rt.key = $2 and fv.published_at is not null
                 order by fv.version desc limit 1
            `, [request.user.org_id, request.query.type]);
            const { conditions: dataConds, rejected } =
                parseDataFilters(rawFilters, schemaRow.rows[0]?.schema, params);
            conditions.push(...dataConds);
            filterWarnings = rejected;
        }
    }

    return {
        where: conditions.length ? " and " + conditions.join(" and ") : "",
        params,
        filterWarnings
    };
}

function sortClause(request) {
    const column = SORT_COLUMNS[request.query.sort] || "r.opened_at";
    const dir = request.query.dir === "asc" ? "asc" : "desc";
    return " order by " + column + " " + dir + " nulls last, r.number desc";
}

records.get("/", async (request, response, next) => {
    try {
        const filter = await buildRecordFilter(request);
        if (filter.forbidden) {
            return response.status(403).json({
                error: "Your role does not permit this",
                required: filter.forbidden,
                your_role: request.user.role_name
            });
        }
        const { where, params } = filter;

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
            records: rows.rows,
            ...(filter.filterWarnings && filter.filterWarnings.length
                ? { filter_warnings: filter.filterWarnings } : {})
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
        const filter = await buildRecordFilter(request);
        if (filter.forbidden) {
            return response.status(403).json({
                error: "Your role does not permit this",
                required: filter.forbidden,
                your_role: request.user.role_name
            });
        }
        const { where, params } = filter;
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

const FLAT_FIELD_TYPES = new Set(["text", "memo", "number", "date", "select", "link", "user", "boolean"]);

/* Spreadsheet spellings of a ticked / unticked box. Everything else
   in a boolean cell is an error the importer surfaces for review. */
const BOOL_TRUE = new Set(["true", "yes", "y", "1", "x", "✓", "checked", "on"]);
const BOOL_FALSE = new Set(["false", "no", "n", "0", "-", "unchecked", "off"]);

async function loadPublishedForm(recordTypeId) {
    const row = await query(`
        select version, schema from form_versions
         where record_type_id = $1 and published_at is not null
         order by version desc limit 1
    `, [recordTypeId]);
    return row.rowCount > 0 ? row.rows[0] : null;
}

/* The customer's own Excel template for a form version, if one is set
   up: { map, schema, templateBuffer } ready for fillTemplate /
   readTemplate. version === undefined means "latest published".
   Returns null when there is no map or the stored file is gone - the
   caller then falls back to the generated grid. */
async function loadTemplateFill(recordTypeId, version) {
    const row = version === undefined
        ? await query(`select schema, excel_map from form_versions
                        where record_type_id = $1 and published_at is not null
                        order by version desc limit 1`, [recordTypeId])
        : await query(`select schema, excel_map from form_versions
                        where record_type_id = $1 and version = $2`, [recordTypeId, version]);

    const found = row.rows[0];
    const map = found && found.excel_map;
    if (!map || !map.template_path) return null;

    try {
        const templateBuffer = await readUploadedFile(map.template_path);
        return { map, schema: found.schema || { fields: [] }, templateBuffer };
    } catch {
        return null;   // file missing - fall back rather than 500
    }
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
    if (field.type === "boolean") {
        if (typeof raw === "boolean") return raw;
        const t = String(raw).trim().toLowerCase();
        if (BOOL_TRUE.has(t)) return true;
        if (BOOL_FALSE.has(t)) return false;
        return { __error: "not yes/no" };
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

/* An admin authors a field's "pattern"; it is not arbitrary input.
   But a malformed one must not throw on every write - a bad pattern
   means "cannot judge this", so it passes. */
function safeRegexTest(pattern, value) {
    try { return new RegExp(pattern).test(value); }
    catch { return true; }
}

/* Walk a whole record payload against its published form version and
   collect every value the schema cannot accept, as
   { field, row?, column?, value, error }.

   coerceCell already turns one value into what a field expects and
   returns { __error } when it cannot; this runs it over every flat
   field and every non-computed table cell, then applies the two
   constraints the client renderer enforces but nothing on the server
   did - field.pattern and field.min / field.max.

   Enforced on write (audit fix C1): a payload with any problem here
   is rejected 422. On PATCH the check is narrowed to values the
   write actually introduces (see introducedProblems) so a schema
   that changed under an existing record cannot lock its owner out of
   editing the parts they did not touch. Computed columns are skipped
   - they are server-derived by applyComputedColumns, not sent by the
   caller. */
function validateAgainstSchema(schema, data) {
    const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
    if (!data || typeof data !== "object" || fields.length === 0) return [];

    const problems = [];

    for (const field of fields) {
        if (field.type === "table") {
            if (!Array.isArray(field.columns)) continue;
            const rows = Array.isArray(data[field.key]) ? data[field.key] : null;
            if (!rows) continue;
            const cols = field.columns.filter((c) => c && c.type && c.type !== "computed");
            rows.forEach((row, index) => {
                if (!row || typeof row !== "object" || Array.isArray(row)) return;
                for (const col of cols) {
                    const result = coerceCell(col, row[col.key]);
                    if (result && typeof result === "object" && result.__error) {
                        problems.push({
                            field: field.key, row: index, column: col.key,
                            value: row[col.key], error: result.__error
                        });
                    }
                }
            });
            continue;
        }

        if (!FLAT_FIELD_TYPES.has(field.type)) continue;

        const raw = data[field.key];
        const result = coerceCell(field, raw);
        if (result && typeof result === "object" && result.__error) {
            problems.push({ field: field.key, value: raw, error: result.__error });
            continue;
        }
        if (result === undefined) continue;   // empty - the required-fields check owns this

        if (field.pattern && !safeRegexTest(field.pattern, String(result))) {
            problems.push({ field: field.key, value: raw, error: "does not match " + field.pattern });
        }
        if (field.min !== undefined && Number(result) < field.min) {
            problems.push({ field: field.key, value: raw, error: "below minimum " + field.min });
        }
        if (field.max !== undefined && Number(result) > field.max) {
            problems.push({ field: field.key, value: raw, error: "above maximum " + field.max });
        }
    }

    return problems;
}

/* Keep only the problems a PATCH actually introduces - where the
   incoming value for that field differs from what the record already
   holds. A bad value already living in the record (options changed,
   an old import) is left alone so its owner can still edit the rest.
   For a table, any change to the array re-validates the whole thing;
   an untouched table is skipped wholesale. */
function introducedProblems(problems, incoming, prior) {
    const changedTable = new Map();
    const isChangedTable = (key) => {
        if (!changedTable.has(key)) {
            changedTable.set(key,
                JSON.stringify(incoming?.[key]) !== JSON.stringify(prior?.[key]));
        }
        return changedTable.get(key);
    };
    return problems.filter((p) => {
        if (p.column !== undefined) return isChangedTable(p.field);
        return JSON.stringify(incoming?.[p.field]) !== JSON.stringify(prior?.[p.field]);
    });
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

/* ---------- one form, one Excel file, both ways ----------
   The workflow engineers actually want: download a form as a
   pre-shaped .xlsx, fill it offline, upload it back as ONE record
   with every header field and table row populated. And the reverse -
   export a filled record to the same shape.

   GET  /api/records/excel-template?type=pfmea       the blank form
   POST /api/records/excel?type=pfmea[&dry_run=true] filled -> a record
   GET  /api/records/NCR-2026-0142/excel             a record -> filled

   The Form sheet is Field | Value (its hidden first column carries
   the field key so a renamed label never breaks the mapping); each
   table field gets its own sheet, one column per table column. */

const FORM_SHEET = "Form";

function safeSheetName(label, taken) {
    let base = String(label || "Table").replace(/[[\]*?/\\:]/g, " ").trim().slice(0, 28) || "Table";
    let name = base;
    let n = 2;
    while (taken.has(name.toLowerCase())) name = base.slice(0, 25) + " " + n++;
    taken.add(name.toLowerCase());
    return name;
}

/* Build the workbook for a form. values === null gives a blank
   template; pass { title, data } to fill it in. Returns
   { workbook, tableSheets: Map<fieldKey, sheetName> }. */
function buildFormWorkbook(schema, values) {
    const fields = (schema && Array.isArray(schema.fields)) ? schema.fields : [];
    const data = values && values.data ? values.data : {};
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "QMS Guardian";

    /* A boolean writes as "Yes" / "No" (readFormWorkbook reads those
       back); an object dumps to JSON; numbers and dates stay native
       so the cell types right; everything else prints as-is. Same
       formatter the detail screen and the PDF use. */
    const cellOut = (field, v) => formatValue(field, v, { spreadsheet: true });

    const form = workbook.addWorksheet(FORM_SHEET, { views: [{ state: "frozen", ySplit: 2 }] });
    form.columns = [
        { key: "k", width: 2 },
        { key: "field", width: 34 },
        { key: "value", width: 48 }
    ];
    form.getColumn(1).hidden = true;
    form.addRow({ k: "__title__", field: "Record summary", value: values ? (values.title || "") : "" });
    form.getRow(1).font = { bold: true };
    form.addRow({ k: "", field: "(enter values in the Value column only)", value: "" });
    form.getRow(2).font = { italic: true, color: { argb: "FF888888" } };

    let lastSection;
    for (const f of fields) {
        if (f.type === "table") continue;
        if ((f.section || null) !== lastSection) {
            lastSection = f.section || null;
            if (lastSection) {
                const r = form.addRow({ k: "", field: "— " + lastSection + " —", value: "" });
                r.font = { bold: true };
            }
        }
        let cell = "";
        if (values) cell = cellOut(f, data[f.key]);
        form.addRow({ k: f.key, field: f.label || humanizeKey(f.key), value: cell });
    }

    const tableSheets = new Map();
    const taken = new Set([FORM_SHEET.toLowerCase()]);
    for (const f of fields) {
        if (f.type !== "table" || !Array.isArray(f.columns)) continue;
        const name = safeSheetName(f.label || humanizeKey(f.key), taken);
        tableSheets.set(f.key, name);
        const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
        sheet.columns = f.columns.map((c) => ({
            header: c.label || humanizeKey(c.key),
            key: c.key,
            width: Math.max(12, (c.label || c.key).length + 3)
        }));
        sheet.getRow(1).font = { bold: true };
        if (values && Array.isArray(data[f.key])) {
            for (const row of data[f.key]) {
                if (!row || typeof row !== "object") continue;
                const line = {};
                for (const c of f.columns) line[c.key] = cellOut(c, row[c.key]);
                sheet.addRow(line);
            }
        }
    }

    return { workbook, tableSheets };
}

/* Read a filled workbook back into { title, data, errors }. */
function readFormWorkbook(workbook, schema) {
    const fields = (schema.fields || []);
    const byKey = new Map(fields.map((f) => [f.key, f]));
    const byLabel = new Map(fields.map((f) => [normalizeHeader(f.label || f.key), f]));
    const errors = [];

    const form = workbook.getWorksheet(FORM_SHEET) || workbook.worksheets[0];
    let title = "";
    const data = {};

    if (form) {
        form.eachRow((row, rowNumber) => {
            if (rowNumber === 1 && String(row.getCell(1).value || "") !== "__title__") { /* fall through */ }
            const keyCell = String(row.getCell(1).value || "").trim();
            const labelCell = normalizeHeader(row.getCell(2).value);
            const rawValue = row.getCell(3).value;

            if (keyCell === "__title__") {
                title = rawValue == null ? "" : String(typeof rawValue === "object" && rawValue.text ? rawValue.text : rawValue).trim();
                return;
            }
            const field = keyCell ? byKey.get(keyCell) : byLabel.get(labelCell);
            if (!field || field.type === "table") return;

            const coerced = coerceCell(field, rawValue);
            if (coerced && typeof coerced === "object" && coerced.__error) {
                errors.push((field.label || field.key) + ": " + coerced.__error);
            } else if (coerced !== undefined) {
                data[field.key] = coerced;
            }
        });
    }

    for (const f of fields) {
        if (f.type !== "table" || !Array.isArray(f.columns)) continue;
        /* the sheet may have been renamed; match on the safe name we'd
           have produced, else any sheet whose header row looks right */
        const wantName = safeSheetName(f.label || humanizeKey(f.key), new Set([FORM_SHEET.toLowerCase()]));
        let sheet = workbook.getWorksheet(wantName)
            || workbook.worksheets.find((s) => normalizeHeader(s.name) === normalizeHeader(f.label || f.key));
        if (!sheet) continue;

        const headerRow = sheet.getRow(1).values;   // 1-indexed
        const colAt = [];                            // sheet column index -> table column key
        headerRow.forEach((h, i) => {
            if (i === 0) return;
            const norm = normalizeHeader(h);
            const col = f.columns.find((c) => normalizeHeader(c.label || c.key) === norm)
                || f.columns[i - 1];
            if (col) colAt[i] = col;
        });

        const rows = [];
        for (let r = 2; r <= sheet.rowCount; r++) {
            const excelRow = sheet.getRow(r);
            const obj = {};
            let any = false;
            colAt.forEach((col, i) => {
                if (!col) return;
                const coerced = coerceCell(col, excelRow.getCell(i).value);
                if (coerced && typeof coerced === "object" && coerced.__error) {
                    errors.push("\"" + (f.label || f.key) + "\" row " + r + ", " + (col.label || col.key) + ": " + coerced.__error);
                } else if (coerced !== undefined) {
                    obj[col.key] = coerced;
                    any = true;
                }
            });
            if (any) rows.push(obj);
        }
        if (rows.length) data[f.key] = rows;
    }

    return { title, data, errors };
}

records.get("/excel-template", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const type = String(request.query.type || "");
        const typeRow = await query(
            "select id, name from record_types where org_id = $1 and key = $2",
            [request.user.org_id, type]);
        if (typeRow.rowCount === 0) return response.status(400).json({ error: "Unknown record type: " + type });

        response.setHeader("Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition",
            'attachment; filename="' + type.replace(/[^a-z0-9_-]/gi, "") + '-template.xlsx"');

        /* When the form has the customer's own layout mapped, the blank
           template is that file untouched. */
        const fill = await loadTemplateFill(typeRow.rows[0].id, undefined);
        if (fill) {
            response.send(Buffer.from(fill.templateBuffer));
            return;
        }

        const form = await loadPublishedForm(typeRow.rows[0].id);
        const schema = form ? form.schema : { fields: [] };
        const { workbook } = buildFormWorkbook(schema, null);
        await workbook.xlsx.write(response);
        response.end();
    } catch (error) {
        next(error);
    }
});

records.post("/excel", requirePermission(createPermissionFor), upload.single("file"),
    async (request, response, next) => {
        try {
            const type = String(request.query.type || request.body?.type || "");
            const dryRun = request.query.dry_run === "true" || request.body?.dry_run === "true";
            if (!request.file) return response.status(400).json({ error: "An .xlsx file is required" });

            const typeRow = await query(
                "select id, prefix, name from record_types where org_id = $1 and key = $2",
                [request.user.org_id, type]);
            if (typeRow.rowCount === 0) return response.status(400).json({ error: "Unknown record type: " + type });
            const recordType = typeRow.rows[0];

            const form = await loadPublishedForm(recordType.id);
            const schema = form ? form.schema : { fields: [] };
            const formVersion = form ? form.version : 1;

            let parsed;
            /* A form with the customer's own layout mapped is read back
               from that layout's cells; otherwise from the generated
               Form / table sheets. */
            const fill = await loadTemplateFill(recordType.id, undefined);
            if (fill) {
                try {
                    parsed = await readTemplate(request.file.buffer, fill.map, fill.schema);
                } catch {
                    return response.status(422).json({ error: "That file could not be read as an .xlsx workbook" });
                }
            } else {
                const workbook = new ExcelJS.Workbook();
                try {
                    await workbook.xlsx.load(request.file.buffer);
                } catch {
                    return response.status(422).json({ error: "That file could not be read as an .xlsx workbook" });
                }
                parsed = readFormWorkbook(workbook, schema);
            }

            let data = applyComputedColumns(schema, withComputedRpn(type, parsed.data));
            data = applyFairResults(type, data);

            /* A required field the sheet did not fill is a warning, not a
               block: "Fill from Excel" is for getting a partly-done form
               into the app, then finishing it here. The in-app editor
               and the workflow still enforce completeness before the
               record can move on. Errors (a cell that could not be
               read, a bad number) still stop the import. */
            const warnings = (schema.fields || [])
                .filter((f) => f.required && FLAT_FIELD_TYPES.has(f.type) && data[f.key] === undefined)
                .map((f) => (f.label || f.key) + " still to fill");
            const errors = [...parsed.errors];

            const title = parsed.title
                || (recordType.name + " - " + new Date().toISOString().slice(0, 10));

            if (dryRun) {
                const tables = {};
                for (const f of (schema.fields || [])) {
                    if (f.type === "table") tables[f.label || f.key] = Array.isArray(data[f.key]) ? data[f.key].length : 0;
                }
                return response.json({ type, dry_run: true, title, header: data, tables, errors, warnings });
            }

            if (errors.length) {
                return response.status(422).json({ error: "The sheet has problems", errors });
            }

            const created = await withTransaction((client) => insertRecordRow(client, {
                orgId: request.user.org_id, userId: request.user.id,
                recordType, type, title, severity: "ok", data, formVersion, dueAt: null
            }));

            publish(request.user.org_id, { entity: "records", id: created.number, action: "created" });
            response.status(201).json({ number: created.number, created_count: 1, warnings });
        } catch (error) {
            next(error);
        }
    });

records.get("/:number/excel", async (request, response, next) => {
    try {
        const found = await query(SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]);
        if (found.rowCount === 0) return response.status(404).json({ error: "Record not found" });
        const record = found.rows[0];

        response.setHeader("Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        response.setHeader("Content-Disposition",
            'attachment; filename="' + record.number + '.xlsx"');

        /* If this form version has the customer's own layout mapped,
           the export is that spreadsheet with the values dropped in. */
        const fill = await loadTemplateFill(record.record_type_id, record.form_version);
        if (fill) {
            const { buffer } = await fillTemplate(
                fill.templateBuffer, fill.map, fill.schema,
                { title: record.title, data: record.data });
            response.send(Buffer.from(buffer));
            return;
        }

        const form = await query(
            "select schema from form_versions where record_type_id = $1 and version = $2",
            [record.record_type_id, record.form_version]);
        const schema = form.rows[0]?.schema || { fields: [] };

        const { workbook } = buildFormWorkbook(schema, { title: record.title, data: record.data });
        await workbook.xlsx.write(response);
        response.end();
    } catch (error) {
        next(error);
    }
});

/* ---------- database-level audit trail ----------
   GET /api/records/NCR-2026-0142/audit

   Every INSERT / UPDATE / DELETE the records table saw for this
   record, newest first, each with a full before/after row snapshot.
   Written by the record_audit trigger (migration 044), so it also
   captures a change made outside the app.

   Gated on roles.manage: it returns whole-row payloads and is a
   compliance / tamper-evidence view, the same audience as
   GET /api/roles/history. Loosen to a record-read permission if it
   should be broader. */
records.get("/:number/audit", requirePermission("roles.manage"),
    async (request, response, next) => {
        try {
            const rec = await query(
                "select id from records where org_id = $1 and number = $2",
                [request.user.org_id, request.params.number]
            );
            if (rec.rowCount === 0) {
                return response.status(404).json({ error: "Record not found" });
            }

            const log = await query(`
                select ra.id,
                       ra.record_id  as nc_id,
                       ra.action_type,
                       ra.changed_at,
                       ra.changed_by,
                       u.full_name   as changed_by_name,
                       ra.old_values,
                       ra.new_values
                  from record_audit ra
             left join users u on u.id = ra.changed_by
                 where ra.record_id = $1 and ra.org_id = $2
                 order by ra.changed_at desc, ra.id desc
            `, [rec.rows[0].id, request.user.org_id]);

            response.json({
                number: request.params.number,
                count: log.rowCount,
                entries: log.rows
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

        /* Don't surface records the caller could not open. */
        const hidden = unreadableTypes(request);
        const params = [request.user.org_id, "%" + q + "%"];
        let scope = "";
        if (hidden.length) {
            params.push(hidden);
            scope = " and rt.key <> all($" + params.length + ")";
        }

        const result = await query(
            SELECT_RECORD + `
               and (r.number ilike $2 or r.title ilike $2)` + scope + `
             order by r.opened_at desc
             limit 8
            `,
            params
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

        const needed = readPermissionFor(record.type);
        if (needed && !request.can(needed)) {
            return response.status(403).json({
                error: "Your role does not permit this",
                required: needed,
                your_role: request.user.role_name
            });
        }

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

        const version = recordVersion(record.updated_at);
        if (version) response.setHeader("ETag", '"' + version + '"');

        /* content-bound signatures + any conditional-rule approval this
           record now needs (audit P2 / M6, P3 / L4) */
        let signatures;
        let approvalsNeeded = [];
        {
            const vSchema = await query(
                "select schema from form_versions where record_type_id = $1 and version = $2",
                [record.record_type_id, record.form_version]
            );
            const schema = vSchema.rows[0]?.schema || null;
            signatures = checkSignatures(schema, record.data);
            approvalsNeeded = checkRules(schema, record.data).approvals;
        }

        response.json({
            record,
            version,
            ...(signatures ? { signatures } : {}),
            ...(approvalsNeeded.length ? { approvals_needed: approvalsNeeded } : {}),
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
            .text(formatValue(null, value));
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

/* A blank fill line for a field with no value, so a printed form is a
   form you can complete on paper, not a list of the two things that
   happened to be filled in. */
const BLANK_LINE = " " + ".".repeat(52);   // a dot leader - a line to write on

/* A table field is an array of row objects keyed by the schema's
   column keys. Column counts vary wildly across QMS forms (a 5-Why
   is 3 columns, a PFMEA is 20+), so rather than squash a grid into
   portrait width, each row prints as a small labelled block. Every
   column is shown - a blank cell gets a fill line - and an empty
   table still prints one blank row so the structure is on the page. */
function drawTableField(doc, field, rows, userNames) {
    const columns = Array.isArray(field.columns) ? field.columns : [];
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
        .text((field.label || humanizeKey(field.key)) + ":");
    doc.moveDown(0.15);

    const dataRows = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object");
    const toDraw = dataRows.length ? dataRows : [{}];   // one blank template row

    toDraw.forEach((row, index) => {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 40) doc.addPage();
        doc.fontSize(8.5).font("Helvetica-Bold").fillColor(INK)
            .text("  " + (dataRows.length ? (index + 1) + "." : "–"));

        const cells = columns.length > 0
            ? columns.map((col) => [col.label || humanizeKey(col.key), row[col.key], col])
            : Object.entries(row)
                .filter(([key]) => !key.startsWith("_"))   // _id and friends are plumbing, not data
                .map(([key, value]) => [humanizeKey(key), value, { type: "text" }]);

        for (const [label, value, col] of cells) {
            if (col && col.type === "computed" && isEmpty(value)) continue;   // derived, no line to fill
            const text = isEmpty(value) ? BLANK_LINE : formatValue(col, value, { users: userNames });
            doc.fontSize(8.5).font("Helvetica-Bold").fillColor(INK_2)
                .text("     " + label + ":  ", { continued: true, width })
                .font("Helvetica").fillColor(isEmpty(value) ? INK_2 : INK).text(text, { width });
        }
        doc.moveDown(0.25);
    });
    doc.moveDown(0.4);
}

/* The printed form IS the form: every section and every field of the
   version the record was raised under, in declared order, with the
   filled-in values where they exist and a blank fill line where they
   do not - so a quality engineer can print a partly-done record and
   finish it on paper, or print an empty one as a blank template.

   A key present in data but no longer named by that version's schema
   (an older field renamed or removed in a later form version) still
   prints, last, under "Additional details" - this export carries ALL
   of a record's information, not just what the current form asks. */
function drawFormFields(doc, data, schema, userNames, signatures) {
    const values = data || {};
    const fields = (schema && Array.isArray(schema.fields)) ? schema.fields : [];
    const sigs = signatures || {};

    if (fields.length === 0) {
        drawGenericFields(doc, values);
        return;
    }

    doc.fontSize(11).fillColor(INK).font("Helvetica-Bold").text("Form detail");
    doc.moveDown(0.2);

    const shown = new Set();
    let lastSection;
    let first = true;

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    for (const field of fields) {
        shown.add(field.key);
        const value = values[field.key];
        const empty = field.type === "table"
            ? !Array.isArray(value) || value.length === 0
            : isEmpty(value);

        const section = field.section || null;
        if (first || section !== lastSection) {
            if (section) drawSectionHeading(doc, section);
            lastSection = section;
            first = false;
        }

        const label = field.label || humanizeKey(field.key);

        if (field.type === "table") {
            drawTableField(doc, field, Array.isArray(value) ? value : [], userNames);
            continue;
        }

        let text;
        if (field.type === "signature") {
            const s = sigs[field.key];
            text = empty ? BLANK_LINE + "   (sign / date)"
                : formatValue(field, value, { users: userNames })
                  + (s && !s.legacy ? (s.intact ? "   [unchanged since signing]" : "   [RECORD EDITED AFTER SIGNING]") : "");
        } else if (empty && field.type === "boolean") {
            text = "[  ] Yes      [  ] No";
        } else if (empty && field.type === "select" && Array.isArray(field.options) && field.options.length) {
            text = BLANK_LINE.slice(0, 24) + "  (" + field.options.join("  /  ") + ")";
        } else if (empty) {
            text = BLANK_LINE;
        } else {
            text = formatValue(field, value, { users: userNames });
        }

        if (field.type === "memo") {
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2).text(label + ":");
            doc.fontSize(9).font("Helvetica").fillColor(empty ? INK_2 : INK)
                .text(empty ? BLANK_LINE + "\n" + BLANK_LINE : text, { width: pageWidth });
            doc.moveDown(0.4);
        } else {
            doc.fontSize(9).font("Helvetica-Bold").fillColor(INK_2)
                .text(label + ":  ", { continued: true })
                .font("Helvetica").fillColor(empty ? INK_2 : INK).text(text);
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
            const text = formatValue(null, value);
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

        /* ?inline=1 previews the PDF in a browser tab (what the Print
           button uses); the default downloads it as a file. */
        const inline = request.query.inline === "1" || request.query.inline === "true";
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition",
            (inline ? "inline" : "attachment") + "; filename=\"" + record.number + ".pdf\"");

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
        drawFormFields(doc, record.data, schema, userNames, checkSignatures(schema, record.data));
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
        let ruleResult = { blocked: [], warnings: [], notify: [], approvals: [] };

        if (formRow.rowCount > 0) {
            formVersion = formRow.rows[0].version;
            data = applyComputedColumns(formRow.rows[0].schema, data);
            data = applyFairResults(type, data);
            data = ensureRowIds(formRow.rows[0].schema, data);
            data = stampSignatures(formRow.rows[0].schema, data, {}, request.user, formVersion);

            /* Schema check (audit fix C1). A create must be clean:
               every value is new, so every problem counts. Logged as
               well as rejected so the violation rate stays visible. */
            const schemaProblems = validateAgainstSchema(formRow.rows[0].schema, data);
            if (schemaProblems.length > 0) {
                log.warn("record_write_schema_mismatch", {
                    phase: "create", type, form_version: formVersion,
                    problems: schemaProblems
                });
                return response.status(422).json({
                    error: "Some values do not fit the form",
                    schema_violations: schemaProblems
                });
            }

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

            /* Conditional form rules (audit P3 / L4). A matched
               block_submit / require_field rule stops the save. */
            ruleResult = checkRules(formRow.rows[0].schema, data);
            if (ruleResult.blocked.length > 0) {
                return response.status(422).json({
                    error: "This record breaks a form rule",
                    rule_violations: ruleResult.blocked,
                    warnings: ruleResult.warnings
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

        await fireRuleNotifications(request.user.org_id, type, created.number, ruleResult.notify);

        publish(request.user.org_id, { entity: "records", id: created.number, action: "created" });
        response.status(201).json({
            ...created,
            ...(ruleResult.warnings.length ? { warnings: ruleResult.warnings } : {}),
            ...(ruleResult.approvals.length ? { approvals_needed: ruleResult.approvals } : {})
        });
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
                       r.form_version, r.updated_at, rt.key as type
                  from records r join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return null;

            const record = current.rows[0];

            const want = requestedVersion(request);
            if (want && recordVersion(record.updated_at) !== want) {
                return { stale: true, currentVersion: recordVersion(record.updated_at) };
            }

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
            /* server-owned row ids: prior = what the record already
               holds, so a real existing id is kept and anything else
               is re-minted (audit M5) */
            merged = ensureRowIds(schemaRow.rows[0]?.schema || null, merged, record.data);
            merged = stampSignatures(schemaRow.rows[0]?.schema || null, merged,
                record.data, request.user, record.form_version);

            /* Schema check (audit fix C1). Narrowed to the values this
               write introduces vs. what the record already holds, so
               legacy data the caller never touched cannot block the
               save. Logged and rejected. */
            const schemaProblems = introducedProblems(
                validateAgainstSchema(schemaRow.rows[0]?.schema || null, data),
                data, record.data
            );
            if (schemaProblems.length > 0) {
                log.warn("record_write_schema_mismatch", {
                    phase: "update", number: request.params.number,
                    type: record.type, form_version: record.form_version,
                    problems: schemaProblems
                });
                return { schemaBlocked: true, schema_violations: schemaProblems };
            }

            /* Conditional form rules (audit P3 / L4). */
            const ruleResult = checkRules(schemaRow.rows[0]?.schema || null, merged);
            if (ruleResult.blocked.length > 0) {
                return {
                    ruleBlocked: true,
                    rule_violations: ruleResult.blocked,
                    warnings: ruleResult.warnings
                };
            }

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

                /* A table field: audit it row by row against the stored
                   (post-compute) rows, not as one stringified blob. */
                if (Array.isArray(value) || Array.isArray(before)) {
                    for (const line of tableRowAudits(key, before, merged[key])) {
                        await client.query(`
                            insert into audit_log
                                (org_id, record_id, entity, entity_id, field,
                                 old_value, new_value, reason, changed_by)
                            values ($1, $2, 'records', $2, $3, $4, $5, $6, $7)
                        `, [request.user.org_id, record.id, line.field,
                            line.old_value, line.new_value, reason || null, actorId]);
                    }
                    continue;
                }

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
                returning id, number, title, status, severity, data, due_at, updated_at
            `, [record.id, merged, severity || null, nextDueAt, nextTitle]);

            return { ...result.rows[0], type: record.type, ruleResult };
        });

        if (!updated) {
            return response.status(404).json({ error: "Record not found" });
        }

        if (updated.ruleBlocked) {
            return response.status(422).json({
                error: "This record breaks a form rule",
                rule_violations: updated.rule_violations,
                warnings: updated.warnings
            });
        }

        if (updated.schemaBlocked) {
            return response.status(422).json({
                error: "Some values do not fit the form",
                schema_violations: updated.schema_violations
            });
        }

        if (updated.stale) {
            return response.status(409).json({
                error: "This record changed since you opened it. Reload before saving so you do not overwrite the other change.",
                code: "stale",
                version: updated.currentVersion
            });
        }

        if (updated.conflict) {
            return response.status(409).json({
                error: updated.conflict,
                detail: "Clause 9.2 requires an auditor be independent of the area they audit."
            });
        }

        const rr = updated.ruleResult || { notify: [], warnings: [], approvals: [] };
        await fireRuleNotifications(request.user.org_id, updated.type, updated.number, rr.notify);

        publish(request.user.org_id, {
            entity: "records", id: request.params.number, action: "updated"
        });
        const version = recordVersion(updated.updated_at);
        if (version) response.setHeader("ETag", '"' + version + '"');

        const { ruleResult, type, ...body } = updated;
        response.json({
            ...body, version,
            ...(rr.warnings.length ? { warnings: rr.warnings } : {}),
            ...(rr.approvals.length ? { approvals_needed: rr.approvals } : {})
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- fast table edits ----------
   PATCH /api/records/NCR-2026-0142/table/characteristics
   { "upsert": [ { "_id": "…", "actual": 12.71 }, { "feature": "New" } ],
     "remove": [ "…rowId…" ],
     "reason": "re-measured after rework" }

   Editing three cells of a 400-row FAIR grid should not mean sending -
   and auditing, and re-storing - the whole array. This touches only
   the named rows: an upsert with a known _id merges into that row, one
   without _id (or with an unknown _id) is appended with a fresh id, a
   remove drops the row. Computed columns are recomputed for the whole
   field (cheap CPU, and it keeps every derived cell correct), the
   write is a jsonb_set of just this one key, and each touched row
   leaves its own audit_log line.

   Same authority as PATCH /:number. The whole-record PATCH still works
   and is what the in-app editor uses today; this is the endpoint a
   big-grid editor calls per change. The record_audit trigger still
   snapshots the full row - shrinking that is a separate change. */
records.patch("/:number/table/:field", requirePermission(editPermissionFor),
    async (request, response, next) => {
    try {
        const body = request.body || {};
        const upsert = Array.isArray(body.upsert) ? body.upsert : [];
        const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
        const reason = body.reason || null;

        if (upsert.length === 0 && remove.length === 0) {
            return response.status(400).json({ error: "Send at least one row in upsert or remove" });
        }

        const outcome = await withTransaction(async (client) => {
            const current = await client.query(`
                select r.id, r.data, r.record_type_id, r.form_version, r.updated_at, rt.key as type
                  from records r join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);
            if (current.rowCount === 0) return null;
            const record = current.rows[0];

            const want = requestedVersion(request);
            if (want && recordVersion(record.updated_at) !== want) {
                return { stale: true, currentVersion: recordVersion(record.updated_at) };
            }

            const schemaRow = await client.query(
                "select schema from form_versions where record_type_id = $1 and version = $2",
                [record.record_type_id, record.form_version]
            );
            const schema = schemaRow.rows[0]?.schema || { fields: [] };
            const field = (schema.fields || [])
                .find((f) => f.key === request.params.field && f.type === "table");
            if (!field) return { badField: true };

            const beforeRows = Array.isArray(record.data[field.key]) ? record.data[field.key] : [];
            const byId = new Map(beforeRows.filter((r) => r && r._id).map((r) => [r._id, r]));

            for (const id of remove) byId.delete(id);

            /* surviving rows keep their original order */
            let rows = beforeRows.filter((r) => r && r._id && byId.has(r._id));

            for (const patch of upsert) {
                if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
                const id = typeof patch._id === "string" ? patch._id : null;
                const idx = id ? rows.findIndex((r) => r._id === id) : -1;
                if (idx >= 0) rows[idx] = { ...rows[idx], ...patch, _id: id };
                else rows = [...rows, { ...patch, _id: randomUUID() }];
            }

            /* recompute this field's derived cells, then write only it */
            const recomputed = applyComputedColumns(schema, { ...record.data, [field.key]: rows });
            const finalRows = recomputed[field.key];

            const upd = await client.query(`
                update records
                   set data = jsonb_set(data, $2::text[], $3::jsonb, true)
                 where id = $1
                returning number, updated_at
            `, [record.id, [field.key], JSON.stringify(finalRows)]);

            for (const line of tableRowAudits(field.key, beforeRows, finalRows)) {
                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, $3, $4, $5, $6, $7)
                `, [request.user.org_id, record.id, line.field,
                    line.old_value, line.new_value, reason, request.user.id]);
            }

            return { number: upd.rows[0].number, updated_at: upd.rows[0].updated_at, field: field.key, rows: finalRows };
        });

        if (outcome === null) return response.status(404).json({ error: "Record not found" });
        if (outcome.stale) {
            return response.status(409).json({
                error: "This record changed since you opened it. Reload before saving so you do not overwrite the other change.",
                code: "stale",
                version: outcome.currentVersion
            });
        }
        if (outcome.badField) {
            return response.status(400).json({ error: "No table field \"" + request.params.field + "\" on this record's form" });
        }

        publish(request.user.org_id, {
            entity: "records", id: request.params.number, action: "updated"
        });
        const version = recordVersion(outcome.updated_at);
        if (version) response.setHeader("ETag", '"' + version + '"');
        response.json({
            number: outcome.number, field: outcome.field, version,
            row_count: outcome.rows.length, rows: outcome.rows
        });
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

        const dirty = request.body?.dirty === true;
        const editors = heartbeat(request.user.org_id, record.number, request.user, dirty)
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

/* ---------- server-side drafts (P3 / M15) ----------
   PUT/GET/DELETE /api/records/drafts/<record-type>:<number|new>

   One draft per (user, key). The snapshot is opaque here - the editor
   owns its shape. Kept so an unsaved entry survives a device change,
   and deleted on a real save or an explicit discard. */
const DRAFT_KEY_RX = /^[a-z0-9_]+:[A-Za-z0-9_-]+$/;

records.get("/drafts/:key", async (request, response, next) => {
    try {
        if (!DRAFT_KEY_RX.test(request.params.key)) {
            return response.status(400).json({ error: "Bad draft key" });
        }
        const row = await query(
            "select snapshot, updated_at from record_drafts where user_id = $1 and draft_key = $2",
            [request.user.id, request.params.key]);
        if (row.rowCount === 0) return response.status(404).json({ error: "No draft" });
        response.json(row.rows[0]);
    } catch (error) {
        next(error);
    }
});

records.put("/drafts/:key", async (request, response, next) => {
    try {
        if (!DRAFT_KEY_RX.test(request.params.key)) {
            return response.status(400).json({ error: "Bad draft key" });
        }
        const snapshot = request.body?.snapshot;
        if (!snapshot || typeof snapshot !== "object") {
            return response.status(400).json({ error: "snapshot object required" });
        }
        const saved = await query(`
            insert into record_drafts (org_id, user_id, draft_key, snapshot)
            values ($1, $2, $3, $4)
            on conflict (user_id, draft_key)
            do update set snapshot = excluded.snapshot
            returning updated_at
        `, [request.user.org_id, request.user.id, request.params.key, JSON.stringify(snapshot)]);
        response.json({ ok: true, updated_at: saved.rows[0].updated_at });
    } catch (error) {
        next(error);
    }
});

records.delete("/drafts/:key", async (request, response, next) => {
    try {
        await query("delete from record_drafts where user_id = $1 and draft_key = $2",
            [request.user.id, request.params.key]);
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
                   (a.storage_path is not null) as has_file, a.row_ref,
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
            "select id, data, record_type_id, form_version from records where org_id = $1 and number = $2",
            [request.user.org_id, request.params.number]
        );
        if (record.rowCount === 0) {
            return response.status(404).json({ error: "Record not found" });
        }

        /* An optional row_ref pins this file to a place in the form:
             "<tableFieldKey>:<rowId>"  - one row of a table field
             "<fileFieldKey>:_"         - a field-scoped file slot
           Both are validated against the record's own schema / data so
           a stale or forged ref cannot leave an orphan attachment. */
        const rowRef = String((request.body && request.body.row_ref) || "").trim() || null;
        if (rowRef) {
            const m = /^([A-Za-z0-9_]+):(.+)$/.exec(rowRef);
            let ok = false;
            if (m && m[2] === "_") {
                const s = await query(
                    "select schema from form_versions where record_type_id = $1 and version = $2",
                    [record.rows[0].record_type_id, record.rows[0].form_version]);
                ok = ((s.rows[0]?.schema?.fields) || [])
                    .some((f) => f.key === m[1] && f.type === "file");
            } else {
                const rows = m && Array.isArray(record.rows[0].data?.[m[1]])
                    ? record.rows[0].data[m[1]] : null;
                ok = !!(rows && rows.some((r) => r && typeof r === "object" && r._id === m[2]));
            }
            if (!ok) {
                return response.status(400).json({ error: "row_ref does not match a row or file field on this record" });
            }
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
                (record_id, filename, mime_type, size_bytes, storage_key, storage_path, uploaded_by, row_ref)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            returning id, filename, mime_type, size_bytes, storage_key,
                      (storage_path is not null) as has_file, row_ref, uploaded_at
        `, [record.rows[0].id, filename, mimeType, sizeBytes,
            storageKey, storagePath, request.user.id, rowRef]);

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

/* ---------- clone ----------
   POST /api/records/PFMEA-2026-0003/clone   { title? }

   A new record of the same type, seeded with this one's data - the
   part-family workflow: most of a PFMEA / Control Plan / 8D carries
   over, you edit the deltas. Computed columns recompute; a SCAR's
   triggered_by link is dropped so the copy does not re-wire itself
   to the original's trigger. */
records.post("/:number/clone", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const src = await query(SELECT_RECORD + " and r.number = $2",
            [request.user.org_id, request.params.number]);
        if (src.rowCount === 0) return response.status(404).json({ error: "Record not found" });
        const source = src.rows[0];

        const typeRow = await query(
            "select id, prefix from record_types where org_id = $1 and key = $2",
            [request.user.org_id, source.type]);
        if (typeRow.rowCount === 0) return response.status(400).json({ error: "Unknown record type" });
        const recordType = typeRow.rows[0];

        const form = await loadPublishedForm(recordType.id);
        const schema = form ? form.schema : { fields: [] };
        const formVersion = form ? form.version : source.form_version || 1;

        const seed = { ...(source.data || {}) };
        delete seed.triggered_by;
        /* Fresh row ids below - a clone must never share a row_ref (and
           so an attachment) with the record it was copied from. */
        stripRowIds(schema, seed);
        let data = applyComputedColumns(schema, withComputedRpn(source.type, seed));
        data = applyFairResults(source.type, data);
        data = ensureRowIds(schema, data);

        const title = String(request.body?.title || "").trim()
            || ("Copy of " + (source.title || source.number));

        const me = await query("select initials from users where id = $1", [request.user.id]);

        const created = await withTransaction((client) => insertRecordRow(client, {
            orgId: request.user.org_id, userId: request.user.id,
            recordType, type: source.type, title, severity: "ok",
            ownerInitials: me.rows[0]?.initials, data, formVersion, dueAt: null
        }));

        publish(request.user.org_id, { entity: "records", id: created.number, action: "created" });
        response.status(201).json({ number: created.number, cloned_from: source.number });
    } catch (error) {
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
                select r.id, r.status, r.record_type_id, r.data, r.updated_at, rt.key as type
                  from records r
                  join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1 and r.number = $2
                   for update of r
            `, [request.user.org_id, request.params.number]);

            if (current.rowCount === 0) return { code: 404 };

            const record = current.rows[0];

            const want = requestedVersion(request);
            if (want && recordVersion(record.updated_at) !== want) {
                return { code: 409, body: { error: "This record changed since you opened it. Reload before acting.", code: "stale", version: recordVersion(record.updated_at) } };
            }

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

            /* Clause 10.2: closing a CAPA effective without evidence the
               corrective action was actually validated is exactly the
               gap between "we planned a fix" and "we proved the fix
               worked" that this clause exists to close. Applies to a
               real closure only: an "escalated" terminal is by
               definition not validated, and an early close straight
               from initiation is the necessity determination "no CAPA
               needed" - neither has a corrective action to evidence. */
            if (isTerminal && record.type === "capa" && to === "closed"
                && record.status !== "initiation"
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
