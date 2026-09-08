/* ============================================================
   In-app notifications (P3.4).

   GET  /api/notifications            sync + return the feed
   POST /api/notifications/:id/read   mark one read
   POST /api/notifications/read-all   mark every unread one read

   The feed is kept in sync lazily on the GET, the same "compute on
   read" pattern as the LPA roll-forward: four queries work out what
   should be on your list right now, rows are upserted by dedupe_key,
   and still-unread rows whose condition has cleared are removed.
   Real-time record changes also drop a row in directly via notify().
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";
import { publish } from "../stream.js";

export const notifications = Router();

/* Workflow steps that read as "someone signs this off". A record
   sitting one of these transitions away, where the caller holds the
   permission it needs, is an approval waiting on them. */
const APPROVAL_PERMISSION_RX = /\.(approve|close|release|verify|disposition|use_as_is|sign_off)$/;

/* Insert or refresh one notification and ping the org's streams.
   dedupeKey keeps one unread row per condition per person. */
export async function notify(orgId, userId, note) {
    if (!orgId || !userId) return;
    await query(`
        insert into notifications
            (org_id, user_id, kind, title, body, link_type, link_number, dedupe_key)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (user_id, dedupe_key) where dedupe_key is not null and read_at is null
        do update set title = excluded.title, body = excluded.body,
                      link_type = excluded.link_type, link_number = excluded.link_number,
                      created_at = now()
    `, [orgId, userId, note.kind, note.title, note.body || null,
        note.link_type || null, note.link_number || null, note.dedupe_key || null]);

    publish(orgId, { entity: "notifications", id: userId, action: "new" });
}

/* Work out the caller's live feed and reconcile the stored rows to
   it. Returns nothing; the GET reads the table afterwards. */
async function syncNotifications(user, permissions) {
    const orgId = user.org_id;
    const userId = user.id;
    const wanted = new Map();   // dedupe_key -> { kind, title, body, link_type, link_number }

    /* assigned + overdue: records you own that are still open. */
    const mine = await query(`
        select r.number, r.title, r.due_at, rt.key as type
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.owner_id = $2 and r.closed_at is null
    `, [orgId, userId]);

    for (const row of mine.rows) {
        wanted.set("assigned:" + row.number, {
            kind: "assigned", title: row.number + " is assigned to you",
            body: row.title, link_type: row.type, link_number: row.number
        });
        if (row.due_at && new Date(row.due_at) < new Date()) {
            wanted.set("overdue:" + row.number, {
                kind: "overdue", title: row.number + " is overdue",
                body: row.title, link_type: row.type, link_number: row.number
            });
        }
    }

    /* approval: a record one workflow step away from a sign-off the
       caller is allowed to give. */
    const pending = await query(`
        select r.number, r.title, rt.key as type,
               array_agg(distinct wt.required_permission) as needs
          from records r
          join record_types rt on rt.id = r.record_type_id
          join workflow_transitions wt
            on wt.record_type_id = r.record_type_id and wt.from_state = r.status
         where r.org_id = $1 and r.closed_at is null and wt.required_permission is not null
         group by r.number, r.title, rt.key
    `, [orgId]);

    for (const row of pending.rows) {
        const canSignoff = (row.needs || []).some((perm) =>
            perm && APPROVAL_PERMISSION_RX.test(perm) && permissions.has(perm));
        if (canSignoff) {
            wanted.set("approval:" + row.number, {
                kind: "approval", title: row.number + " is waiting for your approval",
                body: row.title, link_type: row.type, link_number: row.number
            });
        }
    }

    /* finding: an audit you own that turned up a warn/crit finding
       and is not closed yet. */
    const findings = await query(`
        select r.number, r.title
          from records r
          join record_types rt on rt.id = r.record_type_id
         where r.org_id = $1 and r.owner_id = $2 and rt.key = 'audit'
           and r.closed_at is null and r.severity in ('warn', 'crit')
    `, [orgId, userId]);

    for (const row of findings.rows) {
        wanted.set("finding:" + row.number, {
            kind: "finding", title: row.number + " has an open finding",
            body: row.title, link_type: "audit", link_number: row.number
        });
    }

    const keys = [...wanted.keys()];

    /* A condition raises a notification once. If the person has
       already seen (and maybe read) it, leave it alone - regenerating
       a dismissed row every time the feed loads would just be nagging.
       So only insert the keys that have no row at all yet. */
    const seen = keys.length === 0 ? { rows: [] } : await query(
        "select dedupe_key from notifications where user_id = $1 and dedupe_key = any($2::text[])",
        [userId, keys]);
    const known = new Set(seen.rows.map((r) => r.dedupe_key));

    for (const [dedupe, note] of wanted) {
        if (known.has(dedupe)) continue;
        await query(`
            insert into notifications
                (org_id, user_id, kind, title, body, link_type, link_number, dedupe_key)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict (user_id, dedupe_key) where dedupe_key is not null and read_at is null
            do nothing
        `, [orgId, userId, note.kind, note.title, note.body || null,
            note.link_type, note.link_number, dedupe]);
    }

    /* Drop still-unread computed rows whose condition has cleared
       (record closed, reassigned, no longer overdue). Read rows are
       left to age out of the feed window on their own. */
    await query(`
        delete from notifications
         where user_id = $1 and read_at is null and dedupe_key is not null
           and not (dedupe_key = any($2::text[]))
    `, [userId, keys]);
}

notifications.get("/notifications", async (request, response, next) => {
    try {
        await syncNotifications(request.user, request.permissions);

        const rows = await query(`
            select id, kind, title, body, link_type, link_number, read_at, created_at
              from notifications
             where user_id = $1
               and (read_at is null or created_at > now() - interval '7 days')
             order by (read_at is null) desc, created_at desc
             limit 50
        `, [request.user.id]);

        const unread = rows.rows.filter((r) => !r.read_at).length;
        response.json({ unread_count: unread, items: rows.rows });
    } catch (error) {
        next(error);
    }
});

notifications.post("/notifications/read-all", async (request, response, next) => {
    try {
        const result = await query(
            "update notifications set read_at = now() where user_id = $1 and read_at is null",
            [request.user.id]
        );
        response.json({ marked: result.rowCount });
    } catch (error) {
        next(error);
    }
});

notifications.post("/notifications/:id/read", async (request, response, next) => {
    try {
        const result = await query(
            "update notifications set read_at = now() where id = $1 and user_id = $2 and read_at is null returning id",
            [request.params.id, request.user.id]
        );
        if (result.rowCount === 0) return response.status(404).json({ error: "No such notification" });
        response.json({ id: result.rows[0].id });
    } catch (error) {
        next(error);
    }
});
