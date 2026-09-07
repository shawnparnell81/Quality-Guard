/* ============================================================
   Per-organization layout for the dashboard and the menu bar.

   One row per (org, kind). Any signed-in user reads it - the client
   applies it on render. Changing it needs layout.manage; the user's
   decision was that an admin sets this once for the whole org rather
   than each person personalising their own.

   The layout body is opaque here: the client owns its shape, this
   route only stores and returns it. A null (or absent) `layout` in a
   PUT clears the row, which is how "reset to default" works.
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";
import { requirePermission } from "../auth.js";

export const layout = Router();

const KINDS = new Set(["dashboard", "nav"]);

layout.get("/layout/:kind", async (request, response, next) => {
    try {
        if (!KINDS.has(request.params.kind)) {
            return response.status(404).json({ error: "Unknown layout: " + request.params.kind });
        }

        const found = await query(
            "select layout, updated_at from org_layouts where org_id = $1 and kind = $2",
            [request.user.org_id, request.params.kind]
        );

        response.json({
            kind: request.params.kind,
            layout: found.rowCount > 0 ? found.rows[0].layout : null,
            updated_at: found.rows[0]?.updated_at || null,
            can_manage: request.can("layout.manage")
        });
    } catch (error) {
        next(error);
    }
});

layout.put("/layout/:kind", requirePermission("layout.manage"),
    async (request, response, next) => {
        try {
            if (!KINDS.has(request.params.kind)) {
                return response.status(404).json({ error: "Unknown layout: " + request.params.kind });
            }

            const incoming = request.body ? request.body.layout : undefined;

            /* null / undefined -> reset to the built-in default. */
            if (incoming === null || incoming === undefined) {
                await query(
                    "delete from org_layouts where org_id = $1 and kind = $2",
                    [request.user.org_id, request.params.kind]
                );
                await query(`
                    insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                    values ($1, 'org_layouts', null, $2, 'reset', $3)
                `, [request.user.org_id, request.params.kind, request.user.id]);
                return response.json({ kind: request.params.kind, layout: null });
            }

            if (typeof incoming !== "object" || Array.isArray(incoming)) {
                return response.status(422).json({ error: "layout must be an object" });
            }

            const saved = await query(`
                insert into org_layouts (org_id, kind, layout, updated_by, updated_at)
                values ($1, $2, $3, $4, now())
                on conflict (org_id, kind) do update
                   set layout = excluded.layout,
                       updated_by = excluded.updated_by,
                       updated_at = now()
                returning layout, updated_at
            `, [request.user.org_id, request.params.kind, incoming, request.user.id]);

            await query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'org_layouts', null, $2, 'updated', $3)
            `, [request.user.org_id, request.params.kind, request.user.id]);

            response.json({
                kind: request.params.kind,
                layout: saved.rows[0].layout,
                updated_at: saved.rows[0].updated_at
            });
        } catch (error) {
            next(error);
        }
    });
