/* ============================================================
   Metric cards (GET /api/metrics)

   Three headline numbers for the dashboard's at-a-glance strip.
   Every one is counted live from the register it summarises - the
   same rule as the dashboard, nothing tracked twice.

   This is a cross-cutting endpoint, not a feature: it has no natural
   /api/<feature> home (it spans NCRs, CAPAs and documents), so per
   docs/api-conventions.md it mounts at bare /api and the path is a
   plain /api/metrics. It used to be a second export from
   dashboard.js; it is its own router now so that intent is visible.

   "overdue document reviews" = a released document whose current
   revision took effect more than 12 months ago. Annual review is the
   ISO 9001 default; change the interval below if the org's control
   procedure says otherwise.
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";

export const metrics = Router();

metrics.get("/metrics", async (request, response, next) => {
    try {
        const result = await query(`
            select
              (select count(*)
                 from records rc
                 join record_types rt on rt.id = rc.record_type_id
                where rc.org_id = $1 and rt.key = 'ncr' and rc.closed_at is null
              ) as open_ncs,
              (select count(*)
                 from records rc
                 join record_types rt on rt.id = rc.record_type_id
                where rc.org_id = $1 and rt.key = 'capa' and rc.closed_at is null
              ) as pending_capas,
              (select count(*)
                 from documents d
                where d.org_id = $1
                  and d.status = 'released'
                  and exists (
                    select 1 from document_revisions dr
                     where dr.document_id = d.id
                       and dr.revision = d.current_revision
                       and dr.effective_date is not null
                       and dr.effective_date < current_date - interval '12 months'
                  )
              ) as overdue_doc_reviews
        `, [request.user.org_id]);

        const row = result.rows[0];
        response.json({
            generated_at: new Date().toISOString(),
            open_ncs: Number(row.open_ncs),
            pending_capas: Number(row.pending_capas),
            overdue_doc_reviews: Number(row.overdue_doc_reviews)
        });
    } catch (error) {
        next(error);
    }
});
