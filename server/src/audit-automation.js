/* ============================================================
   Internal + In-Process audit automation engine.

   One STEPS registry, two audit kinds:

     internal    - a `records` row of type 'audit' (clause 9.2). Its
                   checklist answers live in records.data.checklist.
                   A finding raises a Discrepancy Investigation
                   (child_of the audit) - the app's ISO-9.2 bridge.
     in_process  - an `lpa_audits` row (clause 9.2.2, the LPA module).
                   A failed answer raises an NCR record and the number
                   is written back to lpa_answers.ncr_number.

   Steps: folders -> checklist -> findings -> actions -> report. Each is
   idempotent and writes a row to automation_logs (running -> done |
   skipped | failed), keyed by record_id or lpa_audit_id. runFull
   continues past a failed step; a transition or an LPA completion is
   never blocked by automation.

   The 6-phase lifecycle the UI shows (Scheduled -> Checklist Generated
   -> In Progress -> Findings Logged -> Actions Assigned -> Closed, and
   the in-process variant) is *derived* from step completion + the
   record's native status - see computePhase(). The audit record type
   and lpa_audits workflows are untouched.

   Reuses: db.js, file-storage.js, pdf-branding.js, records-raise.js.
   ============================================================ */

import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

import { query, withTransaction } from "./db.js";
import { STORAGE_ROOT, STORAGE_DRIVER } from "./file-storage.js";
import { drawLetterhead, drawFooter, INK, INK_2, HAIRLINE } from "./pdf-branding.js";
import { raiseLinkedRecord } from "./records-raise.js";
import { log } from "./logger.js";

export const AUDIT_FOLDERS = ["01_Checklists", "02_Findings", "03_Actions", "04_Reports"];
export const AUDIT_STEPS = ["folders", "checklist", "findings", "actions", "report"];

const STEP_LABEL = {
    folders: "Folder structure",
    checklist: "Checklist",
    findings: "Findings",
    actions: "Actions",
    report: "Report"
};

/* ---------- context ---------- */

async function orgName(orgId) {
    const r = await query("select name from organizations where id = $1", [orgId]);
    return r.rows[0]?.name || "QMS Guardian";
}

/* Resolve an internal audit (records type 'audit') by number. */
export async function internalContext(orgId, number) {
    const r = await query(`
        select r.id, r.number, r.title, r.status, r.data,
               (select is_terminal from workflow_states ws
                 where ws.record_type_id = r.record_type_id and ws.key = r.status) as terminal
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.number = $2 and rt.key = 'audit'
    `, [orgId, number]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
        kind: "internal",
        orgId,
        auditId: row.id,
        auditNumber: row.number,
        title: row.title,
        nativeStatus: row.status,
        terminal: Boolean(row.terminal),
        data: row.data || {},
        /* Keyed by the record id, not the number: audit numbers restart
           per org, so two tenants both hold AUD-2026-0001 and would
           otherwise share one folder tree on disk. */
        root: row.id
    };
}

/* Resolve an in-process audit (lpa_audits) by id. */
export async function inProcessContext(orgId, id) {
    const r = await query(`
        select a.id, a.layer, a.area, a.status, a.template_id, a.folder_root,
               a.score_pass, a.score_total, a.performed_on, a.due_on,
               u.full_name as auditor, u.initials as auditor_initials,
               t.name as template
          from lpa_audits a
          join lpa_templates t on t.id = a.template_id
     left join users u on u.id = a.auditor_id
         where a.org_id = $1 and a.id = $2
    `, [orgId, id]);
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
        kind: "in_process",
        orgId,
        lpaAuditId: row.id,
        nativeStatus: row.status,
        templateId: row.template_id,
        layer: row.layer,
        area: row.area,
        auditor: row.auditor,
        auditorInitials: row.auditor_initials,
        template: row.template,
        scorePass: row.score_pass,
        scoreTotal: row.score_total,
        root: row.folder_root || ("lpa-" + row.id)
    };
}

async function reloadContext(ctx) {
    return ctx.kind === "internal"
        ? internalContext(ctx.orgId, ctx.auditNumber)
        : inProcessContext(ctx.orgId, ctx.lpaAuditId);
}

/* ---------- filesystem artifacts ---------- */

function artifactDir(root, folder) {
    return path.join(STORAGE_ROOT, "audit-folders", root, folder);
}

async function writeArtifact(root, folder, file, contents) {
    const rel = path.posix.join("audit-folders", root, folder, file);
    if (STORAGE_DRIVER !== "local") return rel;
    const dir = artifactDir(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), contents);
    return rel;
}

async function artifactExists(root, folder, file) {
    if (STORAGE_DRIVER !== "local") return false;
    try {
        await fs.access(path.join(artifactDir(root, folder), file));
        return true;
    } catch {
        return false;
    }
}

/* ---------- checklist answers, per kind ---------- */

/* [{ question_id, text, result: 'pass'|'fail'|'na', note }] */
async function loadAnswers(ctx) {
    if (ctx.kind === "internal") {
        const list = Array.isArray(ctx.data.checklist) ? ctx.data.checklist : [];
        return list.map((a) => ({
            question_id: a.question_id || a.id || null,
            text: a.text || a.question || "",
            result: a.result,
            note: a.note || ""
        }));
    }
    const r = await query(`
        select a.question_id, q.text, a.result, a.note, a.ncr_number
          from lpa_answers a
          join lpa_questions q on q.id = a.question_id
         where a.audit_id = $1
         order by q.position, q.text
    `, [ctx.lpaAuditId]);
    return r.rows;
}

function scoreOf(answers) {
    const pass = answers.filter((a) => a.result === "pass").length;
    const total = answers.filter((a) => a.result === "pass" || a.result === "fail").length;
    return { pass, total, pct: total > 0 ? Math.round((pass / total) * 100) : null };
}

/* ---------- steps ---------- */

async function seedFolders({ ctx }) {
    for (const folder of AUDIT_FOLDERS) {
        if (STORAGE_DRIVER === "local") {
            await fs.mkdir(artifactDir(ctx.root, folder), { recursive: true });
        }
    }
    if (ctx.kind === "internal") {
        await query(`
            update records
               set data = jsonb_set(
                       coalesce(data, '{}'::jsonb),
                       '{automation}',
                       coalesce(data->'automation', '{}'::jsonb)
                           || jsonb_build_object('folder_root', $2::text),
                       true),
                   updated_at = now()
             where id = $1
        `, [ctx.auditId, ctx.root]);
    } else {
        await query("update lpa_audits set folder_root = $2 where id = $1",
            [ctx.lpaAuditId, ctx.root]);
    }
    return { detail: AUDIT_FOLDERS.length + " folder(s) ensured under audit-folders/" + ctx.root + "/" };
}

async function resolveTemplateId(ctx) {
    if (ctx.kind === "in_process") return ctx.templateId;
    if (ctx.data.checklist_template_id) return ctx.data.checklist_template_id;
    const first = await query(
        "select id from lpa_templates where org_id = $1 and active order by name limit 1",
        [ctx.orgId]);
    if (first.rowCount === 0) {
        throw new Error("No checklist template on the audit and no active LPA templates to fall back to");
    }
    return first.rows[0].id;
}

function renderChecklistPdf(orgTitle, ctx, template, questions) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 48 });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        drawLetterhead(doc, orgTitle, "Audit checklist");
        doc.moveDown(1);
        doc.fontSize(11).fillColor(INK).font("Helvetica-Bold")
            .text(ctx.kind === "internal"
                ? "Internal Audit " + ctx.auditNumber
                : "In-Process Audit - " + ctx.area + " / " + ctx.layer);
        doc.font("Helvetica").fontSize(9.5).fillColor(INK_2)
            .text("Template: " + template.name)
            .text("Generated: " + new Date().toISOString().slice(0, 10));
        doc.moveDown(1);

        doc.fontSize(10).fillColor(INK);
        questions.forEach((q, i) => {
            doc.font("Helvetica-Bold").text((i + 1) + ". " + q.text
                + (q.critical ? "  [critical]" : ""));
            if (q.guidance) doc.font("Helvetica").fontSize(9).fillColor(INK_2).text(q.guidance);
            doc.font("Helvetica").fontSize(10).fillColor(INK_2)
                .text("Pass ☐    Fail ☐    N/A ☐    Note: ____________________________");
            doc.fillColor(INK).moveDown(0.6);
        });

        drawFooter(doc, orgTitle);
        doc.end();
    });
}

async function buildChecklist({ ctx, force }) {
    if (!force && await artifactExists(ctx.root, "01_Checklists", "checklist.pdf")) {
        return { skipped: true, detail: "Checklist already generated" };
    }
    const templateId = await resolveTemplateId(ctx);
    const template = (await query(
        "select id, name from lpa_templates where org_id = $1 and id = $2",
        [ctx.orgId, templateId])).rows[0];
    if (!template) throw new Error("Chosen checklist template not found");

    const questions = (await query(`
        select id, position, text, guidance, critical
          from lpa_questions where template_id = $1 order by position, text
    `, [templateId])).rows;

    const json = {
        template_id: templateId,
        template_name: template.name,
        generated_at: new Date().toISOString(),
        audit: ctx.kind === "internal" ? ctx.auditNumber : ctx.root,
        questions: questions.map((q) => ({
            question_id: q.id, position: q.position, text: q.text,
            guidance: q.guidance, critical: q.critical
        }))
    };
    await writeArtifact(ctx.root, "01_Checklists", "checklist.json",
        JSON.stringify(json, null, 2));
    await writeArtifact(ctx.root, "01_Checklists", "checklist.pdf",
        await renderChecklistPdf(await orgName(ctx.orgId), ctx, template, questions));

    return { detail: questions.length + " question(s) from \"" + template.name + "\"" };
}

async function existingDi(auditId) {
    const r = await query(`
        select r.number
          from record_links l
          join records r       on r.id = l.to_record_id
          join record_types rt on rt.id = r.record_type_id
         where l.from_record_id = $1 and l.link_type = 'child_of' and rt.key = 'di'
    `, [auditId]);
    return r.rows[0]?.number || null;
}

async function logFindings({ ctx }) {
    const answers = await loadAnswers(ctx);
    const fails = answers.filter((a) => a.result === "fail");

    if (fails.length === 0) {
        await writeArtifact(ctx.root, "02_Findings", "findings.txt",
            "No findings - every checklist item passed or was not applicable.\n");
        return { detail: "No findings" };
    }

    const lines = fails.map((f, i) =>
        (i + 1) + ". " + (f.text || f.question_id) + (f.note ? "\n   Note: " + f.note : ""));

    if (ctx.kind === "internal") {
        const already = await existingDi(ctx.auditId);
        if (already) {
            await writeArtifact(ctx.root, "02_Findings", "findings.txt",
                "Discrepancy Investigation " + already + " covers "
                + fails.length + " finding(s):\n\n" + lines.join("\n") + "\n");
            return { skipped: true, detail: "DI " + already + " already raised" };
        }
        const raised = await withTransaction((client) => raiseLinkedRecord(client, {
            orgId: ctx.orgId,
            typeKey: "di",
            title: "Discrepancy from " + ctx.auditNumber,
            data: {
                department: ctx.data.department || ctx.data.scope || ctx.title || "",
                finding: fails.length + " audit finding(s):\n" + lines.join("\n")
            },
            severity: "warn",
            linkFromRecordId: ctx.auditId,
            linkType: "child_of",
            userId: ctx.userId
        }));
        if (!raised) throw new Error("This organization has no DI record type");
        await writeArtifact(ctx.root, "02_Findings", "findings.txt",
            "Discrepancy Investigation " + raised.number + " raised for "
            + fails.length + " finding(s):\n\n" + lines.join("\n") + "\n");
        return { detail: "DI " + raised.number + " raised for " + fails.length + " finding(s)" };
    }

    /* in_process: one NCR per failed answer that does not have one yet */
    let raisedCount = 0, hadOne = 0;
    for (const f of fails) {
        if (f.ncr_number) { hadOne += 1; continue; }
        const raised = await withTransaction((client) => raiseLinkedRecord(client, {
            orgId: ctx.orgId,
            typeKey: "ncr",
            title: "In-process audit - " + ctx.area,
            data: {
                source: "LPA " + ctx.area + " / " + ctx.layer,
                description: f.text + (f.note ? " - " + f.note : ""),
                detection_point: "in_process_audit",
                department: ctx.area,
                raised_by: ctx.auditorInitials || undefined
            },
            severity: "warn",
            userId: ctx.userId
        }));
        if (raised) {
            await query(
                "update lpa_answers set ncr_number = $3 where audit_id = $1 and question_id = $2",
                [ctx.lpaAuditId, f.question_id, raised.number]);
            raisedCount += 1;
        }
    }
    await writeArtifact(ctx.root, "02_Findings", "findings.txt",
        fails.length + " failed check(s):\n\n" + lines.join("\n")
        + "\n\n" + raisedCount + " NCR(s) raised, " + hadOne + " already had one.\n");
    return { detail: raisedCount + " NCR(s) raised, " + hadOne + " already had one" };
}

async function assignActions({ ctx }) {
    let body;
    if (ctx.kind === "internal") {
        const di = await existingDi(ctx.auditId);
        body = di
            ? "Corrective actions tracked on Discrepancy Investigation " + di + ":\n"
                + "  [ ] NCR form attached and released\n"
                + "  [ ] 8D report attached and released\n"
                + "  [ ] CAPA form attached and released\n"
                + "The audit cannot close until " + di + " is closed (clause 9.2).\n"
            : "No corrective actions - no findings were logged.\n";
    } else {
        const ncrs = (await query(`
            select distinct ncr_number from lpa_answers
             where audit_id = $1 and ncr_number is not null order by ncr_number
        `, [ctx.lpaAuditId])).rows.map((r) => r.ncr_number);
        body = ncrs.length
            ? "Open corrective actions (one NCR per failed check):\n"
                + ncrs.map((n) => "  [ ] " + n + " - dispositioned and closed").join("\n") + "\n"
            : "No corrective actions - no failed checks.\n";
    }
    await writeArtifact(ctx.root, "03_Actions", "actions.txt", body);
    return { detail: "Actions list written" };
}

function renderReportPdf(orgTitle, ctx, meta, answers) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "LETTER", margin: 48 });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        drawLetterhead(doc, orgTitle, "Audit report");
        doc.moveDown(1);
        doc.fontSize(13).fillColor(INK).font("Helvetica-Bold").text(meta.title);
        doc.moveDown(0.6);

        doc.font("Helvetica").fontSize(10).fillColor(INK_2);
        for (const [k, v] of meta.rows) doc.text(k + ": " + v);
        doc.moveDown(0.8);
        doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
            .lineWidth(0.75).stroke(HAIRLINE);
        doc.moveDown(0.8);

        const fails = answers.filter((a) => a.result === "fail");
        doc.fontSize(11).fillColor(INK).font("Helvetica-Bold")
            .text("Findings (" + fails.length + ")");
        doc.font("Helvetica").fontSize(10).fillColor(INK);
        if (fails.length === 0) {
            doc.fillColor(INK_2).text("None - all checks passed or were not applicable.");
        } else {
            fails.forEach((f, i) => doc.text((i + 1) + ". " + (f.text || f.question_id)
                + (f.note ? "  (" + f.note + ")" : "")));
        }
        doc.moveDown(0.8).fillColor(INK).font("Helvetica-Bold").fontSize(11)
            .text("Corrective actions");
        doc.font("Helvetica").fontSize(10).fillColor(INK_2).text(meta.actions);

        drawFooter(doc, orgTitle);
        doc.end();
    });
}

async function buildReport({ ctx }) {
    const answers = await loadAnswers(ctx);
    const score = ctx.kind === "in_process" && ctx.scoreTotal
        ? { pass: ctx.scorePass, total: ctx.scoreTotal,
            pct: Math.round((ctx.scorePass / ctx.scoreTotal) * 100) }
        : scoreOf(answers);

    const di = ctx.kind === "internal" ? await existingDi(ctx.auditId) : null;
    const meta = ctx.kind === "internal"
        ? {
            title: "Internal Audit Report - " + ctx.auditNumber,
            rows: [
                ["Audit", ctx.auditNumber],
                ["Scope", ctx.data.department || ctx.data.scope || ctx.title || "-"],
                ["Auditor", ctx.data.auditor || ctx.data.lead_auditor || "-"],
                ["Native status", ctx.nativeStatus],
                ["Score", score.pct === null ? "n/a" : score.pct + "%  (" + score.pass + "/" + score.total + ")"]
            ],
            actions: di ? "Tracked on Discrepancy Investigation " + di + "." : "None."
        }
        : {
            title: "In-Process Audit Report - " + ctx.area + " / " + ctx.layer,
            rows: [
                ["Area", ctx.area],
                ["Layer", ctx.layer],
                ["Auditor", ctx.auditor || "-"],
                ["Template", ctx.template],
                ["Native status", ctx.nativeStatus],
                ["Score", score.pct === null ? "n/a" : score.pct + "%  (" + score.pass + "/" + score.total + ")"]
            ],
            actions: "See 03_Actions/actions.txt."
        };

    await writeArtifact(ctx.root, "04_Reports", "audit-report.pdf",
        await renderReportPdf(await orgName(ctx.orgId), ctx, meta, answers));
    return {
        detail: "Report written"
            + (score.pct === null ? "" : ", score " + score.pct + "%")
    };
}

const STEPS = {
    folders: seedFolders,
    checklist: buildChecklist,
    findings: logFindings,
    actions: assignActions,
    report: buildReport
};

/* ---------- runners ---------- */

/* Run one step. Always writes an automation_logs row; never throws -
   a failure comes back as { status: "failed", error }. */
export async function runStep(ctx, step, opts = {}) {
    const { force = false, source = "manual" } = opts;
    const fn = STEPS[step];
    if (!fn) throw new Error("Unknown automation step: " + step);

    const recordId = ctx.kind === "internal" ? ctx.auditId : null;
    const lpaAuditId = ctx.kind === "in_process" ? ctx.lpaAuditId : null;

    const logRow = await query(`
        insert into automation_logs
            (org_id, record_id, lpa_audit_id, step, status, run_source, started_at)
        values ($1, $2, $3, $4, 'running', $5, now())
        returning id
    `, [ctx.orgId, recordId, lpaAuditId, step, source]);
    const logId = logRow.rows[0].id;

    try {
        const fresh = await reloadContext(ctx);
        if (!fresh) throw new Error("Audit no longer exists");
        fresh.userId = ctx.userId;
        const out = await fn({ ctx: fresh, force });
        const status = out && out.skipped ? "skipped" : "done";
        await query(
            "update automation_logs set status = $2, detail = $3, finished_at = now() where id = $1",
            [logId, status, out?.detail || null]);
        return { step, status, detail: out?.detail || null };
    } catch (error) {
        log.warn("audit_automation_step_failed",
            { kind: ctx.kind, step, root: ctx.root, error: error.message });
        await query(
            "update automation_logs set status = 'failed', error = $2, finished_at = now() where id = $1",
            [logId, String(error.message).slice(0, 500)]);
        return { step, status: "failed", error: error.message };
    }
}

/* Run steps in order, continuing past a failure. `only` limits the run
   to a subset (still in ORDER). */
export async function runFull(ctx, opts = {}) {
    const { force = false, source = "auto", only = null } = opts;
    const steps = [];
    for (const step of AUDIT_STEPS) {
        if (only && !only.includes(step)) continue;
        steps.push(await runStep(ctx, step, { force, source }));
    }
    return { kind: ctx.kind, steps };
}

/* ---------- derived phase + summary ---------- */

async function latestByStep(ctx) {
    const col = ctx.kind === "internal" ? "record_id" : "lpa_audit_id";
    const id = ctx.kind === "internal" ? ctx.auditId : ctx.lpaAuditId;
    const r = await query(`
        select distinct on (step) step, status, detail, error, run_source,
               started_at, finished_at, created_at
          from automation_logs
         where ${col} = $1
         order by step, created_at desc
    `, [id]);
    return Object.fromEntries(r.rows.map((row) => [row.step, row]));
}

function done(byStep, step) {
    return byStep[step] && (byStep[step].status === "done" || byStep[step].status === "skipped");
}

export async function computePhase(ctx) {
    const byStep = await latestByStep(ctx);

    if (ctx.kind === "internal") {
        const hasAnswers = Array.isArray(ctx.data.checklist) && ctx.data.checklist.length > 0;
        if (ctx.terminal) return "Closed";
        if (done(byStep, "actions")) return "Actions Assigned";
        if (done(byStep, "findings")) return "Findings Logged";
        if (hasAnswers) return "In Progress";
        if (done(byStep, "checklist")) return "Checklist Generated";
        return "Scheduled";
    }

    if (done(byStep, "report") || ctx.nativeStatus === "missed") return "Closed";
    if (done(byStep, "actions")) return "Actions Assigned";
    if (done(byStep, "findings")) return "Findings Logged";
    if (ctx.nativeStatus === "complete") return "Checklist Completed";
    if (ctx.nativeStatus === "in_progress") return "Started";
    return "Scheduled";
}

export async function automationSummary(ctx) {
    const byStep = await latestByStep(ctx);
    const answers = await loadAnswers(ctx);
    const score = ctx.kind === "in_process" && ctx.scoreTotal
        ? { pass: ctx.scorePass, total: ctx.scoreTotal,
            pct: Math.round((ctx.scorePass / ctx.scoreTotal) * 100) }
        : scoreOf(answers);

    return {
        kind: ctx.kind,
        phase: await computePhase(ctx),
        folder_root: ctx.root,
        score,
        steps: AUDIT_STEPS.map((step) => ({
            step,
            label: STEP_LABEL[step],
            ...(byStep[step] || { status: "pending" })
        }))
    };
}

/* ---------- auto-fire hook (records transition) ---------- */

/* Called from records.js after a workflow transition commits. No-op
   unless the record is an internal audit. Swallows errors - the log
   rows are already written and the transition must not be undone. */
export async function onAuditTransition(orgId, moved, userId) {
    try {
        const kind = await query(`
            select rt.key from records r
              join record_types rt on rt.id = r.record_type_id
             where r.id = $1
        `, [moved.id]);
        if (kind.rows[0]?.key !== "audit") return;

        const ctx = await internalContext(orgId, moved.number);
        if (!ctx) return;
        ctx.userId = userId;

        if (ctx.terminal) {
            await runFull(ctx, { source: "auto", only: ["findings", "actions", "report"] });
        } else if (ctx.nativeStatus === "scheduled") {
            await runFull(ctx, { source: "auto", only: ["folders", "checklist"] });
        }
    } catch (error) {
        log.warn("audit_automation_transition_hook_failed",
            { orgId, number: moved?.number, error: error.message });
    }
}
