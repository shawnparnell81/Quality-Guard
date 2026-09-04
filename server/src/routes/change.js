/* ============================================================
   Change control impact assessments.

   Clause 8.5.6 wants evidence that a change was reviewed and
   controlled. The change record itself rides on the ordinary records
   machinery; what needed its own home is the sign-off, because each
   line is a named person accepting an impact on their own area.

   Who signed and when is exactly what an auditor asks for, so it is
   a row rather than a field overwritten in place.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction, DEMO_ORG_ID } from "../db.js";

export const change = Router();

/* Each area is signed by whoever holds authority over it. Mapping the
   area to an existing permission avoids inventing a second set of
   rules that could drift from the first. */
const AREA_PERMISSION = {
    Engineering: "drawing.edit",
    Purchasing:  "vendor.approve",
    Production:  "production.hold",
    Quality:     "ncr.disposition",
    Warehouse:   "production.hold",
    Customer:    "complaint.respond"
};

/* GET /api/changes/ECN-2026-0121/impact */
change.get("/changes/:number/impact", async (request, response, next) => {
    try {
        const result = await query(`
            select a.area, a.impact, a.status, a.signed_at, a.position,
                   u.full_name as signed_by
              from change_impact_assessments a
              join records r on r.id = a.record_id
         left join users u   on u.id = a.signed_by
             where r.org_id = $1 and r.number = $2
             order by a.position
        `, [DEMO_ORG_ID, request.params.number]);

        /* Tell the caller which lines they personally may sign, so the
           UI does not have to know the mapping above. */
        const areas = result.rows.map((row) => {
            const permission = AREA_PERMISSION[row.area];

            return {
                ...row,
                required_permission: permission || null,
                can_sign: row.status === "pending"
                          && (!permission || request.can(permission))
            };
        });

        const outstanding = areas.filter((a) => a.status === "pending").length;

        response.json({
            number: request.params.number,
            areas,
            outstanding,
            complete: outstanding === 0
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/changes/ECN-2026-0121/impact/Production/sign
   { note, not_applicable } */
change.post("/changes/:number/impact/:area/sign", async (request, response, next) => {
    try {
        const { number, area } = request.params;
        const notApplicable = request.body?.not_applicable === true;

        const permission = AREA_PERMISSION[area];

        if (permission && !request.can(permission)) {
            return response.status(403).json({
                error: "Signing for " + area + " is not yours to give",
                required: permission,
                your_role: request.user.role_name
            });
        }

        const result = await withTransaction(async (client) => {
            const found = await client.query(`
                select a.id, a.status, r.id as record_id
                  from change_impact_assessments a
                  join records r on r.id = a.record_id
                 where r.org_id = $1 and r.number = $2 and a.area = $3
                   for update of a
            `, [DEMO_ORG_ID, number, area]);

            if (found.rowCount === 0) return null;

            const line = found.rows[0];

            if (line.status !== "pending") {
                return { conflict: area + " has already been signed" };
            }

            const status = notApplicable ? "not_applicable" : "signed";

            const updated = await client.query(`
                update change_impact_assessments
                   set status = $2, signed_by = $3, signed_at = now(),
                       impact = case when $4::text is null then impact
                                     else impact || '  Note: ' || $4 end
                 where id = $1
                returning area, status
            `, [line.id, status, request.user.id, request.body?.note || null]);

            await client.query(`
                insert into audit_log
                    (org_id, record_id, entity, entity_id, field,
                     old_value, new_value, reason, changed_by)
                values ($1, $2, 'change_impact', $3, $4, 'pending', $5, $6, $7)
            `, [DEMO_ORG_ID, line.record_id, line.id, area + " sign-off",
                status, request.body?.note || null, request.user.id]);

            return { line: updated.rows[0] };
        });

        if (!result) {
            return response.status(404).json({ error: "No such change or area" });
        }
        if (result.conflict) {
            return response.status(409).json({ error: result.conflict });
        }

        response.json(result.line);
    } catch (error) {
        next(error);
    }
});
