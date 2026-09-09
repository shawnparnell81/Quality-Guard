/* ============================================================
   One-instance scheduled jobs (audit H8).

   The digest, the LPA roll-forward and the record-audit prune are
   self-arming timers. With more than one app instance each timer
   fires on each instance - the digest would go out N times, the roll
   would race itself.

   runOnce(key, fn) takes a Postgres transaction-scoped advisory lock
   before running fn; only the instance that gets the lock runs it,
   and the lock releases when the wrapping transaction ends (so it
   cannot leak if the process dies mid-run). Single-node: the lock is
   always free, so nothing changes.
   ============================================================ */

import { withTransaction } from "./db.js";

/* Distinct keys per job. Arbitrary, just stable. */
export const JOB_LOCKS = {
    digest: 811001,
    lpaRoll: 811002,
    auditPrune: 811003
};

/* Returns { ran: boolean }. `ran` is false when another instance held
   the lock - the caller decides whether that is worth logging. */
export async function runOnce(key, fn) {
    return withTransaction(async (client) => {
        const got = (await client.query(
            "select pg_try_advisory_xact_lock($1) as got", [key]
        )).rows[0].got;
        if (!got) return { ran: false };
        await fn();
        return { ran: true };
    });
}
