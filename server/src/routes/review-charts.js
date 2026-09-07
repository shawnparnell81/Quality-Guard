/* ============================================================
   Charts for the management review, clause 9.3.

   A review is presented, not just filed. These endpoints let the
   charts that go on the wall in the meeting - a trend line, a Pareto,
   a target-versus-actual bar - be built and edited in the app rather
   than in a spreadsheet that gets exported, attached and redone next
   quarter. A chart belongs to one review; it is one series of
   (label, value) points plus a type and axis captions.

   GET is open to any signed-in user (same as the review itself);
   every write needs review.manage. The seed endpoint hands back a
   ready-to-edit draft computed from the records - it is not saved
   until the client POSTs it.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";

export const reviewCharts = Router();

const TYPES = new Set(["bar", "line", "pareto"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function reviewByRef(orgId, reference) {
    const found = await query(
        "select id, reference, period from management_reviews where org_id = $1 and reference = $2",
        [orgId, reference]
    );
    return found.rowCount > 0 ? found.rows[0] : null;
}

async function chartsFor(reviewId) {
    const charts = await query(`
        select c.id, c.title, c.chart_type, c.x_label, c.y_label, c.position,
               c.updated_at, u.full_name as updated_by
          from review_charts c
     left join users u on u.id = c.updated_by
         where c.review_id = $1
         order by c.position, c.updated_at
    `, [reviewId]);

    if (charts.rowCount === 0) return [];

    const points = await query(`
        select p.chart_id, p.label, p.value, p.position
          from review_chart_points p
          join review_charts c on c.id = p.chart_id
         where c.review_id = $1
         order by p.position, p.label
    `, [reviewId]);

    const byChart = new Map();
    for (const row of points.rows) {
        if (!byChart.has(row.chart_id)) byChart.set(row.chart_id, []);
        byChart.get(row.chart_id).push({ label: row.label, value: Number(row.value) });
    }

    return charts.rows.map((c) => ({
        id: c.id,
        title: c.title,
        chart_type: c.chart_type,
        x_label: c.x_label,
        y_label: c.y_label,
        position: c.position,
        updated_at: c.updated_at,
        updated_by: c.updated_by || null,
        points: byChart.get(c.id) || []
    }));
}

/* Pull a clean { title, chart_type, x_label, y_label, points } out of
   whatever the client sent. Throws a plain Error on anything it will
   not store; the caller turns that into a 400. */
function readChart(body) {
    const title = (body?.title || "").trim();
    if (!title) throw new Error("A chart needs a title");

    const chartType = (body?.chart_type || "").trim();
    if (!TYPES.has(chartType)) throw new Error("chart_type must be bar, line or pareto");

    const rawPoints = Array.isArray(body?.points) ? body.points : [];
    const points = rawPoints
        .map((p) => ({
            label: (p?.label ?? "").toString().trim(),
            value: Number(p?.value)
        }))
        .filter((p) => p.label !== "")
        .map((p) => ({ label: p.label, value: Number.isFinite(p.value) ? p.value : 0 }));

    if (points.length === 0) throw new Error("A chart needs at least one data point with a label");

    return {
        title,
        chart_type: chartType,
        x_label: (body?.x_label || "").trim() || null,
        y_label: (body?.y_label || "").trim() || null,
        points
    };
}

async function writePoints(client, chartId, points) {
    await client.query("delete from review_chart_points where chart_id = $1", [chartId]);
    let position = 0;
    for (const point of points) {
        await client.query(
            "insert into review_chart_points (chart_id, label, value, position) values ($1, $2, $3, $4)",
            [chartId, point.label, point.value, position++]
        );
    }
}

/* ---------- read ---------- */

reviewCharts.get("/reviews/:reference/charts", async (request, response, next) => {
    try {
        const review = await reviewByRef(request.user.org_id, request.params.reference);
        if (!review) return response.status(404).json({ error: "No such review" });
        response.json({ charts: await chartsFor(review.id) });
    } catch (error) {
        next(error);
    }
});

/* ---------- create ---------- */

reviewCharts.post("/reviews/:reference/charts", requirePermission("review.manage"),
    async (request, response, next) => {
    try {
        const review = await reviewByRef(request.user.org_id, request.params.reference);
        if (!review) return response.status(404).json({ error: "No such review" });

        let chart;
        try {
            chart = readChart(request.body);
        } catch (validationError) {
            return response.status(400).json({ error: validationError.message });
        }

        const created = await withTransaction(async (client) => {
            const nextPosition = await client.query(
                "select coalesce(max(position) + 1, 0) as n from review_charts where review_id = $1",
                [review.id]
            );

            const row = await client.query(`
                insert into review_charts
                    (org_id, review_id, title, chart_type, x_label, y_label, position, updated_by, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, now())
                returning id
            `, [request.user.org_id, review.id, chart.title, chart.chart_type,
                chart.x_label, chart.y_label, nextPosition.rows[0].n, request.user.id]);

            await writePoints(client, row.rows[0].id, chart.points);

            await client.query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'review_charts', $2, 'created', $3, $4)
            `, [request.user.org_id, row.rows[0].id, chart.title, request.user.id]);

            return row.rows[0].id;
        });

        response.status(201).json({
            charts: await chartsFor(review.id),
            created
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- replace ---------- */

reviewCharts.put("/reviews/:reference/charts/:id", requirePermission("review.manage"),
    async (request, response, next) => {
    try {
        const review = await reviewByRef(request.user.org_id, request.params.reference);
        if (!review) return response.status(404).json({ error: "No such review" });

        if (!UUID.test(request.params.id)) {
            return response.status(404).json({ error: "No such chart on this review" });
        }

        const owned = await query(
            "select id from review_charts where id = $1 and review_id = $2",
            [request.params.id, review.id]
        );
        if (owned.rowCount === 0) return response.status(404).json({ error: "No such chart on this review" });

        let chart;
        try {
            chart = readChart(request.body);
        } catch (validationError) {
            return response.status(400).json({ error: validationError.message });
        }

        await withTransaction(async (client) => {
            await client.query(`
                update review_charts set
                    title = $2, chart_type = $3, x_label = $4, y_label = $5,
                    updated_by = $6, updated_at = now()
                where id = $1
            `, [request.params.id, chart.title, chart.chart_type,
                chart.x_label, chart.y_label, request.user.id]);

            await writePoints(client, request.params.id, chart.points);

            await client.query(`
                insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
                values ($1, 'review_charts', $2, 'updated', $3, $4)
            `, [request.user.org_id, request.params.id, chart.title, request.user.id]);
        });

        response.json({ charts: await chartsFor(review.id) });
    } catch (error) {
        next(error);
    }
});

/* ---------- delete ---------- */

reviewCharts.delete("/reviews/:reference/charts/:id", requirePermission("review.manage"),
    async (request, response, next) => {
    try {
        const review = await reviewByRef(request.user.org_id, request.params.reference);
        if (!review) return response.status(404).json({ error: "No such review" });

        if (!UUID.test(request.params.id)) {
            return response.status(404).json({ error: "No such chart on this review" });
        }

        const removed = await query(
            "delete from review_charts where id = $1 and review_id = $2 returning title",
            [request.params.id, review.id]
        );
        if (removed.rowCount === 0) return response.status(404).json({ error: "No such chart on this review" });

        await query(`
            insert into audit_log (org_id, entity, entity_id, field, old_value, changed_by)
            values ($1, 'review_charts', $2, 'deleted', $3, $4)
        `, [request.user.org_id, request.params.id, removed.rows[0].title, request.user.id]);

        response.json({ charts: await chartsFor(review.id) });
    } catch (error) {
        next(error);
    }
});

/* ---------- seed drafts ----------
   Each returns a chart the client can drop straight into the editor.
   Nothing is written until that chart is POSTed back. */

const SIX_MONTHS = `
    with months as (
        select date_trunc('month', current_date) - (n || ' month')::interval as m
          from generate_series(5, 0, -1) as n
    )
    select to_char(months.m, 'Mon YYYY') as label,
           count(r.id)::int as value
      from months
 left join records r
        on r.org_id = $1
       and r.record_type_id = (select id from record_types where org_id = $1 and key = $2)
       and date_trunc('month', r.opened_at) = months.m
  group by months.m
  order by months.m
`;

async function seedDraft(orgId, kind) {
    if (kind === "ncr_by_month" || kind === "complaints_by_month") {
        const key = kind === "ncr_by_month" ? "ncr" : "complaint";
        const rows = (await query(SIX_MONTHS, [orgId, key])).rows;
        return {
            title: (key === "ncr" ? "Nonconformances" : "Customer complaints") + " by month",
            chart_type: "line",
            x_label: "Month",
            y_label: "Raised",
            points: rows.map((r) => ({ label: r.label, value: r.value }))
        };
    }

    if (kind === "capa_by_status") {
        const rows = (await query(`
            select r.status as label, count(*)::int as value
              from records r
              join record_types rt on rt.id = r.record_type_id
             where r.org_id = $1 and rt.key = 'capa'
          group by r.status
          order by value desc
        `, [orgId])).rows;
        return {
            title: "CAPA by status",
            chart_type: "bar",
            x_label: "Status",
            y_label: "CAPAs",
            points: rows.map((r) => ({ label: r.label, value: r.value }))
        };
    }

    if (kind === "ncr_by_disposition") {
        const rows = (await query(`
            select coalesce(nullif(r.data->>'disposition', ''), 'unassigned') as label,
                   count(*)::int as value
              from records r
              join record_types rt on rt.id = r.record_type_id
             where r.org_id = $1 and rt.key = 'ncr'
          group by label
          order by value desc
        `, [orgId])).rows;
        return {
            title: "Nonconformances by disposition",
            chart_type: "pareto",
            x_label: "Disposition",
            y_label: "NCRs",
            points: rows.map((r) => ({ label: r.label, value: r.value }))
        };
    }

    if (kind === "objectives_target") {
        const rows = (await query(`
            select name as label, coalesce(target_value, 0)::float as value
              from quality_objectives
             where org_id = $1
          order by position, name
        `, [orgId])).rows;
        return {
            title: "Quality objectives - target",
            chart_type: "bar",
            x_label: "Objective",
            y_label: "Target",
            points: rows.map((r) => ({ label: r.label, value: r.value }))
        };
    }

    return null;
}

reviewCharts.get("/reviews/:reference/charts/seed/:kind", requirePermission("review.manage"),
    async (request, response, next) => {
    try {
        const review = await reviewByRef(request.user.org_id, request.params.reference);
        if (!review) return response.status(404).json({ error: "No such review" });

        const draft = await seedDraft(request.user.org_id, request.params.kind);
        if (!draft) return response.status(404).json({ error: "Unknown seed: " + request.params.kind });

        response.json({ draft });
    } catch (error) {
        next(error);
    }
});
