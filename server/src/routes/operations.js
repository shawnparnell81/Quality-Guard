/* ============================================================
   Receiving inspection and shipping.

   Clause 8.4.2 on the way in, clause 8.6 on the way out. Both are
   the same shape: a header, a set of checks, and a decision that
   somebody with the right authority signs.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";

export const operations = Router();

/* ============================================================
   Receiving
   ============================================================ */

operations.get("/receipts", async (request, response, next) => {
    try {
        const result = await query(`
            select r.receipt_number, r.po_number, r.part_number, r.qty_received,
                   r.received_at, r.sample_plan, r.status, r.notes,
                   v.name as vendor, v.grade as vendor_grade,
                   u.full_name as inspected_by, r.inspected_at,
                   (select count(*)::int from receipt_measurements m
                     where m.receipt_id = r.id) as measurements,
                   (select count(*)::int from receipt_measurements m
                     where m.receipt_id = r.id and m.result = 'fail') as failures
              from receipts r
         left join vendors v on v.id = r.vendor_id
         left join users u   on u.id = r.inspected_by
             where r.org_id = $1
             order by case r.status when 'pending' then 0 when 'reject' then 1 else 2 end,
                      r.received_at desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, receipts: result.rows });
    } catch (error) {
        next(error);
    }
});

operations.get("/receipts/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select r.id, r.receipt_number, r.po_number, r.part_number,
                   r.qty_received, r.received_at, r.sample_plan, r.status, r.notes,
                   v.name as vendor, v.grade as vendor_grade, v.ppm as vendor_ppm,
                   u.full_name as inspected_by, r.inspected_at
              from receipts r
         left join vendors v on v.id = r.vendor_id
         left join users u   on u.id = r.inspected_by
             where r.org_id = $1 and r.receipt_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such receipt" });
        }

        const measurements = await query(`
            select characteristic, specification, actual, result, gage_id
              from receipt_measurements
             where receipt_id = $1 order by position
        `, [found.rows[0].id]);

        response.json({
            receipt: found.rows[0],
            measurements: measurements.rows,
            can_disposition: request.can("ncr.disposition")
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/receipts/RCV-20260904-1/disposition  { accept, notes } */
operations.post("/receipts/:number/disposition",
    requirePermission("ncr.disposition"),
    async (request, response, next) => {
        try {
            const accept = request.body?.accept === true;

            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status from receipts where org_id = $1 and receipt_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );

                if (found.rowCount === 0) return null;
                if (found.rows[0].status !== "pending") {
                    return { conflict: "That receipt has already been dispositioned" };
                }

                const updated = await client.query(`
                    update receipts
                       set status = $2, inspected_by = $3, inspected_at = now(),
                           notes = coalesce($4, notes)
                     where id = $1
                    returning receipt_number, status
                `, [found.rows[0].id, accept ? "accept" : "reject",
                    request.user.id, request.body?.notes || null]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'receipts', $2, 'status', 'pending', $3, $4, $5)
                `, [request.user.org_id, found.rows[0].id, accept ? "accept" : "reject",
                    request.body?.notes || null, request.user.id]);

                return { receipt: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such receipt" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result.receipt);
        } catch (error) {
            next(error);
        }
    });

/* ============================================================
   Shipping
   ============================================================ */

operations.get("/shipments", async (request, response, next) => {
    try {
        const result = await query(`
            select s.shipment_number, s.customer, s.part_number, s.qty,
                   s.ship_date, s.carrier, s.status, s.released_at,
                   l.lot_number, u.full_name as released_by,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id) as checks_total,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id and c.status = 'pass') as checks_passed,
                   (select count(*)::int from shipment_checks c
                     where c.shipment_id = s.id and c.status = 'fail') as checks_failed
              from shipments s
         left join lots  l on l.id = s.lot_id
         left join users u on u.id = s.released_by
             where s.org_id = $1
             order by case s.status
                        when 'blocked' then 0
                        when 'awaiting_release' then 1
                        when 'preparing' then 2
                        else 3 end,
                      s.ship_date desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, shipments: result.rows });
    } catch (error) {
        next(error);
    }
});

operations.get("/shipments/:number", async (request, response, next) => {
    try {
        const found = await query(`
            select s.id, s.shipment_number, s.customer, s.part_number, s.qty,
                   s.ship_date, s.carrier, s.status, s.released_at,
                   l.lot_number, l.heat_number, u.full_name as released_by
              from shipments s
         left join lots  l on l.id = s.lot_id
         left join users u on u.id = s.released_by
             where s.org_id = $1 and s.shipment_number = $2
        `, [request.user.org_id, request.params.number]);

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such shipment" });
        }

        const shipment = found.rows[0];

        const checks = await query(`
            select description, evidence, status, position
              from shipment_checks where shipment_id = $1 order by position
        `, [shipment.id]);

        const outstanding = checks.rows.filter((c) => c.status !== "pass");

        response.json({
            shipment,
            checks: checks.rows,
            outstanding: outstanding.length,
            can_release: request.can("shipping.release") && outstanding.length === 0
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/shipments/SHIP-20260903-02/release

   Refuses while any check is outstanding. That refusal is the whole
   of clause 8.6: planned verification complete before release. */
operations.post("/shipments/:number/release",
    requirePermission("shipping.release"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(
                    "select id, status from shipments where org_id = $1 and shipment_number = $2 for update",
                    [request.user.org_id, request.params.number]
                );

                if (found.rowCount === 0) return null;
                const shipment = found.rows[0];

                if (shipment.status === "shipped") {
                    return { conflict: "That shipment has already been released" };
                }

                const outstanding = await client.query(`
                    select description from shipment_checks
                     where shipment_id = $1 and status <> 'pass'
                     order by position
                `, [shipment.id]);

                if (outstanding.rowCount > 0) {
                    return {
                        conflict: "Release checks are not complete",
                        blocking: outstanding.rows.map((row) => row.description)
                    };
                }

                const updated = await client.query(`
                    update shipments
                       set status = 'shipped', released_by = $2, released_at = now()
                     where id = $1
                    returning shipment_number, status
                `, [shipment.id, request.user.id]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'shipments', $2, 'status', $3, 'shipped', $4, $5)
                `, [request.user.org_id, shipment.id, shipment.status,
                    request.body?.reason || null, request.user.id]);

                return { shipment: updated.rows[0] };
            });

            if (!result) return response.status(404).json({ error: "No such shipment" });

            if (result.conflict) {
                return response.status(409).json({
                    error: result.conflict,
                    blocking: result.blocking
                });
            }

            response.json(result.shipment);
        } catch (error) {
            next(error);
        }
    });

/* Marks one release check complete. */
operations.post("/shipments/:number/checks/:position/pass",
    requirePermission("shipping.release"),
    async (request, response, next) => {
        try {
            const result = await query(`
                update shipment_checks c
                   set status = 'pass',
                       evidence = coalesce($3, c.evidence)
                  from shipments s
                 where s.id = c.shipment_id
                   and s.org_id = $1 and s.shipment_number = $2
                   and c.position = $4
                returning c.description, c.status
            `, [request.user.org_id, request.params.number,
                request.body?.evidence || null, Number(request.params.position)]);

            if (result.rowCount === 0) {
                return response.status(404).json({ error: "No such check" });
            }

            response.json(result.rows[0]);
        } catch (error) {
            next(error);
        }
    });
