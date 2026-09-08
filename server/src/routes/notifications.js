/* ============================================================
   In-app notifications (P3.4) + email opt-in (P3.5).

   GET  /api/notifications              sync + return the feed
   POST /api/notifications/:id/read     mark one read
   POST /api/notifications/read-all     mark every unread one read
   GET  /api/notification-prefs         { email_notifications }
   PATCH /api/notification-prefs        { email_notifications: off|immediate|digest }

   The feed is kept in sync lazily on the GET, the same "compute on
   read" pattern as the LPA roll-forward: four queries work out what
   should be on your list right now, rows are inserted once per
   dedupe_key, and still-unread rows whose condition has cleared are
   removed. notify() is the choke point for a real-time push - it
   also sends an immediate email for anyone opted in. The daily
   digest (digest.js) reuses syncNotifications().
   ============================================================ */

import { Router } from "express";
import { query } from "../db.js";
import { publish } from "../stream.js";
import { sendMail } from "../mail.js";

export const notifications = Router();

const EMAIL_MODES = ["off", "immediate", "digest"];

/* Workflow steps that read as "someone signs this off". A record
   sitting one of these transitions away, where the caller holds the
   permission it needs, is an approval waiting on them. */
const APPROVAL_PERMISSION_RX = /\.(approve|close|release|verify|disposition|use_as_is|sign_off)$/;

/* Insert one notification (once per condition) and ping the org's
   streams. If the recipient opted into immediate email, send it. */
export async function notify(orgId, userId, note) {
    if (!orgId || !userId || !note.dedupe_key) return;

    const inserted = await query(`
        insert into notifications
            (org_id, user_id, kind, title, body, link_type, link_number, dedupe_key)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (user_id, dedupe_key) where dedupe_key is not null and read_at is null
        do nothing
        returning id
    `, [orgId, userId, note.kind, note.title, note.body || null,
        note.link_type || null, note.link_number || null, note.dedupe_key]);

    if (inserted.rowCount === 0) return;   // already on their list

    publish(orgId, { entity: "notifications", id: userId, action: "new" });

    const who = await query(
        "select email, email_notifications from users where id = $1", [userId]);
    if (who.rows[0] && who.rows[0].email_notifications === "immediate") {
        await sendMail({
            to: who.rows[0].email,
            subject: "[QMS Guardian] " + note.title,
            text: note.title + (note.body ? "\n\n" + note.body : "")
                + (note.link_number ? "\n\nRecord: " + note.link_number : "")
        });
    }
}

/* The live feed for one user, as a Map keyed by dedupe_key. Pure -
   no writes - so the GET and the digest can both call it. */
export async function computeWanted(orgId, userId, permissions) {
    const wanted = new Map();

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

    return wanted;
}

/* Reconcile the stored rows to computeWanted(): insert what's new,
   drop still-unread rows whose condition cleared. */
export async function syncNotifications(user, permissions) {
    const { org_id: orgId, id: userId } = user;
    const wanted = await computeWanted(orgId, userId, permissions);
    const keys = [...wanted.keys()];

    /* A condition raises a notification once. If the person has
       already seen (and maybe read) it, leave it alone. */
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

notifications.get("/notification-prefs", async (request, response, next) => {
    try {
        const row = await query(
            "select email_notifications from users where id = $1", [request.user.id]);
        response.json({ email_notifications: row.rows[0]?.email_notifications || "off" });
    } catch (error) {
        next(error);
    }
});

notifications.patch("/notification-prefs", async (request, response, next) => {
    try {
        const mode = String(request.body?.email_notifications || "");
        if (!EMAIL_MODES.includes(mode)) {
            return response.status(400).json({ error: "email_notifications must be one of " + EMAIL_MODES.join(", ") });
        }
        await query("update users set email_notifications = $1 where id = $2",
            [mode, request.user.id]);
        response.json({ email_notifications: mode });
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
