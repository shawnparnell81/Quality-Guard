/* ============================================================
   "Who else has this record open for editing right now."

   A browser that opens the record editor sends a heartbeat every few
   seconds; the entry expires ~20s after the last one, so a closed tab
   or a dropped connection clears itself without needing a reliable
   "goodbye". Every change to a record's editor set is pushed to that
   org's SSE streams as a { entity: "presence" } frame, so other open
   editors update live.

   Backed by the `presence` table (migration 051, audit H8) so the
   editor set is the same across app instances - the SSE bus it rides
   on is already cross-instance.
   ============================================================ */

import { query } from "./db.js";
import { publish } from "./stream.js";

const TTL = "20 seconds";

async function liveEditors(orgId, number) {
    const rows = await query(`
        select user_id as id, user_name as name, dirty
          from presence
         where org_id = $1 and record_number = $2
           and last_seen_at > now() - interval '${TTL}'
         order by last_seen_at
    `, [orgId, number]);
    return rows.rows.map((r) => ({ id: r.id, name: r.name, dirty: Boolean(r.dirty) }));
}

async function broadcast(orgId, number) {
    publish(orgId, {
        entity: "presence",
        id: number,
        action: "editing",
        editors: await liveEditors(orgId, number)
    });
}

/* Called on open and then on a timer. Returns the current editor list
   (including the caller - the client filters itself out by id). */
export async function heartbeat(orgId, number, user, dirty = false) {
    const prior = await query(
        "select dirty from presence where org_id = $1 and record_number = $2 and user_id = $3",
        [orgId, number, user.id]
    );

    await query(`
        insert into presence (org_id, record_number, user_id, user_name, dirty, last_seen_at)
        values ($1, $2, $3, $4, $5, now())
        on conflict (org_id, record_number, user_id) do update
            set user_name = excluded.user_name,
                dirty = excluded.dirty,
                last_seen_at = now()
    `, [orgId, number, user.id, user.full_name || user.initials || "Someone", Boolean(dirty)]);

    /* Tell everyone else when the set changed OR when this editor's
       unsaved-changes state flipped - both are news to the others. */
    const joined = prior.rowCount === 0;
    const flipped = prior.rowCount > 0 && Boolean(prior.rows[0].dirty) !== Boolean(dirty);
    if (joined || flipped) await broadcast(orgId, number);

    return liveEditors(orgId, number);
}

/* Called when the editor closes. */
export async function leaveEditing(orgId, number, userId) {
    const gone = await query(
        "delete from presence where org_id = $1 and record_number = $2 and user_id = $3",
        [orgId, number, userId]
    );
    if (gone.rowCount > 0) await broadcast(orgId, number);
}

/* Prune entries whose last heartbeat aged out; announce the rooms
   that shrank. Runs on a timer from module load. With more than one
   instance each sweeps, but DELETE ... RETURNING means only the
   instance that actually removed a row broadcasts for that room. */
export async function sweepPresence() {
    const removed = await query(`
        delete from presence
         where last_seen_at <= now() - interval '${TTL}'
        returning org_id, record_number
    `);
    if (removed.rowCount === 0) return;

    const rooms = new Set(removed.rows.map((r) => r.org_id + "|" + r.record_number));
    for (const room of rooms) {
        const sep = room.indexOf("|");
        await broadcast(room.slice(0, sep), room.slice(sep + 1));
    }
}

/* For tests. */
export function editorsFor(orgId, number) {
    return liveEditors(orgId, number);
}

const timer = setInterval(() => {
    sweepPresence().catch(() => { /* a transient DB blip is not worth a crash */ });
}, 10000);
if (typeof timer.unref === "function") timer.unref();
