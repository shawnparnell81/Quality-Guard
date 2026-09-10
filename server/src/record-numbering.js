/* ============================================================
   The next PREFIX-YYYY-NNNN for a record type.

   One implementation, because the sequence is only safe if the lock
   below is taken everywhere. records.js and records-raise.js each
   grew their own copy and they disagreed - one scoped the max() by
   org_id and one did not - which matters because the uniqueness the
   database actually enforces is (org_id, number).

   max() takes no lock, so two concurrent creates read the same
   number and one loses to records_org_id_number_key. Raising the
   isolation level does not help: the row being read does not exist
   yet, so there is nothing to conflict on. An advisory lock keyed on
   (org, type, year) and held to the end of the caller's transaction
   is what serialises the read and the insert that follows it.
   ============================================================ */

import { log } from "./logger.js";

const UNIQUE_VIOLATION = "23505";
const NUMBER_CONSTRAINT = "records_org_id_number_key";

/**
 * @param {import("pg").PoolClient} client  an open transaction - the lock
 *                                          is released by its COMMIT/ROLLBACK
 * @param {string} orgId
 * @param {{id: string, prefix: string}} recordType
 */
export async function nextRecordNumber(client, orgId, recordType) {
    const year = new Date().getFullYear();
    const prefix = recordType.prefix + "-" + year + "-";

    await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [orgId + ":" + recordType.id + ":" + year]
    );

    /* Sequenced off the numeric suffix, not the text: legacy seed data
       mixes widths (AUD-2026-013 and AUD-2026-0014), and `order by
       number desc` then picks the wrong "highest" and hands out a
       number that already exists. */
    const last = await client.query(`
        select coalesce(max(split_part(number, '-', 3)::int), 0) as n
          from records
         where org_id = $1 and record_type_id = $2 and number like $3
    `, [orgId, recordType.id, prefix + "%"]);

    return prefix + String(Number(last.rows[0].n) + 1).padStart(4, "0");
}

export function isDuplicateNumber(error) {
    return error?.code === UNIQUE_VIOLATION && error?.constraint === NUMBER_CONSTRAINT;
}

/* Belt to the lock's braces: a number can still collide with one that
   was never allocated through nextRecordNumber - typed into seed data,
   restored from a backup, written by a future path that forgets the
   lock. Re-running the work re-reads the sequence, which is what the
   caller wants; the alternative is a 500 on a create that would
   succeed on its own retry. The work must be a whole transaction, not
   just the insert, or the retry runs inside an aborted one. */
export async function withNumberRetry(work, attempts = 3) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (!isDuplicateNumber(error) || attempt >= attempts) throw error;
            log.warn("record_number_collision", { attempt, err: error });
        }
    }
}
