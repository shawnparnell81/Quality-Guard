/* ============================================================
   Record-audit retention (audit M11).

   record_audit grows one row per record change forever. The DB
   function record_audit_prune(retain_days) drops UPDATE rows older
   than retain_days for records that are already closed (or gone);
   INSERT and DELETE rows are always kept, and an open record keeps
   its whole history.

   A self-arming daily timer runs it - no cron, same pattern as the
   digest and the LPA roll. Single-node; a multi-node deploy guards
   this with a lock or moves it to an external scheduler.
   ============================================================ */

import { query } from "./db.js";
import { runOnce, JOB_LOCKS } from "./job-lock.js";

function retainDays() {
    const n = Number(process.env.RECORD_AUDIT_RETAIN_DAYS);
    return Number.isInteger(n) && n > 0 ? n : 730;
}

export async function pruneRecordAuditOnce() {
    const result = await query("select record_audit_prune($1) as pruned", [retainDays()]);
    return Number(result.rows[0].pruned);
}

let timer = null;

export function startAuditPruneSchedule() {
    const tick = async () => {
        try {
            let pruned = 0;
            await runOnce(JOB_LOCKS.auditPrune, async () => { pruned = await pruneRecordAuditOnce(); });
            if (pruned > 0) {
                console.log("[audit] pruned " + pruned + " stale record_audit UPDATE row(s)");
            }
        } catch (error) {
            console.error("[audit] prune failed: " + error.message);
        }
        timer = setTimeout(tick, 24 * 60 * 60 * 1000);
        if (typeof timer.unref === "function") timer.unref();
    };
    tick();
}
