/* ============================================================
   Engineering drawings, clause 8.3.

   A drawing is a controlled document with a revision history and an
   access level. Production sees the released revision and nothing
   else, which is the control the clause is asking for.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction, DEMO_ORG_ID } from "../db.js";
import { requirePermission } from "../auth.js";

export const engineering = Router();

engineering.get("/drawings", requirePermission("drawing.read"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select d.drawing_number, d.title, d.customer, d.current_revision,
                       d.status, d.access_level,
                       u.full_name as owner,
                       p.description as part_description,
                       (select count(*)::int from drawing_revisions r
                         where r.drawing_id = d.id) as revision_count,
                       (select r.ecn_number from drawing_revisions r
                         where r.drawing_id = d.id and r.status in ('draft','in_review')
                         limit 1) as open_ecn
                  from drawings d
             left join users u on u.id = d.owner_id
             left join parts p on p.id = d.part_id
                 where d.org_id = $1
                 order by d.drawing_number
            `, [DEMO_ORG_ID]);

            response.json({ count: result.rowCount, drawings: result.rows });
        } catch (error) {
            next(error);
        }
    });

engineering.get("/drawings/:number", requirePermission("drawing.read"),
    async (request, response, next) => {
        try {
            const found = await query(`
                select d.id, d.drawing_number, d.title, d.customer,
                       d.current_revision, d.status, d.access_level,
                       u.full_name as owner, p.part_number, p.description as part_description
                  from drawings d
             left join users u on u.id = d.owner_id
             left join parts p on p.id = d.part_id
                 where d.org_id = $1 and d.drawing_number = $2
            `, [DEMO_ORG_ID, request.params.number]);

            if (found.rowCount === 0) {
                return response.status(404).json({ error: "No such drawing" });
            }

            const drawing = found.rows[0];

            const revisions = await query(`
                select r.revision, r.change_summary, r.ecn_number, r.status,
                       r.released_at, u.full_name as released_by
                  from drawing_revisions r
             left join users u on u.id = r.released_by
                 where r.drawing_id = $1
                 order by r.revision desc
            `, [drawing.id]);

            response.json({
                drawing,
                revisions: revisions.rows,
                can_release: request.can("drawing.release")
            });
        } catch (error) {
            next(error);
        }
    });

/* POST /api/drawings/RP-2210-C/revisions/G/release

   The authority a design engineer is deliberately missing. Clause 8.3
   expects design output to be verified by somebody other than whoever
   drew it. */
engineering.post("/drawings/:number/revisions/:revision/release",
    requirePermission("drawing.release"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(`
                    select r.id, r.status, r.revision, d.id as drawing_id
                      from drawing_revisions r
                      join drawings d on d.id = r.drawing_id
                     where d.org_id = $1 and d.drawing_number = $2 and r.revision = $3
                       for update of r
                `, [DEMO_ORG_ID, request.params.number, request.params.revision]);

                if (found.rowCount === 0) return null;
                const revision = found.rows[0];

                if (revision.status === "released") {
                    return { conflict: "That revision is already released" };
                }

                /* Releasing supersedes whatever was current. Two live
                   revisions of one drawing is the failure mode this
                   whole module exists to prevent. */
                await client.query(`
                    update drawing_revisions set status = 'superseded'
                     where drawing_id = $1 and status = 'released'
                `, [revision.drawing_id]);

                await client.query(`
                    update drawing_revisions
                       set status = 'released', released_by = $2, released_at = now()
                     where id = $1
                `, [revision.id, request.user.id]);

                await client.query(`
                    update drawings
                       set current_revision = $2, status = 'released'
                     where id = $1
                `, [revision.drawing_id, revision.revision]);

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'drawings', $2, 'released_revision', $3, $4, $5, $6)
                `, [DEMO_ORG_ID, revision.drawing_id, revision.status, revision.revision,
                    request.body?.reason || null, request.user.id]);

                return { released: revision.revision };
            });

            if (!result) return response.status(404).json({ error: "No such drawing revision" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result);
        } catch (error) {
            next(error);
        }
    });
