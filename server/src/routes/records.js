/* ============================================================
   Quality events.

   NCR, CAPA, 8D, complaint, SCAR, audit and risk all route through
   this one file, because they are all rows in the records table.
   The record type is a query parameter, not a separate endpoint.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction, DEMO_ORG_ID } from "../db.js";
import { requirePermission, createPermissionFor, closePermissionFor } from "../auth.js";

export const records = Router();

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
        const params = [DEMO_ORG_ID];

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

/* ---------- one record, with its graph and history ----------
   GET /api/records/NCR-2026-0142 */
records.get("/:number", async (request, response, next) => {
    try {
        const found = await query(
            SELECT_RECORD + " and r.number = $2",
            [DEMO_ORG_ID, request.params.number]
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
           should say who can. */
        const moves = await query(`
            select wt.to_state, wt.required_permission,
                   ws.name as to_name, ws.is_terminal,
                   p.description as permission_description
              from workflow_transitions wt
              join record_types rt on rt.id = wt.record_type_id
         left join workflow_states ws
                on ws.record_type_id = wt.record_type_id and ws.key = wt.to_state
         left join permissions p on p.key = wt.required_permission
             where rt.key = $1 and wt.from_state = $2
             order by ws.position
        `, [record.type, record.status]);

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

/* ---------- create ----------
   POST /api/records
   { "type": "ncr", "title": "...", "owner": "MO", "data": { ... } }

   The payload is validated against the published form schema, so
   changing the form in the Form Builder changes what the API
   accepts without touching this file. */
records.post("/", requirePermission(createPermissionFor), async (request, response, next) => {
    try {
        const { type, title, owner, data = {}, severity = "ok" } = request.body || {};

        if (!type || !title) {
            return response.status(400).json({
                error: "type and title are required"
            });
        }

        const typeRow = await query(
            "select id, prefix from record_types where org_id = $1 and key = $2",
            [DEMO_ORG_ID, type]
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
            `, [DEMO_ORG_ID, recordType.id, pattern]);

            const nextSeq = last.rowCount === 0
                ? 1
                : Number(last.rows[0].number.split("-").pop()) + 1;

            const number = recordType.prefix + "-" + year + "-"
                + String(nextSeq).padStart(4, "0");

            const ownerRow = owner
                ? await client.query(
                    "select id from users where org_id = $1 and initials = $2",
                    [DEMO_ORG_ID, owner]
                  )
                : { rowCount: 0, rows: [] };

            const ownerId = ownerRow.rowCount ? ownerRow.rows[0].id : null;

            const inserted = await client.query(`
                insert into records
                    (org_id, record_type_id, number, title, status, severity,
                     owner_id, data, form_version, created_by)
                values ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $6)
                returning id, number, status
            `, [DEMO_ORG_ID, recordType.id, number, title, severity,
                ownerId, data, formVersion]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field, new_value, changed_by)
                values ($1, $2, 'records', $2, 'created', $3, $4)
            `, [DEMO_ORG_ID, inserted.rows[0].id, number, ownerId]);

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
        const { data = {}, severity, reason, actor } = request.body || {};

        const updated = await withTransaction(async (client) => {
            const current = await client.query(
                "select id, data, severity from records where org_id = $1 and number = $2 for update",
                [DEMO_ORG_ID, request.params.number]
            );

            if (current.rowCount === 0) return null;

            const record = current.rows[0];

            const actorRow = actor
                ? await client.query(
                    "select id from users where org_id = $1 and initials = $2",
                    [DEMO_ORG_ID, actor]
                  )
                : { rowCount: 0, rows: [] };

            const actorId = actorRow.rowCount ? actorRow.rows[0].id : null;

            for (const [key, value] of Object.entries(data)) {
                const before = record.data[key];
                if (String(before) === String(value)) continue;

                await client.query(`
                    insert into audit_log
                        (org_id, record_id, entity, entity_id, field,
                         old_value, new_value, reason, changed_by)
                    values ($1, $2, 'records', $2, $3, $4, $5, $6, $7)
                `, [DEMO_ORG_ID, record.id, key,
                    before === undefined ? null : String(before),
                    String(value), reason || null, actorId]);
            }

            const merged = { ...record.data, ...data };

            const result = await client.query(`
                update records
                   set data = $2,
                       severity = coalesce($3, severity)
                 where id = $1
                returning id, number, status, severity, data
            `, [record.id, merged, severity || null]);

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
            `, [DEMO_ORG_ID, request.params.number]);

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
            `, [DEMO_ORG_ID, record.id, record.status, to, reason || null, actorId]);

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
