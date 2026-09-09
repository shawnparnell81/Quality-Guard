/* ============================================================
   Customer Service logs: purchase orders, purchase requests, the
   production log.

   Registers, not workflows. Each row is a thin record - a number, a
   party, a status, the dates that matter - with a `data jsonb`
   column carrying whatever the finessed form adds later. Viewing a
   log needs only a session; creating and editing purchase entries
   needs purchasing.log, and the production log reuses wo.log so the
   CSR who writes the work orders (and the GM) are the only people
   who can change a row.

   The work order log lives in production.js, on the existing
   work_orders table.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";

export const logs = Router();

const PO_STATUS = new Set([
    "draft", "open", "partially_received", "received", "closed", "cancelled"
]);
const PR_STATUS = new Set([
    "draft", "submitted", "approved", "rejected", "ordered", "closed"
]);
const PL_STATUS = new Set([
    "scheduled", "in_production", "hold", "shipped", "closed", "cancelled"
]);

/* PO-2026-0007 / PR-2026-0007 - sorted on the numeric suffix, not the
   text, so the tenth of a year does not collide with the ninth. */
async function nextNumber(client, orgId, table, column, prefix) {
    const year = new Date().getFullYear();
    const like = prefix + "-" + year + "-%";
    const last = await client.query(`
        select coalesce(max(split_part(${column}, '-', 3)::int), 0) as seq
          from ${table}
         where org_id = $1 and ${column} like $2
    `, [orgId, like]);
    return prefix + "-" + year + "-" + String(last.rows[0].seq + 1).padStart(4, "0");
}

function num(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/* Quantities land in integer columns - round a stray decimal rather
   than let Postgres reject the whole write. */
function whole(value) {
    const n = num(value);
    return n === null ? null : Math.round(n);
}

/* ============================================================
   Purchase orders
   ============================================================ */

logs.get("/purchase-orders", async (request, response, next) => {
    try {
        const result = await query(`
            select po.po_number, po.status, po.order_date, po.need_by_date,
                   po.total_amount, po.currency, po.notes, po.data, po.created_at,
                   coalesce(v.name, po.vendor_name) as vendor,
                   (v.id is not null) as vendor_on_avl,
                   u.full_name as buyer
              from purchase_orders po
         left join vendors v on v.id = po.vendor_id
         left join users u   on u.id = po.buyer_id
             where po.org_id = $1
             order by case po.status
                        when 'open' then 0 when 'partially_received' then 1
                        when 'draft' then 2 else 3 end,
                      po.order_date desc nulls last, po.created_at desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, purchase_orders: result.rows });
    } catch (error) {
        next(error);
    }
});

logs.get("/purchase-orders/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select po.*, coalesce(v.name, po.vendor_name) as vendor,
                   (v.id is not null) as vendor_on_avl,
                   u.full_name as buyer
              from purchase_orders po
         left join vendors v on v.id = po.vendor_id
         left join users u   on u.id = po.buyer_id
             where po.org_id = $1 and po.po_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) return response.status(404).json({ error: "No such purchase order" });
        response.json({ purchase_order: found.rows[0], can_edit: request.can("purchasing.log") });
    } catch (error) {
        next(error);
    }
});

logs.post("/purchase-orders", requirePermission("purchasing.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            const vendorName = (body.vendor || body.vendor_name || "").trim();
            if (!vendorName) {
                return response.status(422).json({ error: "A vendor is required" });
            }

            const status = PO_STATUS.has(body.status) ? body.status : "open";

            const created = await withTransaction(async (client) => {
                let vendorId = null;
                if (body.vendor) {
                    const v = await client.query(
                        "select id from vendors where org_id = $1 and name = $2",
                        [request.user.org_id, vendorName]
                    );
                    vendorId = v.rows[0]?.id || null;
                }

                const number = (body.po_number || "").trim()
                    || await nextNumber(client, request.user.org_id, "purchase_orders", "po_number", "PO");

                const clash = await client.query(
                    "select 1 from purchase_orders where org_id = $1 and po_number = $2",
                    [request.user.org_id, number]
                );
                if (clash.rowCount > 0) return { conflict: "A purchase order already has that number: " + number };

                const inserted = await client.query(`
                    insert into purchase_orders
                        (org_id, po_number, vendor_id, vendor_name, status, order_date,
                         need_by_date, total_amount, currency, buyer_id, notes, data, created_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                    returning po_number, status, order_date, need_by_date, total_amount, currency, data
                `, [request.user.org_id, number, vendorId, vendorId ? null : vendorName,
                    status, body.order_date || null, body.need_by_date || null,
                    num(body.total_amount), (body.currency || "USD").trim() || "USD",
                    request.user.id, body.notes || null,
                    body.data && typeof body.data === "object" ? body.data : {},
                    request.user.id]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'purchase_orders', null, 'created', $2, $3)
                `, [request.user.org_id, number, request.user.id]);

                return { row: { ...inserted.rows[0], vendor: vendorName } };
            });

            if (created.conflict) return response.status(409).json({ error: created.conflict });
            response.status(201).json(created.row);
        } catch (error) {
            next(error);
        }
    });

logs.patch("/purchase-orders/:number", requirePermission("purchasing.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            if (body.status !== undefined && !PO_STATUS.has(body.status)) {
                return response.status(422).json({ error: "Unknown status: " + body.status });
            }

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status, data from purchase_orders where org_id = $1 and po_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );
                if (found.rowCount === 0) return null;

                /* A closed or cancelled PO is done. Its status can still
                   be changed (to reopen it); nothing else. */
                const editsBeyondStatus = Object.keys(body).some((k) => k !== "status");
                if (["closed", "cancelled"].includes(found.rows[0].status) && editsBeyondStatus) {
                    return { conflict: "This purchase order is " + found.rows[0].status
                        + " - reopen it before editing" };
                }

                const mergedData = body.data && typeof body.data === "object"
                    ? { ...(found.rows[0].data || {}), ...body.data }
                    : (found.rows[0].data || {});

                const updated = await client.query(`
                    update purchase_orders
                       set status        = coalesce($3, status),
                           order_date    = coalesce($4, order_date),
                           need_by_date  = coalesce($5, need_by_date),
                           total_amount  = coalesce($6, total_amount),
                           currency      = coalesce($7, currency),
                           notes         = coalesce($8, notes),
                           data          = $9,
                           updated_at    = now()
                     where id = $1 and org_id = $2
                    returning po_number, status, order_date, need_by_date,
                              total_amount, currency, notes, data
                `, [found.rows[0].id, request.user.org_id,
                    body.status || null, body.order_date || null, body.need_by_date || null,
                    num(body.total_amount), (body.currency || "").trim() || null,
                    body.notes || null, mergedData]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'purchase_orders', null, 'updated', $2, $3)
                `, [request.user.org_id, request.params.number, request.user.id]);

                return updated.rows[0];
            });

            if (!result) return response.status(404).json({ error: "No such purchase order" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });
            response.json(result);
        } catch (error) {
            next(error);
        }
    });

/* ============================================================
   Purchase requests
   ============================================================ */

logs.get("/purchase-requests", async (request, response, next) => {
    try {
        const result = await query(`
            select pr.pr_number, pr.department, pr.status, pr.needed_by_date,
                   pr.estimated_cost, pr.description, pr.po_number, pr.notes, pr.data,
                   pr.created_at, u.full_name as requested_by
              from purchase_requests pr
         left join users u on u.id = pr.requested_by
             where pr.org_id = $1
             order by case pr.status
                        when 'submitted' then 0 when 'approved' then 1
                        when 'draft' then 2 else 3 end,
                      pr.created_at desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, purchase_requests: result.rows });
    } catch (error) {
        next(error);
    }
});

logs.get("/purchase-requests/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select pr.*, u.full_name as requested_by
              from purchase_requests pr
         left join users u on u.id = pr.requested_by
             where pr.org_id = $1 and pr.pr_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) return response.status(404).json({ error: "No such purchase request" });
        response.json({ purchase_request: found.rows[0], can_edit: request.can("purchasing.log") });
    } catch (error) {
        next(error);
    }
});

logs.post("/purchase-requests", requirePermission("purchasing.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            const description = (body.description || "").trim();
            if (!description) {
                return response.status(422).json({ error: "A description of what is needed is required" });
            }

            const status = PR_STATUS.has(body.status) ? body.status : "submitted";

            const created = await withTransaction(async (client) => {
                const number = (body.pr_number || "").trim()
                    || await nextNumber(client, request.user.org_id, "purchase_requests", "pr_number", "PR");

                const clash = await client.query(
                    "select 1 from purchase_requests where org_id = $1 and pr_number = $2",
                    [request.user.org_id, number]
                );
                if (clash.rowCount > 0) return { conflict: "A purchase request already has that number: " + number };

                const inserted = await client.query(`
                    insert into purchase_requests
                        (org_id, pr_number, requested_by, department, status, needed_by_date,
                         estimated_cost, description, po_number, notes, data, created_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    returning pr_number, department, status, needed_by_date,
                              estimated_cost, description, po_number, data
                `, [request.user.org_id, number, request.user.id,
                    (body.department || "").trim() || null, status, body.needed_by_date || null,
                    num(body.estimated_cost), description,
                    (body.po_number || "").trim() || null, body.notes || null,
                    body.data && typeof body.data === "object" ? body.data : {},
                    request.user.id]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'purchase_requests', null, 'created', $2, $3)
                `, [request.user.org_id, number, request.user.id]);

                return { row: inserted.rows[0] };
            });

            if (created.conflict) return response.status(409).json({ error: created.conflict });
            response.status(201).json(created.row);
        } catch (error) {
            next(error);
        }
    });

logs.patch("/purchase-requests/:number", requirePermission("purchasing.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            if (body.status !== undefined && !PR_STATUS.has(body.status)) {
                return response.status(422).json({ error: "Unknown status: " + body.status });
            }

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status, data from purchase_requests where org_id = $1 and pr_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );
                if (found.rowCount === 0) return null;

                const editsBeyondStatus = Object.keys(body).some((k) => k !== "status");
                if (["closed", "rejected"].includes(found.rows[0].status) && editsBeyondStatus) {
                    return { conflict: "This request is " + found.rows[0].status
                        + " - reopen it before editing" };
                }

                const mergedData = body.data && typeof body.data === "object"
                    ? { ...(found.rows[0].data || {}), ...body.data }
                    : (found.rows[0].data || {});

                const updated = await client.query(`
                    update purchase_requests
                       set status         = coalesce($3, status),
                           department     = coalesce($4, department),
                           needed_by_date = coalesce($5, needed_by_date),
                           estimated_cost = coalesce($6, estimated_cost),
                           description    = coalesce($7, description),
                           po_number      = coalesce($8, po_number),
                           notes          = coalesce($9, notes),
                           data           = $10,
                           updated_at     = now()
                     where id = $1 and org_id = $2
                    returning pr_number, department, status, needed_by_date,
                              estimated_cost, description, po_number, notes, data
                `, [found.rows[0].id, request.user.org_id,
                    body.status || null, (body.department || "").trim() || null,
                    body.needed_by_date || null, num(body.estimated_cost),
                    (body.description || "").trim() || null,
                    (body.po_number || "").trim() || null, body.notes || null, mergedData]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'purchase_requests', null, 'updated', $2, $3)
                `, [request.user.org_id, request.params.number, request.user.id]);

                return updated.rows[0];
            });

            if (!result) return response.status(404).json({ error: "No such purchase request" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });
            response.json(result);
        } catch (error) {
            next(error);
        }
    });

/* ============================================================
   Production log

   The CSR's ledger of orders through production. One thin row per
   tracked job, following a work order by number - work_orders stays
   the source of truth for what is on the floor. Reading is open;
   wo.log gates the writes, the same permission the work-order author
   already holds.
   ============================================================ */

/* Bare list, for RETURNING (no table alias allowed there). The
   SELECTs below join users, which also has `status` and `created_at`,
   so they use `pl.*` rather than this. */
const PL_COLUMNS = `pl_number, wo_number, customer, customer_po, part_number,
    revision, status, order_date, promised_date, qty_ordered, qty_completed,
    qty_scrapped, qty_shipped, line, notes, data`;

/* What the floor says about the work order this row follows: its
   status, any hold reason, and how many nonconformances against it
   are still open. Null when the row names no work order or the
   number does not match one. */
async function woContext(orgId, woNumber) {
    if (!woNumber) return null;
    const found = await query(`
        select w.status, w.hold_reason,
               count(r.id) filter (
                   where r.closed_at is null and rt.key = 'ncr'
               )::int as open_ncr_count
          from work_orders w
     left join records r on r.org_id = w.org_id and r.data->>'work_order' = w.wo_number
     left join record_types rt on rt.id = r.record_type_id
         where w.org_id = $1 and w.wo_number = $2
         group by w.status, w.hold_reason
    `, [orgId, woNumber]);
    return found.rows[0] || null;
}

logs.get("/production-logs", async (request, response, next) => {
    try {
        const result = await query(`
            select pl.*, u.full_name as created_by
              from production_logs pl
         left join users u on u.id = pl.created_by
             where pl.org_id = $1
             order by case pl.status
                        when 'hold' then 0 when 'in_production' then 1
                        when 'scheduled' then 2 else 3 end,
                      pl.promised_date asc nulls last, pl.created_at desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, production_logs: result.rows });
    } catch (error) {
        next(error);
    }
});

logs.get("/production-logs/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select pl.*, u.full_name as created_by
              from production_logs pl
         left join users u on u.id = pl.created_by
             where pl.org_id = $1 and pl.pl_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) return response.status(404).json({ error: "No such production log entry" });

        response.json({
            production_log: found.rows[0],
            wo_context: await woContext(request.user.org_id, found.rows[0].wo_number),
            can_edit: request.can("wo.log")
        });
    } catch (error) {
        next(error);
    }
});

logs.post("/production-logs", requirePermission("wo.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            const status = PL_STATUS.has(body.status) ? body.status : "scheduled";

            const created = await withTransaction(async (client) => {
                const number = (body.pl_number || "").trim()
                    || await nextNumber(client, request.user.org_id, "production_logs", "pl_number", "PL");

                const clash = await client.query(
                    "select 1 from production_logs where org_id = $1 and pl_number = $2",
                    [request.user.org_id, number]
                );
                if (clash.rowCount > 0) return { conflict: "A production log entry already has that number: " + number };

                const inserted = await client.query(`
                    insert into production_logs
                        (org_id, pl_number, wo_number, customer, customer_po, part_number,
                         revision, status, order_date, promised_date, qty_ordered, qty_completed,
                         qty_scrapped, qty_shipped, line, notes, data, created_by)
                    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                    returning ${PL_COLUMNS}
                `, [request.user.org_id, number,
                    (body.wo_number || "").trim() || null,
                    (body.customer || "").trim() || null,
                    (body.customer_po || "").trim() || null,
                    (body.part_number || "").trim() || null,
                    (body.revision || "").trim() || null,
                    status, body.order_date || null, body.promised_date || null,
                    whole(body.qty_ordered), whole(body.qty_completed),
                    whole(body.qty_scrapped), whole(body.qty_shipped),
                    (body.line || "").trim() || null, body.notes || null,
                    body.data && typeof body.data === "object" ? body.data : {},
                    request.user.id]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'production_logs', null, 'created', $2, $3)
                `, [request.user.org_id, number, request.user.id]);

                return { row: inserted.rows[0] };
            });

            if (created.conflict) return response.status(409).json({ error: created.conflict });
            response.status(201).json(created.row);
        } catch (error) {
            next(error);
        }
    });

logs.patch("/production-logs/:number", requirePermission("wo.log"),
    async (request, response, next) => {
        try {
            const body = request.body || {};
            if (body.status !== undefined && !PL_STATUS.has(body.status)) {
                return response.status(422).json({ error: "Unknown status: " + body.status });
            }

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status, data from production_logs where org_id = $1 and pl_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );
                if (found.rowCount === 0) return null;

                /* A closed or cancelled entry is done with. Its status
                   can still change (to reopen it); nothing else. */
                const editsBeyondStatus = Object.keys(body).some((k) => k !== "status");
                if (["closed", "cancelled"].includes(found.rows[0].status) && editsBeyondStatus) {
                    return { conflict: "This entry is " + found.rows[0].status
                        + " - reopen it before editing" };
                }

                const str = (key) => body[key] === undefined
                    ? null
                    : ((body[key] || "").trim() || null);

                const mergedData = body.data && typeof body.data === "object"
                    ? { ...(found.rows[0].data || {}), ...body.data }
                    : (found.rows[0].data || {});

                const updated = await client.query(`
                    update production_logs
                       set wo_number     = coalesce($3, wo_number),
                           customer      = coalesce($4, customer),
                           customer_po   = coalesce($5, customer_po),
                           part_number   = coalesce($6, part_number),
                           revision      = coalesce($7, revision),
                           status        = coalesce($8, status),
                           order_date    = coalesce($9, order_date),
                           promised_date = coalesce($10, promised_date),
                           qty_ordered   = coalesce($11, qty_ordered),
                           qty_completed = coalesce($12, qty_completed),
                           qty_scrapped  = coalesce($13, qty_scrapped),
                           qty_shipped   = coalesce($14, qty_shipped),
                           line          = coalesce($15, line),
                           notes         = coalesce($16, notes),
                           data          = $17,
                           updated_at    = now()
                     where id = $1 and org_id = $2
                    returning ${PL_COLUMNS}
                `, [found.rows[0].id, request.user.org_id,
                    str("wo_number"), str("customer"), str("customer_po"),
                    str("part_number"), str("revision"),
                    body.status || null, body.order_date || null, body.promised_date || null,
                    whole(body.qty_ordered), whole(body.qty_completed),
                    whole(body.qty_scrapped), whole(body.qty_shipped),
                    str("line"), body.notes === undefined ? null : (body.notes || null),
                    mergedData]);

                await client.query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'production_logs', null, 'updated', $2, $3)
                `, [request.user.org_id, request.params.number, request.user.id]);

                return updated.rows[0];
            });

            if (!result) return response.status(404).json({ error: "No such production log entry" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });
            response.json(result);
        } catch (error) {
            next(error);
        }
    });
