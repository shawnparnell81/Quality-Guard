/* ============================================================
   Daily notification digest (P3.5).

   Once a day, every user who set email_notifications = 'digest' gets
   one email listing what is currently on their notification feed.
   Nothing is sent when SMTP is not configured, or when a user's feed
   is empty.

   No cron: a self-arming timer fires at DIGEST_HOUR (local, default
   07:00) and re-arms 24h later. The run itself is behind a Postgres
   advisory lock (audit H8), so with more than one instance armed
   only one actually sends the digest.
   ============================================================ */

import { query } from "./db.js";
import { sendMail, isMailConfigured } from "./mail.js";
import { syncNotifications } from "./routes/notifications.js";
import { runOnce, JOB_LOCKS } from "./job-lock.js";

const KIND_HEADING = {
    assigned: "Assigned to you",
    overdue: "Overdue",
    approval: "Waiting for your approval",
    finding: "Open audit findings"
};

function composeDigest(fullName, items) {
    const byKind = new Map();
    for (const item of items) {
        if (!byKind.has(item.kind)) byKind.set(item.kind, []);
        byKind.get(item.kind).push(item);
    }

    const lines = ["Hi " + (fullName || "there") + ",", "",
        "Your QMS Guardian summary for today:", ""];
    for (const [kind, heading] of Object.entries(KIND_HEADING)) {
        const group = byKind.get(kind);
        if (!group || group.length === 0) continue;
        lines.push(heading + " (" + group.length + ")");
        for (const item of group) {
            lines.push("  - " + item.title + (item.body ? " - " + item.body : ""));
        }
        lines.push("");
    }
    lines.push("Open the app to act on these.");
    return lines.join("\n");
}

/* Run one pass. Returns a summary; pass { send } to capture instead
   of really mailing (tests). */
export async function runDigestOnce({ send = sendMail } = {}) {
    const users = await query(`
        select id, org_id, email, role, full_name
          from users
         where email_notifications = 'digest' and active and coalesce(email, '') <> ''
    `);

    const sent = [];
    for (const user of users.rows) {
        const perms = await query(
            "select permission_key from role_permissions where org_id = $1 and role_key = $2",
            [user.org_id, user.role]);
        const permissions = new Set(perms.rows.map((r) => r.permission_key));

        await syncNotifications(user, permissions);

        const feed = await query(`
            select kind, title, body from notifications
             where user_id = $1 and read_at is null
             order by created_at desc
        `, [user.id]);

        if (feed.rows.length === 0) continue;

        await send({
            to: user.email,
            subject: "[QMS Guardian] Your daily summary - " + feed.rows.length + " item"
                + (feed.rows.length === 1 ? "" : "s"),
            text: composeDigest(user.full_name, feed.rows)
        });
        sent.push({ email: user.email, count: feed.rows.length });
    }

    return { considered: users.rowCount, sent };
}

function msUntilNextRun(hour, now = new Date()) {
    const next = new Date(now);
    next.setHours(hour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
}

let timer = null;

export function startDigestSchedule() {
    if (!isMailConfigured()) {
        console.log("[digest] SMTP not configured - daily digest disabled.");
        return;
    }
    const hour = Number(process.env.DIGEST_HOUR);
    const runHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 7;

    const arm = () => {
        timer = setTimeout(async () => {
            try {
                let summary;
                const { ran } = await runOnce(JOB_LOCKS.digest, async () => { summary = await runDigestOnce(); });
                if (ran) {
                    console.log("[digest] sent " + summary.sent.length + " of "
                        + summary.considered + " opted-in users");
                } else {
                    console.log("[digest] another instance is sending today's digest");
                }
            } catch (error) {
                console.error("[digest] run failed: " + error.message);
            }
            arm();
        }, msUntilNextRun(runHour));
        if (typeof timer.unref === "function") timer.unref();
    };
    arm();
    console.log("[digest] daily digest armed for " + String(runHour).padStart(2, "0") + ":00 local");
}
