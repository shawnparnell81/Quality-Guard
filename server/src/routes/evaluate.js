/* ============================================================
   Management review, quality objectives, vendor onboarding.

   The objectives endpoint is the interesting one: wherever an actual
   can be computed from the records themselves it is, so the number
   on the scorecard cannot drift from the register behind it. Only
   the ones nothing measures yet fall back to a stored figure, and
   those say so.
   ============================================================ */

import { Router } from "express";
import PDFDocument from "pdfkit";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { INK, INK_2, drawLetterhead, drawFooter } from "../pdf-branding.js";

export const evaluate = Router();

/* ============================================================
   Quality objectives, clause 6.2
   ============================================================ */

const COMPUTED = {
    /* Share of closed CAPAs that closed inside thirty days. */
    capa_on_time: `
        select coalesce(round(
                 100.0 * count(*) filter (
                   where r.closed_at <= r.opened_at + interval '30 days')
                 / nullif(count(*), 0), 1), 0) as value
          from records r join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and rt.key = 'capa' and r.closed_at is not null`,

    calibration_on_time: `
        select coalesce(round(
                 100.0 * count(*) filter (where next_due >= current_date)
                 / nullif(count(*), 0), 1), 0) as value
          from gages where org_id = $1`,

    supplier_ppm: `
        select coalesce(round(avg(ppm)), 0) as value
          from vendors where org_id = $1 and ppm is not null`,

    /* Share of required trainings actually held at the current
       revision. The same join the gaps endpoint uses, inverted. */
    training_compliance: `
        select coalesce(round(
                 100.0 * count(*) filter (
                   where tr.id is not null
                     and tr.revision_trained = d.current_revision)
                 / nullif(count(*), 0), 1), 0) as value
          from users u
          join document_requirements req
            on req.role = u.role and req.org_id = u.org_id
          join documents d on d.id = req.document_id
     left join training_records tr
            on tr.user_id = u.id and tr.document_id = d.id
         where u.org_id = $1 and u.active`,

    /* "On time" mirrors the overdue definition every other module
       uses (closed_at is null and due_at has passed), not the
       manually-set 'overdue' status - so this can never disagree
       with the dashboard or the readiness screen's own count. */
    audits_on_time: `
        select coalesce(round(
                 100.0 * count(*) filter (
                   where not (r.closed_at is null and r.due_at < now()))
                 / nullif(count(*), 0), 1), 0) as value
          from records r join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and rt.key = 'audit'`,

    /* Average days a CAPA actually stays open, not just whether it beat
       a threshold - capa_on_time above answers "did it beat 30 days,"
       this answers "how long does one really take." */
    capa_avg_days_to_close: `
        select coalesce(round(
                 avg(extract(epoch from (r.closed_at - r.opened_at)) / 86400.0)
               , 1), 0) as value
          from records r join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and rt.key = 'capa' and r.closed_at is not null`,

    /* First-pass yield: production that never generated an NCR,
       against total quantity actually run. An NCR only counts toward
       this if its work_order field matches a real work order in this
       org - a form that doesn't collect that field (every org's NCR
       form is its own, per the configurable layer) simply cannot
       contribute a number here, the same way an out-of-range risk
       score is skipped by the risk matrix rather than misrepresented. */
    first_pass_yield: `
        with produced as (
            select coalesce(sum(qty), 0) as total_qty
              from work_orders where org_id = $1
        ),
        nonconforming as (
            select coalesce(sum((r.data->>'qty_affected')::numeric), 0) as total_affected
              from records r
              join record_types rt on rt.id = r.record_type_id
              join work_orders wo on wo.org_id = r.org_id and wo.wo_number = r.data->>'work_order'
             where r.org_id = $1 and rt.key = 'ncr'
        )
        select coalesce(round(
                 100.0 * greatest(produced.total_qty - nonconforming.total_affected, 0)
                 / nullif(produced.total_qty, 0)
               , 1), 0) as value
          from produced, nonconforming`
};

/* Shared by the JSON endpoint and the PDF export, so the two can
   never disagree about what a scorecard actually says. */
async function getObjectives(orgId) {
    const defined = await query(`
        select o.name, o.clause, o.target_value, o.unit, o.direction,
               o.source, o.stored_actual, o.period, u.full_name as owner
          from quality_objectives o
     left join users u on u.id = o.owner_id
         where o.org_id = $1
         order by o.position
    `, [orgId]);

    /* Compute every actual the system can measure for itself. */
    const computed = {};
    await Promise.all(Object.entries(COMPUTED).map(async ([key, sql]) => {
        const result = await query(sql, [orgId]);
        computed[key] = Number(result.rows[0].value);
    }));

    return defined.rows.map((objective) => {
        const live = objective.source && computed[objective.source] !== undefined;
        const actual = live
            ? computed[objective.source]
            : (objective.stored_actual === null ? null : Number(objective.stored_actual));

        const target = Number(objective.target_value);
        const onTarget = actual === null
            ? null
            : (objective.direction === "min" ? actual >= target : actual <= target);

        return {
            name: objective.name,
            clause: objective.clause,
            target,
            actual,
            unit: objective.unit,
            direction: objective.direction,
            owner: objective.owner,
            period: objective.period,
            on_target: onTarget,
            /* Says plainly whether the number is measured or typed. */
            measurement: live ? "computed" : "entered"
        };
    });
}

evaluate.get("/objectives", async (request, response, next) => {
    try {
        const objectives = await getObjectives(request.user.org_id);

        response.json({
            count: objectives.length,
            on_target: objectives.filter((o) => o.on_target === true).length,
            objectives
        });
    } catch (error) {
        next(error);
    }
});

/* GET /api/objectives/pdf
   A management-ready one-pager: every objective, its target against
   its actual, and whether it is on target - the thing an ISO 9001
   management review (clause 9.3) actually wants handed to it. Saved
   wherever the browser puts downloads, not to cloud storage - this
   project runs with zero cloud dependencies by design, and a PDF on
   disk is not the kind of thing that needs a compliance-grade WORM
   bucket to be useful. */
evaluate.get("/objectives/pdf", async (request, response, next) => {
    try {
        const [objectives, orgRow] = await Promise.all([
            getObjectives(request.user.org_id),
            query("select name from organizations where id = $1", [request.user.org_id])
        ]);

        const orgName = orgRow.rows[0]?.name || "Organization";

        const doc = new PDFDocument({ size: "LETTER", margin: 44 });
        response.setHeader("Content-Type", "application/pdf");
        response.setHeader("Content-Disposition", "attachment; filename=\"quality-scorecard.pdf\"");
        doc.pipe(response);

        drawLetterhead(doc, orgName, orgName + " - Quality Scorecard");

        doc.fontSize(17).fillColor(INK).font("Helvetica-Bold").text("Quality Objectives, clause 6.2");
        doc.fontSize(9.5).fillColor(INK_2).font("Helvetica")
            .text("Generated " + new Date().toLocaleDateString() + "  -  "
                + objectives.filter((o) => o.on_target === true).length + " of "
                + objectives.length + " on target");
        doc.moveDown(1);

        for (const objective of objectives) {
            const statusLabel = objective.on_target === null ? "NO DATA"
                : objective.on_target ? "ON TARGET" : "OFF TARGET";
            const statusColor = objective.on_target === null ? INK_2
                : objective.on_target ? "#1C6E47" : "#99241A";

            const rowTop = doc.y;
            doc.fontSize(11.5).fillColor(INK).font("Helvetica-Bold")
                .text(objective.name, doc.page.margins.left, rowTop, { continued: false });

            doc.fontSize(8.5).fillColor(statusColor).font("Helvetica-Bold")
                .text(statusLabel, doc.page.width - doc.page.margins.right - 90, rowTop, { width: 90, align: "right" });

            doc.fontSize(9).fillColor(INK_2).font("Helvetica").text(
                "Clause " + (objective.clause || "-")
                + "    Target: " + (objective.direction === "min" ? "at least " : "at most ") + objective.target + " " + objective.unit
                + "    Actual: " + (objective.actual === null ? "not yet measured" : objective.actual + " " + objective.unit)
                + (objective.owner ? "    Owner: " + objective.owner : "")
            );
            doc.fontSize(7.5).fillColor(INK_2).font("Helvetica-Oblique")
                .text(objective.measurement === "computed" ? "Computed live from the records behind it" : "Entered figure");

            doc.moveDown(0.9);
            doc.moveTo(doc.page.margins.left, doc.y)
                .lineTo(doc.page.width - doc.page.margins.right, doc.y)
                .lineWidth(0.5).stroke("#D8E1DF");
            doc.moveDown(0.7);
        }

        drawFooter(doc, orgName);
        doc.end();
    } catch (error) {
        next(error);
    }
});

/* ============================================================
   Management review, clause 9.3
   ============================================================ */

evaluate.get("/reviews", async (request, response, next) => {
    try {
        const result = await query(`
            select m.reference, m.period, m.held_on, m.status,
                   u.full_name as chair,
                   (select count(*)::int from management_review_actions a
                     where a.review_id = m.id) as actions,
                   (select count(*)::int from management_review_actions a
                     where a.review_id = m.id and a.status in ('open','in_progress')) as actions_open
              from management_reviews m
         left join users u on u.id = m.chair_id
             where m.org_id = $1
             order by m.reference desc
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, reviews: result.rows });
    } catch (error) {
        next(error);
    }
});

/* The twelve inputs clause 9.3.2 names, assembled from the modules
   that already hold them. Nothing here is typed in by hand, which is
   the point: a management review pack that has to be compiled
   manually is a management review pack that goes stale. */
evaluate.get("/reviews/:reference/inputs", async (request, response, next) => {
    try {
        const found = await query(
            "select id, reference, period, status from management_reviews where org_id = $1 and reference = $2",
            [request.user.org_id, request.params.reference]
        );

        if (found.rowCount === 0) {
            return response.status(404).json({ error: "No such review" });
        }

        const [events, gages, training, vendors, risks, objectives, priorActions] =
            await Promise.all([
                query(`
                    select rt.key,
                           count(*) filter (where r.closed_at is null)::int as open,
                           count(*) filter (where r.closed_at is null and r.due_at < now())::int as overdue
                      from record_types rt
                 left join records r on r.record_type_id = rt.id
                     where rt.org_id = $1 group by rt.key
                `, [request.user.org_id]),

                query(`select count(*) filter (where next_due < current_date)::int as past_due
                         from gages where org_id = $1`, [request.user.org_id]),

                query(`select count(*)::int as gaps
                         from users u
                         join document_requirements req
                           on req.role = u.role and req.org_id = u.org_id
                         join documents d on d.id = req.document_id
                    left join training_records tr
                           on tr.user_id = u.id and tr.document_id = d.id
                        where u.org_id = $1 and u.active
                          and (tr.id is null or tr.revision_trained is distinct from d.current_revision)`,
                      [request.user.org_id]),

                query(`select count(*) filter (where grade = 'D')::int as grade_d,
                              count(*) filter (where status = 'scar_open')::int as scar_open
                         from vendors where org_id = $1`, [request.user.org_id]),

                query(`select count(*) filter (where r.status = 'unmitigated')::int as unmitigated
                         from records r join record_types rt on rt.id = r.record_type_id
                        where r.org_id = $1 and rt.key = 'risk'`, [request.user.org_id]),

                query(`select count(*)::int as total from quality_objectives where org_id = $1`,
                      [request.user.org_id]),

                /* Both tables carry a status column, so this one has to
                   be qualified or Postgres cannot tell which is meant. */
                query(`select count(*)::int as total,
                              count(*) filter (where a.status = 'done')::int as done
                         from management_review_actions a
                         join management_reviews m on m.id = a.review_id
                        where m.org_id = $1 and m.reference <> $2`,
                      [request.user.org_id, request.params.reference])
            ]);

        const byType = {};
        for (const row of events.rows) byType[row.key] = row;
        const count = (key, field) => byType[key] ? byType[key][field] : 0;

        const inputs = [
            { clause: "9.3.2 a", input: "Status of actions from previous reviews", module: "Management Review",
              summary: priorActions.rows[0].done + " of " + priorActions.rows[0].total + " closed" },
            { clause: "9.3.2 b", input: "Changes in external and internal issues", module: "Risk Register",
              summary: risks.rows[0].unmitigated + " risks unmitigated" },
            { clause: "9.3.2 c1", input: "Customer satisfaction", module: "Customer Complaints",
              summary: count("complaint", "open") + " complaints open" },
            { clause: "9.3.2 c2", input: "Quality objectives performance", module: "Scorecards",
              summary: objectives.rows[0].total + " objectives tracked" },
            { clause: "9.3.2 c3", input: "Process performance and product conformity", module: "Nonconformance",
              summary: count("ncr", "open") + " NCRs open" },
            { clause: "9.3.2 c4", input: "Nonconformities and corrective actions", module: "CAPA",
              summary: count("capa", "open") + " open, " + count("capa", "overdue") + " overdue" },
            { clause: "9.3.2 c5", input: "Monitoring and measurement results", module: "Calibration",
              summary: gages.rows[0].past_due + " gages past due" },
            { clause: "9.3.2 c6", input: "Audit results", module: "Internal Audit",
              summary: count("audit", "overdue") + " audits overdue" },
            { clause: "9.3.2 c7", input: "Performance of external providers", module: "Approved Vendor List",
              summary: vendors.rows[0].grade_d + " grade D, " + vendors.rows[0].scar_open + " SCAR open" },
            { clause: "9.3.2 d", input: "Adequacy of resources", module: "Training",
              summary: training.rows[0].gaps + " competency gaps" },
            { clause: "9.3.2 e", input: "Effectiveness of actions on risk", module: "Risk Register",
              summary: risks.rows[0].unmitigated + " still unmitigated" },
            { clause: "9.3.2 f", input: "Opportunities for improvement", module: "Internal Audit",
              summary: count("capa", "open") + " improvement actions live" }
        ];

        const actions = await query(`
            select a.decision, a.due_on, a.status, u.full_name as owner
              from management_review_actions a
         left join users u on u.id = a.owner_id
             where a.review_id = $1 order by a.position
        `, [found.rows[0].id]);

        response.json({
            review: found.rows[0],
            inputs,
            actions: actions.rows
        });
    } catch (error) {
        next(error);
    }
});

/* ============================================================
   Vendor onboarding, clause 8.4.1
   ============================================================ */

evaluate.get("/onboarding", requirePermission("vendor.read"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select v.name as vendor, v.scope, v.status as vendor_status,
                       count(s.id)::int as stages,
                       count(s.id) filter (where s.status = 'complete')::int as complete
                  from vendors v
                  join vendor_onboarding_stages s on s.vendor_id = v.id
                 where v.org_id = $1
                 group by v.id, v.name, v.scope, v.status
                 order by v.name
            `, [request.user.org_id]);

            response.json({ count: result.rowCount, candidates: result.rows });
        } catch (error) {
            next(error);
        }
    });

evaluate.get("/onboarding/:vendor", requirePermission("vendor.read"),
    async (request, response, next) => {
        try {
            const result = await query(`
                select s.stage_key, s.name, s.detail, s.status,
                       s.completed_at, u.full_name as completed_by, s.position
                  from vendor_onboarding_stages s
                  join vendors v on v.id = s.vendor_id
             left join users u   on u.id = s.completed_by
                 where v.org_id = $1 and v.name = $2
                 order by s.position
            `, [request.user.org_id, request.params.vendor]);

            if (result.rowCount === 0) {
                return response.status(404).json({ error: "No onboarding for that vendor" });
            }

            response.json({
                vendor: request.params.vendor,
                stages: result.rows,
                can_advance: request.can("vendor.approve")
            });
        } catch (error) {
            next(error);
        }
    });

/* Completing a stage. The last one puts the vendor on the approved
   list, which is the only way onto it. */
evaluate.post("/onboarding/:vendor/stages/:stageKey/complete",
    requirePermission("vendor.approve"),
    async (request, response, next) => {
        try {
            const result = await withTransaction(async (client) => {
                const found = await client.query(`
                    select s.id, s.status, s.stage_key, v.id as vendor_id
                      from vendor_onboarding_stages s
                      join vendors v on v.id = s.vendor_id
                     where v.org_id = $1 and v.name = $2 and s.stage_key = $3
                       for update of s
                `, [request.user.org_id, request.params.vendor, request.params.stageKey]);

                if (found.rowCount === 0) return null;
                const stage = found.rows[0];

                if (stage.status === "complete") {
                    return { conflict: "That stage is already complete" };
                }

                /* Stages run in order. Skipping the audit to get to the
                   approval is exactly what clause 8.4.1 is guarding
                   against. */
                const earlier = await client.query(`
                    select name from vendor_onboarding_stages
                     where vendor_id = $1 and status <> 'complete'
                       and position < (select position from vendor_onboarding_stages where id = $2)
                     order by position limit 1
                `, [stage.vendor_id, stage.id]);

                if (earlier.rowCount > 0) {
                    return { conflict: "Complete " + earlier.rows[0].name + " first" };
                }

                await client.query(`
                    update vendor_onboarding_stages
                       set status = 'complete', completed_by = $2, completed_at = now()
                     where id = $1
                `, [stage.id, request.user.id]);

                const remaining = await client.query(`
                    select count(*)::int as n from vendor_onboarding_stages
                     where vendor_id = $1 and status <> 'complete'
                `, [stage.vendor_id]);

                let approved = false;
                if (remaining.rows[0].n === 0) {
                    await client.query(
                        "update vendors set status = 'approved' where id = $1",
                        [stage.vendor_id]
                    );
                    approved = true;
                }

                await client.query(`
                    insert into audit_log
                        (org_id, entity, entity_id, field, old_value, new_value, reason, changed_by)
                    values ($1, 'vendor_onboarding', $2, $3, $4, 'complete', $5, $6)
                `, [request.user.org_id, stage.vendor_id, stage.stage_key, stage.status,
                    request.body?.reason || null, request.user.id]);

                return { stage: stage.stage_key, approved };
            });

            if (!result) return response.status(404).json({ error: "No such vendor or stage" });
            if (result.conflict) return response.status(409).json({ error: result.conflict });

            response.json(result);
        } catch (error) {
            next(error);
        }
    });
