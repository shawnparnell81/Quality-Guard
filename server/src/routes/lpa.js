/* ============================================================
   Layered Process Audit, IATF 16949 clause 9.2.2.

   Templates hold a question bank. Schedules pair a template with a
   layer, an area and a frequency; each carries next_due. Rolling a
   schedule forward - a schedule past due with no open instance gets
   one and its next_due moves on, and an open instance past its due
   date is marked missed - is a write, so it no longer rides GET
   /api/lpa (audit fix C3: a state-changing GET is a CSRF hole and
   breaks "GET is safe" for caches and crawlers). It runs instead on
   a self-arming timer (startLpaRollSchedule) and from an explicit
   POST /api/lpa/roll the screen calls when it opens. An auditor
   answers pass / fail / n-a per question; a fail can carry the
   number of an NCR raised for it.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import { requirePermission } from "../auth.js";
import { runOnce, JOB_LOCKS } from "../job-lock.js";

export const lpa = Router();

async function userIdFor(orgId, initials) {
    if (!initials) return null;
    const found = await query(
        "select id from users where org_id = $1 and initials = $2", [orgId, initials]);
    return found.rows[0]?.id || null;
}

/* Materialise due instances and mark misses. Runs inside the caller's
   transaction. */
async function rollForward(client, orgId) {
    const due = await client.query(`
        select id, template_id, layer, area, auditor_id, frequency_days, next_due
          from lpa_schedules
         where org_id = $1 and active and next_due <= current_date
         for update
    `, [orgId]);

    for (const s of due.rows) {
        const exists = await client.query(
            "select 1 from lpa_audits where schedule_id = $1 and due_on = $2", [s.id, s.next_due]);
        if (exists.rowCount === 0) {
            await client.query(`
                insert into lpa_audits
                    (org_id, schedule_id, template_id, layer, area, auditor_id, due_on, status)
                values ($1, $2, $3, $4, $5, $6, $7, 'scheduled')
            `, [orgId, s.id, s.template_id, s.layer, s.area, s.auditor_id, s.next_due]);
        }
        /* Fast-forward next_due to the first date still in the future -
           one instance per roll, never a backlog. */
        await client.query(`
            update lpa_schedules
               set next_due = next_due
                   + ((floor((current_date - next_due)::numeric / frequency_days) + 1) * frequency_days)::int
             where id = $1
        `, [s.id]);
    }

    await client.query(`
        update lpa_audits set status = 'missed'
         where org_id = $1 and status in ('scheduled', 'in_progress') and due_on < current_date
    `, [orgId]);
}

/* Roll every org that has something to roll - a due schedule or an
   overdue open audit. Used by the timer and reusable in tests. */
export async function rollForwardAll() {
    const orgs = await query(`
        select distinct org_id from (
            select org_id from lpa_schedules
             where active and next_due <= current_date
            union
            select org_id from lpa_audits
             where status in ('scheduled', 'in_progress') and due_on < current_date
        ) t
    `);
    for (const row of orgs.rows) {
        await withTransaction((client) => rollForward(client, row.org_id));
    }
    return orgs.rowCount;
}

/* Self-arming hourly roll. Schedules turn over on date boundaries, so
   hourly is plenty; the explicit POST /api/lpa/roll keeps a freshly
   opened screen current between ticks. The run is behind an advisory
   lock (audit H8) so only one instance rolls per tick. */
let rollTimer = null;

export function startLpaRollSchedule() {
    const tick = async () => {
        try {
            await runOnce(JOB_LOCKS.lpaRoll, () => rollForwardAll());
        } catch (error) {
            console.error("[lpa] roll failed: " + error.message);
        }
        rollTimer = setTimeout(tick, 60 * 60 * 1000);
        if (typeof rollTimer.unref === "function") rollTimer.unref();
    };
    tick();
}

async function recomputeScore(client, auditId) {
    const totals = await client.query(`
        select count(*) filter (where result = 'pass')                as pass,
               count(*) filter (where result in ('pass', 'fail'))     as total
          from lpa_answers where audit_id = $1
    `, [auditId]);
    await client.query(
        "update lpa_audits set score_pass = $2, score_total = $3 where id = $1",
        [auditId, Number(totals.rows[0].pass), Number(totals.rows[0].total)]
    );
}

/* ---------- roll schedules forward ---------- *
   Idempotent and org-scoped. The screen POSTs this on open; the
   timer runs it hourly for everyone. A write, so it is a POST, not
   a side effect of the GET below. */
lpa.post("/lpa/roll", requirePermission("lpa.read"), async (request, response, next) => {
    try {
        await withTransaction((client) => rollForward(client, request.user.org_id));
        response.json({ rolled: true });
    } catch (error) {
        next(error);
    }
});

/* ---------- the screen's one fetch ---------- *
   Read-only: no roll-forward here. */

lpa.get("/lpa", requirePermission("lpa.read"), async (request, response, next) => {
    try {
        const orgId = request.user.org_id;

        const data = await withTransaction(async (client) => {
            const [templates, schedules, audits, stats] = await Promise.all([
                client.query(`
                    select t.id, t.name, t.description, t.active,
                           (select count(*)::int from lpa_questions q where q.template_id = t.id) as questions
                      from lpa_templates t
                     where t.org_id = $1
                     order by t.active desc, t.name
                `, [orgId]),

                client.query(`
                    select s.id, s.layer, s.area, s.frequency_days, s.next_due, s.active,
                           t.name as template, s.template_id,
                           u.full_name as auditor, u.initials as auditor_initials,
                           (select performed_on from lpa_audits a
                             where a.schedule_id = s.id and a.status = 'complete'
                             order by a.performed_on desc limit 1) as last_done
                      from lpa_schedules s
                      join lpa_templates t on t.id = s.template_id
                 left join users u on u.id = s.auditor_id
                     where s.org_id = $1
                     order by s.active desc, s.next_due
                `, [orgId]),

                client.query(`
                    select a.id, a.layer, a.area, a.due_on, a.performed_on, a.status,
                           a.score_pass, a.score_total, a.template_id,
                           t.name as template, u.full_name as auditor
                      from lpa_audits a
                      join lpa_templates t on t.id = a.template_id
                 left join users u on u.id = a.auditor_id
                     where a.org_id = $1
                       and (a.status in ('scheduled', 'in_progress')
                            or a.created_at > now() - interval '30 days')
                     order by
                        case a.status when 'scheduled' then 0 when 'in_progress' then 1
                                      when 'missed' then 2 else 3 end,
                        a.due_on
                `, [orgId]),

                client.query(`
                    select
                      count(*) filter (where status in ('scheduled', 'in_progress'))          as open,
                      count(*) filter (where status = 'missed'
                                         and created_at > now() - interval '30 days')          as missed_30d,
                      count(*) filter (where status = 'complete'
                                         and performed_on > current_date - 30)                 as done_30d,
                      coalesce(sum(score_pass) filter (where status = 'complete'
                                         and performed_on > current_date - 30), 0)             as pass_30d,
                      coalesce(sum(score_total) filter (where status = 'complete'
                                         and performed_on > current_date - 30), 0)             as total_30d
                      from lpa_audits where org_id = $1
                `, [orgId])
            ]);

            const st = stats.rows[0];
            return {
                templates: templates.rows,
                schedules: schedules.rows,
                audits: audits.rows,
                stats: {
                    open: Number(st.open),
                    missed_30d: Number(st.missed_30d),
                    completed_30d: Number(st.done_30d),
                    pass_rate_30d: Number(st.total_30d) > 0
                        ? Math.round((Number(st.pass_30d) / Number(st.total_30d)) * 100)
                        : null
                }
            };
        });

        response.json(data);
    } catch (error) {
        next(error);
    }
});

/* ---------- templates ---------- */

lpa.get("/lpa/templates/:id", requirePermission("lpa.read"), async (request, response, next) => {
    try {
        const template = await query(
            "select id, name, description, active from lpa_templates where org_id = $1 and id = $2",
            [request.user.org_id, request.params.id]);
        if (template.rowCount === 0) return response.status(404).json({ error: "No such template" });

        const questions = await query(
            "select id, position, text, guidance, critical from lpa_questions where template_id = $1 order by position, text",
            [request.params.id]);

        response.json({ ...template.rows[0], questions: questions.rows });
    } catch (error) {
        next(error);
    }
});

lpa.post("/lpa/templates", requirePermission("lpa.manage"), async (request, response, next) => {
    try {
        const { name, description } = request.body || {};
        if (!name || !String(name).trim()) {
            return response.status(400).json({ error: "name is required" });
        }
        const created = await query(`
            insert into lpa_templates (org_id, name, description, created_by)
            values ($1, $2, $3, $4) returning id, name, description, active
        `, [request.user.org_id, String(name).trim(), (description || "").trim() || null, request.user.id]);
        response.status(201).json(created.rows[0]);
    } catch (error) {
        next(error);
    }
});

lpa.put("/lpa/templates/:id", requirePermission("lpa.manage"), async (request, response, next) => {
    try {
        const { name, description, active } = request.body || {};
        const updated = await query(`
            update lpa_templates set
                name = coalesce($3, name),
                description = case when $4::boolean then $5::text else description end,
                active = coalesce($6, active)
             where org_id = $1 and id = $2
            returning id, name, description, active
        `, [request.user.org_id, request.params.id,
            name ? String(name).trim() : null,
            Object.prototype.hasOwnProperty.call(request.body || {}, "description"),
            description ?? null,
            typeof active === "boolean" ? active : null]);
        if (updated.rowCount === 0) return response.status(404).json({ error: "No such template" });
        response.json(updated.rows[0]);
    } catch (error) {
        next(error);
    }
});

lpa.post("/lpa/templates/:id/questions", requirePermission("lpa.manage"),
    async (request, response, next) => {
        try {
            const owner = await query(
                "select 1 from lpa_templates where org_id = $1 and id = $2",
                [request.user.org_id, request.params.id]);
            if (owner.rowCount === 0) return response.status(404).json({ error: "No such template" });

            const { text, guidance, critical } = request.body || {};
            if (!text || !String(text).trim()) {
                return response.status(400).json({ error: "text is required" });
            }
            const pos = await query(
                "select coalesce(max(position), 0) + 1 as n from lpa_questions where template_id = $1",
                [request.params.id]);
            const created = await query(`
                insert into lpa_questions (template_id, position, text, guidance, critical)
                values ($1, $2, $3, $4, $5)
                returning id, position, text, guidance, critical
            `, [request.params.id, pos.rows[0].n, String(text).trim(),
                (guidance || "").trim() || null, critical === true]);
            response.status(201).json(created.rows[0]);
        } catch (error) {
            next(error);
        }
    });

lpa.delete("/lpa/templates/:id/questions/:questionId", requirePermission("lpa.manage"),
    async (request, response, next) => {
        try {
            const done = await query(`
                delete from lpa_questions q using lpa_templates t
                 where q.template_id = t.id and t.org_id = $1
                   and t.id = $2 and q.id = $3
            `, [request.user.org_id, request.params.id, request.params.questionId]);
            if (done.rowCount === 0) return response.status(404).json({ error: "No such question" });
            response.json({ deleted: true });
        } catch (error) {
            next(error);
        }
    });

/* ---------- schedules ---------- */

lpa.post("/lpa/schedules", requirePermission("lpa.manage"), async (request, response, next) => {
    try {
        const { template_id, layer, area, auditor, frequency_days, start_on } = request.body || {};
        if (!template_id || !layer || !area || !frequency_days) {
            return response.status(400).json({ error: "template_id, layer, area and frequency_days are required" });
        }
        const owner = await query(
            "select 1 from lpa_templates where org_id = $1 and id = $2",
            [request.user.org_id, template_id]);
        if (owner.rowCount === 0) return response.status(404).json({ error: "No such template" });

        const freq = Number(frequency_days);
        if (!Number.isInteger(freq) || freq < 1 || freq > 365) {
            return response.status(400).json({ error: "frequency_days must be 1-365" });
        }

        const created = await query(`
            insert into lpa_schedules
                (org_id, template_id, layer, area, auditor_id, frequency_days, next_due, created_by)
            values ($1, $2, $3, $4, $5, $6, coalesce($7::date, current_date), $8)
            returning id, layer, area, frequency_days, next_due, active
        `, [request.user.org_id, template_id, String(layer).trim(), String(area).trim(),
            await userIdFor(request.user.org_id, auditor), freq, start_on || null, request.user.id]);
        response.status(201).json(created.rows[0]);
    } catch (error) {
        next(error);
    }
});

lpa.put("/lpa/schedules/:id", requirePermission("lpa.manage"), async (request, response, next) => {
    try {
        const { layer, area, auditor, frequency_days, active } = request.body || {};
        const auditorProvided = Object.prototype.hasOwnProperty.call(request.body || {}, "auditor");
        const updated = await query(`
            update lpa_schedules set
                layer = coalesce($3, layer),
                area = coalesce($4, area),
                frequency_days = coalesce($5, frequency_days),
                auditor_id = case when $6::boolean then $7::uuid else auditor_id end,
                active = coalesce($8, active)
             where org_id = $1 and id = $2
            returning id, layer, area, frequency_days, next_due, active
        `, [request.user.org_id, request.params.id,
            layer ? String(layer).trim() : null,
            area ? String(area).trim() : null,
            frequency_days ? Number(frequency_days) : null,
            auditorProvided, auditorProvided ? await userIdFor(request.user.org_id, auditor) : null,
            typeof active === "boolean" ? active : null]);
        if (updated.rowCount === 0) return response.status(404).json({ error: "No such schedule" });
        response.json(updated.rows[0]);
    } catch (error) {
        next(error);
    }
});

lpa.delete("/lpa/schedules/:id", requirePermission("lpa.manage"), async (request, response, next) => {
    try {
        const done = await query(
            "delete from lpa_schedules where org_id = $1 and id = $2",
            [request.user.org_id, request.params.id]);
        if (done.rowCount === 0) return response.status(404).json({ error: "No such schedule" });
        response.json({ deleted: true });
    } catch (error) {
        next(error);
    }
});

/* ---------- audits ---------- */

/* An off-schedule audit - a spot check, or catching up a layer that
   was skipped. */
lpa.post("/lpa/audits", requirePermission("lpa.audit"), async (request, response, next) => {
    try {
        const { template_id, layer, area, auditor, due_on } = request.body || {};
        if (!template_id || !layer || !area) {
            return response.status(400).json({ error: "template_id, layer and area are required" });
        }
        const owner = await query(
            "select 1 from lpa_templates where org_id = $1 and id = $2",
            [request.user.org_id, template_id]);
        if (owner.rowCount === 0) return response.status(404).json({ error: "No such template" });

        const created = await query(`
            insert into lpa_audits (org_id, template_id, layer, area, auditor_id, due_on, status)
            values ($1, $2, $3, $4, $5, coalesce($6::date, current_date), 'scheduled')
            returning id, layer, area, due_on, status
        `, [request.user.org_id, template_id, String(layer).trim(), String(area).trim(),
            await userIdFor(request.user.org_id, auditor) || request.user.id, due_on || null]);
        response.status(201).json(created.rows[0]);
    } catch (error) {
        next(error);
    }
});

lpa.get("/lpa/audits/:id", requirePermission("lpa.read"), async (request, response, next) => {
    try {
        const audit = await query(`
            select a.id, a.layer, a.area, a.due_on, a.performed_on, a.status,
                   a.score_pass, a.score_total, a.template_id,
                   t.name as template, u.full_name as auditor
              from lpa_audits a
              join lpa_templates t on t.id = a.template_id
         left join users u on u.id = a.auditor_id
             where a.org_id = $1 and a.id = $2
        `, [request.user.org_id, request.params.id]);
        if (audit.rowCount === 0) return response.status(404).json({ error: "No such audit" });

        const rows = await query(`
            select q.id as question_id, q.position, q.text, q.guidance, q.critical,
                   ans.result, ans.note, ans.ncr_number
              from lpa_questions q
         left join lpa_answers ans on ans.question_id = q.id and ans.audit_id = $2
             where q.template_id = $1
             order by q.position, q.text
        `, [audit.rows[0].template_id, request.params.id]);

        response.json({ ...audit.rows[0], questions: rows.rows });
    } catch (error) {
        next(error);
    }
});

/* PUT /api/lpa/audits/<id>/answers/<questionId>
   { result: 'pass'|'fail'|'na', note?, ncr_number? } */
lpa.put("/lpa/audits/:id/answers/:questionId", requirePermission("lpa.audit"),
    async (request, response, next) => {
        try {
            const { result, note, ncr_number } = request.body || {};
            if (!["pass", "fail", "na"].includes(result)) {
                return response.status(400).json({ error: "result must be pass, fail or na" });
            }

            const outcome = await withTransaction(async (client) => {
                const audit = await client.query(
                    "select id, status, template_id from lpa_audits where org_id = $1 and id = $2 for update",
                    [request.user.org_id, request.params.id]);
                if (audit.rowCount === 0) return { code: 404 };
                if (audit.rows[0].status === "complete" || audit.rows[0].status === "missed") {
                    return { code: 409, body: { error: "This audit is closed" } };
                }

                const belongs = await client.query(
                    "select 1 from lpa_questions where id = $1 and template_id = $2",
                    [request.params.questionId, audit.rows[0].template_id]);
                if (belongs.rowCount === 0) return { code: 404, body: { error: "That question is not on this audit" } };

                await client.query(`
                    insert into lpa_answers (audit_id, question_id, result, note, ncr_number, answered_by)
                    values ($1, $2, $3, $4, $5, $6)
                    on conflict (audit_id, question_id) do update set
                        result = excluded.result,
                        note = excluded.note,
                        ncr_number = coalesce(excluded.ncr_number, lpa_answers.ncr_number),
                        answered_by = excluded.answered_by,
                        answered_at = now()
                `, [request.params.id, request.params.questionId, result,
                    (note || "").trim() || null, ncr_number ? String(ncr_number).trim() : null,
                    request.user.id]);

                if (audit.rows[0].status === "scheduled") {
                    await client.query("update lpa_audits set status = 'in_progress' where id = $1",
                        [request.params.id]);
                }
                await recomputeScore(client, request.params.id);
                return { code: 200 };
            });

            if (outcome.code === 404) return response.status(404).json(outcome.body || { error: "No such audit" });
            if (outcome.code === 409) return response.status(409).json(outcome.body);
            response.json({ saved: true });
        } catch (error) {
            next(error);
        }
    });

lpa.post("/lpa/audits/:id/complete", requirePermission("lpa.audit"), async (request, response, next) => {
    try {
        const outcome = await withTransaction(async (client) => {
            const audit = await client.query(
                "select id, status, template_id from lpa_audits where org_id = $1 and id = $2 for update",
                [request.user.org_id, request.params.id]);
            if (audit.rowCount === 0) return { code: 404 };
            if (audit.rows[0].status === "complete") return { code: 409, body: { error: "Already complete" } };

            const unanswered = await client.query(`
                select count(*)::int as n from lpa_questions q
                 where q.template_id = $1
                   and not exists (select 1 from lpa_answers a
                                    where a.question_id = q.id and a.audit_id = $2)
            `, [audit.rows[0].template_id, request.params.id]);
            if (unanswered.rows[0].n > 0) {
                return { code: 409, body: { error: unanswered.rows[0].n + " question(s) still unanswered" } };
            }

            await recomputeScore(client, request.params.id);
            const done = await client.query(`
                update lpa_audits
                   set status = 'complete',
                       performed_on = coalesce($2::date, current_date)
                 where id = $1
                returning score_pass, score_total, performed_on
            `, [request.params.id, request.body?.performed_on || null]);
            return { code: 200, body: done.rows[0] };
        });

        if (outcome.code === 404) return response.status(404).json({ error: "No such audit" });
        if (outcome.code === 409) return response.status(409).json(outcome.body);
        response.json(outcome.body);
    } catch (error) {
        next(error);
    }
});
