/* ============================================================
   Quality events.

   NCR, CAPA, 8D, complaint, SCAR, audit and risk all route through
   this one file, because they are all rows in the records table.
   The record type is a query parameter, not a separate endpoint.
   ============================================================ */

import { Router } from "express";
import PDFDocument from "pdfkit";
import { query, withTransaction } from "../db.js";
import { requirePermission, createPermissionFor, closePermissionFor } from "../auth.js";

export const records = Router();

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
   GET /api/records?type=ncr&status=containment&open=true&limit=50 */
records.get("/", async (request, response, next) => {
    try {
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

        const limit = Math.min(Number(request.query.limit) || 100, 500);
        params.push(limit);

        const sql = SELECT_RECORD
            + (conditions.length ? " and " + conditions.join(" and ") : "")
            + " order by r.opened_at desc limit $" + params.length;

        const result = await query(sql, params);
        response.json({ count: result.rowCount, records: result.rows });
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

        const transitions = moves.rows.map((move) => {
            const stepOk = !move.required_permission || request.can(move.required_permission);
            const closeOk = !move.is_terminal || !closeKey || request.can(closeKey);

            return {
                to: move.to_state,
                label: move.to_name || move.to_state,
                is_terminal: move.is_terminal,
                allowed: stepOk && closeOk,
                blocked_because: stepOk
                    ? (closeOk ? null : "Closing this needs " + closeKey)
                    : "Needs permission to " + (move.permission_description || move.required_permission).toLowerCase()
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

const BRAND = "#0D4F49";
const BRASS = "#A8703A";
const INK = "#12201E";
const INK_2 = "#4C5C59";
const HAIRLINE = "#D8E1DF";

function humanizeKey(key) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* The same mountain-and-baseline mark used in the app's own header,
   redrawn in pdfkit's vector primitives rather than embedded as an
   image - the whole mark is four strokes and a dot. */
function drawLetterhead(doc, orgName) {
    const x = doc.page.margins.left;
    const y = doc.y;
    const size = 26;

    doc.roundedRect(x, y, size, size, 5).lineWidth(1.3).stroke(BRAND);
    doc.moveTo(x + 6, y + 19).lineTo(x + 13, y + 6).lineTo(x + 20, y + 19)
        .lineWidth(1.6).stroke(INK);
    doc.moveTo(x + 5, y + 19).lineTo(x + 21, y + 19).lineWidth(1.6).stroke(BRASS);
    doc.circle(x + 13, y + 19, 1.8).fill(BRASS);

    doc.fontSize(14).fillColor(INK).font("Helvetica-Bold")
        .text("QualityGuard", x + size + 10, y + 1);
    doc.fontSize(8.5).fillColor(INK_2).font("Helvetica")
        .text(orgName, x + size + 10, y + 17);

    doc.y = y + size + 12;
    doc.moveTo(x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(0.75).stroke(HAIRLINE);
    doc.moveDown(1.2);
}

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

function drawFields(doc, data) {
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

function drawFooter(doc, orgName) {
    doc.fontSize(7.5).fillColor(INK_2).text(
        "Generated by QualityGuard for " + orgName + " on " + new Date().toLocaleString(),
        doc.page.margins.left,
        doc.page.height - doc.page.margins.bottom + 12,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "center" }
    );
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

        const [org, history] = await Promise.all([
            query("select name from organizations where id = $1", [request.user.org_id]),
            query(`
                select a.field, a.new_value, a.changed_at, u.full_name as changed_by
                  from audit_log a
             left join users u on u.id = a.changed_by
                 where a.record_id = $1
                 order by a.changed_at desc
                 limit 15
            `, [record.id])
        ]);

        const orgName = org.rows[0]?.name || "";

        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + record.number + ".pdf\"");

        const doc = new PDFDocument({ size: "letter", margin: 54 });
        doc.pipe(response);

        drawLetterhead(doc, orgName);
        drawRecordHeader(doc, record);
        drawFields(doc, record.data);
        drawHistory(doc, history.rows);
        drawFooter(doc, orgName);

        doc.end();
    } catch (error) {
        next(error);
    }
});

/* ---------- create ----------
   POST /api/records
   { "type": "ncr", "title": "...", "owner": "MO", "data": { ... } }

   The payload is validated against the published form schema, so
   changing the form in the Form Builder changes what the API
   accepts without touching this file. */
records.post("/", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const { type, title, owner, data = {}, severity = "ok", due_at } = request.body || {};

        if (!type || !title) {
            return response.status(400).json({
                error: "type and title are required"
            });
        }

        const dueAt = parseDueAt(due_at);
        if (!dueAt.ok) {
            return response.status(400).json({ error: "due_at is not a valid date" });
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
            const missing = (formRow.rows[0].schema.fields || [])
                .filter((field) => field.required && data[field.key] === undefined)
                .map((field) => field.key);

            if (missing.length > 0) {
                return response.status(422).json({
                    error: "Required fields missing",
                    fields: missing
                });
            }
        }

        const created = await withTransaction(async (client) => {
            /* Next number for this type and year. A single writer is
               fine at this scale; a busy plant would use a sequence
               per type instead. */
            const year = new Date().getFullYear();
            const pattern = recordType.prefix + "-" + year + "-%";

            const last = await client.query(`
                select number from records
                 where org_id = $1 and record_type_id = $2 and number like $3
                 order by number desc limit 1
            `, [request.user.org_id, recordType.id, pattern]);

            const nextSeq = last.rowCount === 0
                ? 1
                : Number(last.rows[0].number.split("-").pop()) + 1;

            const number = recordType.prefix + "-" + year + "-"
                + String(nextSeq).padStart(4, "0");

            const ownerRow = owner
                ? await client.query(
                    "select id from users where org_id = $1 and initials = $2",
                    [request.user.org_id, owner]
                  )
                : { rowCount: 0, rows: [] };

            const ownerId = ownerRow.rowCount ? ownerRow.rows[0].id : null;

            /* A new record starts at whatever this type's workflow calls
               its first state, not a literal 'draft'. 8D's first state
               is 'd1', for instance - a type with no workflow defined at
               all still falls back to 'draft' so creating one never
               hard-fails, but nothing shipped today should hit that
               fallback. */
            const firstState = await client.query(
                "select key from workflow_states where record_type_id = $1 order by position limit 1",
                [recordType.id]
            );
            const initialStatus = firstState.rowCount > 0 ? firstState.rows[0].key : "draft";

            const inserted = await client.query(`
                insert into records
                    (org_id, record_type_id, number, title, status, severity,
                     owner_id, data, form_version, created_by, due_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                returning id, number, status
            `, [request.user.org_id, recordType.id, number, title, initialStatus,
                severity, ownerId, data, formVersion, request.user.id, dueAt.value]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'records', $2, 'created', $3, $4)
            `, [request.user.org_id, inserted.rows[0].id, number, request.user.id]);

            return inserted.rows[0];
        });

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
            const current = await client.query(
                "select id, title, data, severity, due_at from records where org_id = $1 and number = $2 for update",
                [request.user.org_id, request.params.number]
            );

            if (current.rowCount === 0) return null;

            const record = current.rows[0];

            /* Who made this change is who is signed in, never a value the
               client sends. The audit log is only worth anything if the
               server, not the caller, decides whose name goes on it. */
            const actorId = request.user.id;

            for (const [key, value] of Object.entries(data)) {
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

            const merged = { ...record.data, ...data };

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

        response.json(updated);
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
                select r.id, r.status, r.record_type_id, rt.key as type
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

        response.status(outcome.code).json(outcome.body);
    } catch (error) {
        next(error);
    }
});
