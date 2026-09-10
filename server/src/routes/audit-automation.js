/* ============================================================
   Audit automation endpoints - the manual (re-)run buttons and the
   status/log panels for both audit kinds.

   Internal audits are addressed by record number (AUD-YYYY-NNNN);
   in-process audits by lpa_audits id. Both resolve the subject inside
   the caller's org first, so a cross-tenant id is a 404.

   The engine is server/src/audit-automation.js. Internal audits also
   auto-run pieces on their workflow transitions (records.js hook); LPA
   audits auto-run on completion (lpa.js).
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";
import { requirePermission } from "../auth.js";
import {
    internalContext, inProcessContext, runFull, runStep,
    automationSummary, AUDIT_STEPS
} from "../audit-automation.js";

export const auditAutomation = Router();

function boolFlag(request) {
    return request.body?.force === true || request.query.force === "true";
}

async function logsFor(kind, id) {
    const col = kind === "internal" ? "record_id" : "lpa_audit_id";
    const r = await query(`
        select step, status, run_source, detail, error,
               started_at, finished_at, created_at
          from automation_logs
         where ${col} = $1
         order by created_at desc
         limit 200
    `, [id]);
    return r.rows;
}

/* ---------- internal audits (records type 'audit') ---------- */

auditAutomation.get("/audits/:number/automation", requirePermission("audit.read"),
    async (request, response, next) => {
        try {
            const ctx = await internalContext(request.user.org_id, request.params.number);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            response.json(await automationSummary(ctx));
        } catch (error) {
            next(error);
        }
    });

auditAutomation.get("/audits/:number/automation/logs", requirePermission("audit.read"),
    async (request, response, next) => {
        try {
            const ctx = await internalContext(request.user.org_id, request.params.number);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            const logs = await logsFor("internal", ctx.auditId);
            response.json({ count: logs.length, logs });
        } catch (error) {
            next(error);
        }
    });

auditAutomation.post("/audits/:number/automation/run", requirePermission("audit.schedule"),
    async (request, response, next) => {
        try {
            const ctx = await internalContext(request.user.org_id, request.params.number);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            ctx.userId = request.user.id;
            response.json(await runFull(ctx, { source: "manual", force: boolFlag(request) }));
        } catch (error) {
            next(error);
        }
    });

auditAutomation.post("/audits/:number/automation/:step", requirePermission("audit.schedule"),
    async (request, response, next) => {
        try {
            if (!AUDIT_STEPS.includes(request.params.step)) {
                return response.status(400).json({ error: "Unknown step " + request.params.step });
            }
            const ctx = await internalContext(request.user.org_id, request.params.number);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            ctx.userId = request.user.id;
            response.json({
                steps: [await runStep(ctx, request.params.step,
                    { source: "manual", force: boolFlag(request) })]
            });
        } catch (error) {
            next(error);
        }
    });

/* ---------- in-process audits (lpa_audits) ---------- */

auditAutomation.get("/lpa/audits/:id/automation", requirePermission("lpa.read"),
    async (request, response, next) => {
        try {
            const ctx = await inProcessContext(request.user.org_id, request.params.id);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            response.json(await automationSummary(ctx));
        } catch (error) {
            next(error);
        }
    });

auditAutomation.get("/lpa/audits/:id/automation/logs", requirePermission("lpa.read"),
    async (request, response, next) => {
        try {
            const ctx = await inProcessContext(request.user.org_id, request.params.id);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            const logs = await logsFor("in_process", ctx.lpaAuditId);
            response.json({ count: logs.length, logs });
        } catch (error) {
            next(error);
        }
    });

auditAutomation.post("/lpa/audits/:id/automation/run", requirePermission("lpa.audit"),
    async (request, response, next) => {
        try {
            const ctx = await inProcessContext(request.user.org_id, request.params.id);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            ctx.userId = request.user.id;
            response.json(await runFull(ctx, { source: "manual", force: boolFlag(request) }));
        } catch (error) {
            next(error);
        }
    });

auditAutomation.post("/lpa/audits/:id/automation/:step", requirePermission("lpa.audit"),
    async (request, response, next) => {
        try {
            if (!AUDIT_STEPS.includes(request.params.step)) {
                return response.status(400).json({ error: "Unknown step " + request.params.step });
            }
            const ctx = await inProcessContext(request.user.org_id, request.params.id);
            if (!ctx) return response.status(404).json({ error: "No such audit" });
            ctx.userId = request.user.id;
            response.json({
                steps: [await runStep(ctx, request.params.step,
                    { source: "manual", force: boolFlag(request) })]
            });
        } catch (error) {
            next(error);
        }
    });
