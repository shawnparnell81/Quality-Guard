/* ============================================================
   Production.

   Clause 8.5.1, control of production. A work order carries the
   traveller, the first article, and any quality event raised against
   it, which together are the evidence that the lot was made under
   controlled conditions.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction, DEMO_ORG_ID } from "../db.js";
import { requirePermission } from "../auth.js";

export const production = Router();

/* ---------- list ----------
   GET /api/work-orders?open=true */
production.get("/work-orders", async (request, response, next) => {
    try {
        const openOnly = request.query.open === "true";

        const result = await query(`
            select w.wo_number, w.qty, w.current_op, w.total_ops, w.cell, w.status,
                   w.hold_reason,
                   p.part_number, p.description as part_description,
                   l.lot_number,
                   u.full_name as held_by, w.held_at,
                   count(o.id) filter (where o.status = 'pass')::int as ops_done,
                   count(o.id)::int                                  as ops_total,
                   count(o.id) filter (where o.status = 'fail')::int  as ops_failed
              from work_orders w
         left join parts p on p.id = w.part_id
         left join lots  l on l.id = w.lot_id
         left join users u on u.id = w.held_by
         left join work_order_operations o on o.work_order_id = w.id
             where w.org_id = $1
               ${openOnly ? "and w.status <> 'complete'" : ""}
             group by w.id, p.part_number, p.description, l.lot_number, u.full_name
             order by case w.status
                        when 'quality_hold' then 0
                        when 'mrb_hold'     then 1
                        when 'running'      then 2
                        else 3 end,
                      w.wo_number
        `, [DEMO_ORG_ID]);

        response.json({ count: result.rowCount, work_orders: result.rows });
    } catch (error) {
        next(error);
    }
});

/* ---------- one work order ----------
   GET /api/work-orders/WO-31882 */
production.get("/work-orders/:wo", async (request, response, next) => {
    try {
        const found = await query(`
            select w.id, w.wo_number, w.qty, w.current_op, w.total_ops, w.cell,
                   w.status, w.hold_reason, w.held_at,
                   p.part_number, p.description as part_description, p.revision,
                   l.lot_number, l.heat_number,
                   u.full_name as held_by
              from work_orders w
         left join parts p on p.id = w.part_id
         left join lots  l on l.id = w.lot_id
         left join users u on u.id = w.held_by
             where w.org_id = $1 and w.wo_number = $2
        `, [DEMO_ORG_ID, request.params.wo]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such work order" });
        }

        const workOrder = found.rows[0];

        const [traveller, firstArticle, events] = await Promise.all([
            query(`
                select o.op_number, o.description, o.status, o.completed_at, o.notes,
                       u.full_name as operator
                  from work_order_operations o
             left join users u on u.id = o.operator_id
                 where o.work_order_id = $1
                 order by o.position
            `, [workOrder.id]),

            query(`
                select f.characteristic_no, f.specification, f.actual, f.result,
                       f.gage_id, f.measured_at, u.full_name as measured_by
                  from first_article_results f
             left join users u on u.id = f.measured_by
                 where f.work_order_id = $1
                 order by f.characteristic_no
            `, [workOrder.id]),

            /* Quality events raised against this work order. NCRs carry
               the work order in their form payload, so this is a lookup
               into the JSONB rather than a foreign key. */
            query(`
                select r.number, r.title, r.status, r.severity, rt.key as type
                  from records r
                  join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1
                   and r.data->>'work_order' = $2
                 order by r.opened_at desc
            `, [DEMO_ORG_ID, request.params.wo])
        ]);

        response.json({
            work_order: workOrder,
            traveller: traveller.rows,
            first_article: firstArticle.rows,
            quality_events: events.rows
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- hold ----------
   POST /api/work-orders/WO-31890/hold  { reason } */
production.post("/work-orders/:wo/hold",
    requirePermission("production.hold"),
    async (request, response, next) => {
        try {
            const reason = (request.body?.reason || "").trim();

            if (!reason) {
                return response.status(400).json({
                    error: "A reason is required to hold a work order"
                });
            }

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status from work_orders where org_id = $1 and wo_number = $2 for update",
                    [DEMO_ORG_ID, request.params.wo]
                );

                if (found.rowCount === 0) return null;
                const workOrder = found.rows[0];

                if (workOrder.status === "complete") {
                    return { conflict: "That work order is already complete" };
                }

                const updated = await client.query(`
                    update work_orders
                       set status = 'quality_hold',
                           hold_reason = $2, held_by = $3, held_at = now()
                     where id = $1
                    returning wo_number, status, hold_reason
                `, [workOrder.id, reason, request.user.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'work_orders', $2, 'status', $3, 'quality_hold', $4, $5)
                `, [DEMO_ORG_ID, workOrder.id, workOrder.status, reason, request.user.id]);

                return { workOrder: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such work order" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result.workOrder);
        } catch (error) {
            next(error);
        }
    });

/* ---------- release ----------
   POST /api/work-orders/WO-31882/release  { reason }

   Releasing while a nonconformance on the same work order is still
   open is refused. That rule is the reason the hold exists. */
production.post("/work-orders/:wo/release",
    requirePermission("production.release"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status from work_orders where org_id = $1 and wo_number = $2 for update",
                    [DEMO_ORG_ID, request.params.wo]
                );

                if (found.rowCount === 0) return null;
                const workOrder = found.rows[0];

                const openEvents = await client.query(`
                    select r.number from records r
                      join record_types rt on rt.id = r.record_type_id
                     where r.org_id = $1
                       and r.data->>'work_order' = $2
                       and r.closed_at is null
                       and rt.key = 'ncr'
                `, [DEMO_ORG_ID, request.params.wo]);

                if (openEvents.rowCount > 0) {
                    return {
                        conflict: "Cannot release while a nonconformance is open",
                        blocking: openEvents.rows.map((row) => row.number)
                    };
                }

                const updated = await client.query(`
                    update work_orders
                       set status = 'running',
                           hold_reason = null, held_by = null, held_at = null
                     where id = $1
                    returning wo_number, status
                `, [workOrder.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'work_orders', $2, 'status', $3, 'running', $4, $5)
                `, [DEMO_ORG_ID, workOrder.id, workOrder.status,
                    request.body?.reason || null, request.user.id]);

                return { workOrder: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such work order" });

            if (result.conflict) {
                return response.status(409).json({
                    error: result.conflict,
                    blocking: result.blocking
                });
            }

            response.json(result.workOrder);
        } catch (error) {
            next(error);
        }
    });
