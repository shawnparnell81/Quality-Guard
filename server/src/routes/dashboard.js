/* ============================================================
   Dashboard and clause coverage.

   Every number the front page shows is computed here from the same
   tables the modules write to. Nothing is stored twice, so a KPI
   cannot disagree with the register it summarises.
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";

export const dashboard = Router();

dashboard.get("/", async (request, response, next) => {
    try {
        const [events, weekly, gages, training, vendors] = await Promise.all([
            query(`
                select rt.key as type,
                       count(*) filter (where r.closed_at is null) as open,
                       count(*) filter (where r.closed_at is null
                                          and r.due_at < now())    as overdue,
                       count(*)                                    as total
                  from records r
                  join record_types rt on rt.id = r.record_type_id
                 where r.org_id = $1
                 group by rt.key
            `, [request.user.org_id]),

            /* Eight weeks, oldest first, zero-filled - generate_series
               first and left join records onto it, rather than
               grouping records directly, so a week nothing happened
               in is a real zero instead of a missing row the client
               would have to notice and fill in itself. */
            query(`
                with weeks as (
                    select generate_series(
                        date_trunc('week', now()) - interval '7 weeks',
                        date_trunc('week', now()),
                        interval '1 week'
                    ) as week_start
                )
                select rt.key as type, w.week_start, count(r.id)::int as n
                  from weeks w
                  cross join record_types rt
             left join records r
                        on r.record_type_id = rt.id
                       and r.org_id = $1
                       and date_trunc('week', r.opened_at) = w.week_start
                 where rt.org_id = $1
                   and rt.key in ('ncr', 'capa', 'complaint', 'audit')
                 group by rt.key, w.week_start
                 order by rt.key, w.week_start
            `, [request.user.org_id]),

            query(`
                select count(*) filter (where next_due < current_date) as past_due,
                       count(*) filter (where next_due < current_date + interval '30 days') as due_soon,
                       count(*) as total
                  from gages where org_id = $1
            `, [request.user.org_id]),

            query(`
                select count(*) as gaps
                  from users u
                  join document_requirements req
                    on req.role = u.role and req.org_id = u.org_id
                  join documents d on d.id = req.document_id
             left join training_records tr
                    on tr.user_id = u.id and tr.document_id = d.id
                 where u.org_id = $1
                   and u.active
                   and (tr.id is null
                        or tr.revision_trained is distinct from d.current_revision)
            `, [request.user.org_id]),

            query(`
                select count(*) filter (where status = 'scar_open') as scar_open,
                       count(*) filter (where grade = 'D')          as grade_d,
                       round(avg(ppm))                              as avg_ppm,
                       count(*)                                     as total
                  from vendors where org_id = $1 and status <> 'onboarding'
            `, [request.user.org_id])
        ]);

        const byType = {};
        for (const row of events.rows) {
            byType[row.type] = {
                open: Number(row.open),
                overdue: Number(row.overdue),
                total: Number(row.total)
            };
        }

        /* Eight numbers per type, oldest to newest - opened-per-week,
           for the sparkline under each KPI tile. Real history from
           opened_at, not a separate metrics table: nothing here is
           tracked twice. */
        const trends = {};
        for (const row of weekly.rows) {
            (trends[row.type] ||= []).push(Number(row.n));
        }

        response.json({
            generated_at: new Date().toISOString(),
            events: byType,
            calibration: {
                past_due: Number(gages.rows[0].past_due),
                due_soon: Number(gages.rows[0].due_soon),
                total: Number(gages.rows[0].total)
            },
            training: { gaps: Number(training.rows[0].gaps) },
            suppliers: {
                scar_open: Number(vendors.rows[0].scar_open),
                grade_d: Number(vendors.rows[0].grade_d),
                avg_ppm: Number(vendors.rows[0].avg_ppm),
                total: Number(vendors.rows[0].total)
            },
            /* Computed the same way every other type's overdue count is
               (closed_at is null and due_at has passed) - not from a
               manually-set 'overdue' status, which used to let this
               figure disagree with clause 9.2's finding on the
               Readiness screen. One definition of overdue, not two. */
            audits: { overdue: byType.audit?.overdue ?? 0 },
            trends
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- open events feed for the dashboard table ---------- */
dashboard.get("/open-events", async (request, response, next) => {
    try {
        const result = await query(`
            select r.number, r.title, r.status, r.severity,
                   r.data->>'part_number' as part_number,
                   r.data->>'lot_number'  as lot_number,
                   (r.data->>'qty_affected')::int as qty,
                   u.full_name as owner,
                   date_part('day', now() - r.opened_at)::int as age_days,
                   rt.key as type
              from records r
              join record_types rt on rt.id = r.record_type_id
         left join users u        on u.id = r.owner_id
             where r.org_id = $1
               and r.closed_at is null
               -- Risks and audits are registers with their own screens and
               -- their own review cadence. This feed is the work queue:
               -- things somebody has to act on now.
               and rt.key in ('ncr', 'capa', 'eightd', 'complaint', 'scar')
             order by case r.severity when 'crit' then 0 when 'warn' then 1 else 2 end,
                      r.opened_at
             limit 25
        `, [request.user.org_id]);

        response.json({ count: result.rowCount, events: result.rows });
    } catch (error) {
        next(error);
    }
});

/* GET /api/dashboard/escalations?days=7
   Every open record with a real owner and a due date landing inside
   the window - overdue ones included, since "already late" is the
   most urgent case a warning exists for, not a separate one. This is
   the computation half of due-date escalation: who would get a
   warning, and about what. It does not send anything - there is no
   email provider wired up yet, so the honest thing is to expose the
   answer to "who needs telling" and stop there, rather than pretend
   to notify anyone. */
dashboard.get("/escalations", async (request, response, next) => {
    try {
        const days = Math.min(Math.max(Number(request.query.days) || 7, 1), 90);

        const result = await query(`
            select r.number, r.title, r.status, r.severity, r.due_at,
                   rt.key as type, rt.name as type_name,
                   u.id as owner_id, u.full_name as owner_name, u.email as owner_email,
                   ceil(extract(epoch from (r.due_at - now())) / 86400.0)::int as days_until_due
              from records r
              join record_types rt on rt.id = r.record_type_id
         left join users u        on u.id = r.owner_id
             where r.org_id = $1
               and r.closed_at is null
               and r.due_at is not null
               and r.due_at <= now() + ($2 || ' days')::interval
             order by r.due_at
        `, [request.user.org_id, days]);

        const escalations = result.rows.map((row) => ({
            ...row,
            overdue: row.days_until_due < 0,
            /* No owner on the record at all is its own kind of finding -
               a warning nobody would actually receive - surfaced rather
               than silently dropped from the list. */
            owner_name: row.owner_name || null,
            owner_email: row.owner_email || null
        }));

        response.json({
            count: escalations.length,
            unowned: escalations.filter((e) => !e.owner_email).length,
            escalations
        });
    } catch (error) {
        next(error);
    }
});

/* ---------- ISO 9001 clause coverage ----------
   The pitch screen, and the one an auditor is walked through.

   The clause list is fixed by the standard so it lives in code. What
   each clause maps to is configuration: `view` is the screen holding
   the evidence, `type` names a record type when the evidence is a
   quality event, and `source` names a master data table when it is
   not. When customers start wanting their own mapping, this array is
   what moves into the database.
*/
const CLAUSE_MAP = [
    { clause: "4.1",   requirement: "Context of the organization",           module: "Management Review",      view: "review" },
    { clause: "4.2",   requirement: "Needs of interested parties",           module: "Management Review",      view: "review" },
    { clause: "4.4",   requirement: "QMS processes and interactions",        module: "Document Control",       view: "documents",   source: "documents" },
    { clause: "5.2",   requirement: "Quality policy",                        module: "Document Control",       view: "documents",   source: "documents" },
    { clause: "5.3",   requirement: "Roles, responsibilities, authorities",  module: "Workflows and Roles",     view: "workflows",   source: "users" },
    { clause: "6.1",   requirement: "Risks and opportunities",               module: "Risk Register",           view: "risk",        type: "risk" },
    { clause: "6.2",   requirement: "Quality objectives",                    module: "Scorecards and KPIs",     view: "scorecards" },
    { clause: "6.3",   requirement: "Planning of changes",                   module: "Change Control",          view: "change",      type: "ecn" },
    { clause: "7.1.5", requirement: "Monitoring and measuring resources",    module: "Calibration",             view: "calibration", source: "gages" },
    { clause: "7.2",   requirement: "Competence",                            module: "Training and Competence", view: "training",    source: "training_records" },
    { clause: "7.3",   requirement: "Awareness",                             module: "Training and Competence", view: "training",    source: "training_records" },
    { clause: "7.5",   requirement: "Documented information",                module: "Document Control",        view: "documents",   source: "documents" },
    { clause: "8.2.1", requirement: "Customer communication",                module: "Customer Complaints",     view: "complaints",  type: "complaint" },
    { clause: "8.3",   requirement: "Design and development",                module: "Engineering Drawings",    view: "drawings",    source: "parts" },
    { clause: "8.4",   requirement: "Externally provided processes",         module: "Approved Vendor List",    view: "avl",         source: "vendors" },
    { clause: "8.5.1", requirement: "Control of production",                 module: "Production",              view: "production",  source: "work_orders" },
    { clause: "8.5.2", requirement: "Identification and traceability",       module: "Warehouse and Material",  view: "warehouse",   source: "lots" },
    { clause: "8.5.4", requirement: "Preservation",                          module: "Warehouse and Material",  view: "warehouse",   source: "lots" },
    { clause: "8.6",   requirement: "Release of products and services",      module: "Shipping",                view: "shipping" },
    { clause: "8.7",   requirement: "Control of nonconforming outputs",      module: "Nonconformance",          view: "ncr",         type: "ncr" },
    { clause: "9.2",   requirement: "Internal audit",                        module: "Internal Audit",          view: "audit",       type: "audit" },
    { clause: "9.3",   requirement: "Management review",                     module: "Management Review",       view: "review" },
    { clause: "10.2",  requirement: "Nonconformity and corrective action",   module: "CAPA",                    view: "capa",        type: "capa" }
];

/* Only these table names are ever interpolated into the count query,
   and they come from the map above, never from a request. */
const COUNTABLE = ["documents", "gages", "training_records", "parts",
                   "vendors", "work_orders", "lots", "users"];

/* GET /api/dashboard/readiness

   Answers the question the person signing the cheque actually asks:
   what will an auditor find, and what do we fix first.

   So this returns findings, not a completeness score. Every clause
   carries either a specific problem with a count, or nothing. A clause
   with nothing wrong is deliberately boring. */
dashboard.get("/readiness", async (request, response, next) => {
    try {
        /* Counts for clauses backed by quality events. */
        const eventCounts = await query(`
            select rt.key,
                   count(r.id)                                    as records,
                   count(r.id) filter (where r.closed_at is null)  as open,
                   count(r.id) filter (where r.closed_at is null
                                         and r.due_at < now())     as overdue
              from record_types rt
         left join records r on r.record_type_id = rt.id
             where rt.org_id = $1
             group by rt.key
        `, [request.user.org_id]);

        const byType = {};
        for (const row of eventCounts.rows) {
            byType[row.key] = {
                records: Number(row.records),
                open: Number(row.open),
                overdue: Number(row.overdue)
            };
        }

        /* Counts for clauses backed by master data. */
        const sourceCounts = {};
        await Promise.all(COUNTABLE.map(async (table) => {
            const result = await query(
                "select count(*)::int as n from " + table + " where org_id = $1",
                [request.user.org_id]
            );
            sourceCounts[table] = result.rows[0].n;
        }));

        /* The specific things an auditor writes up. */
        const [gages, training, vendors, risks] = await Promise.all([
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
                      and (tr.id is null
                           or tr.revision_trained is distinct from d.current_revision)`,
                  [request.user.org_id]),

            query(`select count(*) filter (where cert_expires < current_date)::int as expired,
                          count(*) filter (where status = 'scar_open')::int        as scar_open
                     from vendors where org_id = $1`, [request.user.org_id]),

            query(`select count(*)::int as unmitigated
                     from records r
                     join record_types rt on rt.id = r.record_type_id
                    where r.org_id = $1 and rt.key = 'risk'
                      and r.status = 'unmitigated'`, [request.user.org_id])
        ]);

        const gagesPastDue  = gages.rows[0].past_due;
        const trainingGaps  = training.rows[0].gaps;
        const certsExpired  = vendors.rows[0].expired;
        const scarsOpen     = vendors.rows[0].scar_open;
        const risksOpen     = risks.rows[0].unmitigated;

        const overdue = (key) => byType[key]?.overdue ?? 0;

        /* One finding per clause, or null. Ordered by how badly an
           auditor reacts to it: overdue beats open, missing beats late. */
        function findingFor(entry) {
            switch (entry.clause) {
                case "7.1.5":
                    return gagesPastDue
                        ? { text: gagesPastDue + " gage past due", severity: "crit" } : null;
                case "7.2":
                case "7.3":
                    return trainingGaps
                        ? { text: trainingGaps + " training gaps", severity: "warn" } : null;
                case "8.4":
                    if (certsExpired) return { text: certsExpired + " expired certificate", severity: "crit" };
                    return scarsOpen ? { text: scarsOpen + " SCAR open", severity: "warn" } : null;
                case "6.1":
                    return risksOpen
                        ? { text: risksOpen + " unmitigated risks", severity: "warn" } : null;
                case "9.2":
                    return overdue("audit")
                        ? { text: overdue("audit") + " audits overdue", severity: "crit" } : null;
                case "10.2":
                    return overdue("capa")
                        ? { text: overdue("capa") + " CAPAs overdue", severity: "crit" } : null;
                case "8.7":
                    return overdue("ncr")
                        ? { text: overdue("ncr") + " NCRs overdue", severity: "warn" } : null;
                case "8.2.1":
                    return overdue("complaint")
                        ? { text: overdue("complaint") + " complaint past response date", severity: "warn" } : null;
                default:
                    return null;
            }
        }

        const clauses = CLAUSE_MAP.map((entry) => {
            let evidence = null;

            if (entry.type && byType[entry.type]) {
                evidence = { records: byType[entry.type].records, kind: "events" };
            } else if (entry.source && sourceCounts[entry.source] !== undefined) {
                evidence = { records: sourceCounts[entry.source], kind: "master" };
            }

            /* No table behind the clause at all is itself a finding, and
               the one an auditor opens with. */
            const finding = evidence
                ? findingFor(entry)
                : { text: "No evidence recorded", severity: "crit" };

            return {
                clause: entry.clause,
                requirement: entry.requirement,
                module: entry.module,
                view: entry.view,
                evidence,
                finding
            };
        });

        const flagged = clauses.filter((row) => row.finding);

        response.json({
            summary: {
                clauses_total:     clauses.length,
                clauses_flagged:   flagged.length,
                audits_overdue:    overdue("audit"),
                capas_overdue:     overdue("capa"),
                gages_past_due:    gagesPastDue,
                training_gaps:     trainingGaps,
                no_evidence:       clauses.filter((row) => !row.evidence).length
            },
            clauses
        });
    } catch (error) {
        next(error);
    }
});
