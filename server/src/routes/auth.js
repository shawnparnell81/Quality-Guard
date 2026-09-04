/* ============================================================
   Sign in, sign out, change password.

   Everything that happens here goes in the audit log, successes and
   failures alike. "Who was signed in when this record changed" and
   "was anyone trying passwords at 3am" are both questions somebody
   eventually asks.
   ============================================================ */

import { Router } from "express";
import { query, withTransaction } from "../db.js";
import {
    setSessionCookie, clearSessionCookie, requireAuth,
    SESSION_COOKIE, SESSION_HOURS
} from "../auth.js";
import { hashPassword, verifyPassword, checkPasswordStrength } from "../passwords.js";

export const auth = Router();

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/* Logging a failure must never say which half was wrong. "No such
   account" tells an attacker the email is worth attacking; "wrong
   password" confirms an account exists. Both get the same sentence. */
const REJECTED = "Email or password is not correct";

/* orgId is required: audit_log belongs to exactly one company, and an
   event with no company to attribute it to (an unknown email at the
   single, global login box) does not belong in any tenant's audit
   trail. See the unknown-email branch below for that case instead. */
async function recordAuthEvent(orgId, field, userId, detail) {
    await query(`
        insert into audit_log (org_id, entity, entity_id, field, new_value, changed_by)
        values ($1, 'auth', $2, $3, $4, $2)
    `, [orgId, userId, field, detail || null]).catch(() => {
        /* An audit write must not be able to block a sign-in. */
    });
}

/* POST /api/auth/login  { email, password } */
auth.post("/login", async (request, response, next) => {
    try {
        const { email, password } = request.body || {};

        if (!email || !password) {
            return response.status(400).json({ error: "Email and password are required" });
        }

        /* One global sign-in box for every company on the platform, so
           this looks a person up by email alone - email is unique
           across the whole system, not per organization, precisely so
           this query never needs to know which company someone means
           before it knows who they are. */
        const found = await query(`
            select id, org_id, full_name, initials, role, active,
                   password_hash, password_salt, must_change_password,
                   failed_attempts, locked_until
              from users
             where lower(email) = lower($1)
        `, [email]);

        const user = found.rows[0];

        /* Verify even when there is no such user, against a throwaway
           value. Returning instantly for unknown emails and slowly for
           known ones would let someone enumerate the staff list with a
           stopwatch. */
        if (!user) {
            await verifyPassword(password, "00".repeat(64), "decoy");

            /* No account, and so no company to attribute this to - the
               audit log is a tenant's own compliance record, not a
               platform security log. This still belongs somewhere, so
               it goes to the server log rather than being dropped. */
            console.warn("login_failed: unknown email " + String(email).slice(0, 200));

            return response.status(401).json({ error: REJECTED });
        }

        if (!user.active) {
            await recordAuthEvent(user.org_id, "login_denied", user.id, "account inactive");
            return response.status(401).json({ error: REJECTED });
        }

        if (user.locked_until && new Date(user.locked_until) > new Date()) {
            const minutes = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
            return response.status(429).json({
                error: "Too many failed attempts. Try again in " + minutes + " minutes."
            });
        }

        const ok = await verifyPassword(password, user.password_hash, user.password_salt);

        if (!ok) {
            const attempts = user.failed_attempts + 1;
            const lock = attempts >= MAX_ATTEMPTS;

            await query(`
                update users
                   set failed_attempts = $2,
                       locked_until = case when $3
                            then now() + ($4 || ' minutes')::interval
                            else locked_until end
                 where id = $1
            `, [user.id, lock ? 0 : attempts, lock, String(LOCK_MINUTES)]);

            await recordAuthEvent(user.org_id, "login_failed", user.id, "attempt " + attempts);

            return response.status(401).json({ error: REJECTED });
        }

        /* Success. A fresh session id, and the counter reset. */
        const session = await withTransaction(async (client) => {
            const created = await client.query(`
                insert into sessions (user_id, expires_at, ip, user_agent)
                values ($1, now() + ($2 || ' hours')::interval, $3, $4)
                returning id, expires_at
            `, [user.id, String(SESSION_HOURS),
                request.ip || null,
                (request.get("user-agent") || "").slice(0, 300)]);

            await client.query(`
                update users
                   set failed_attempts = 0, locked_until = null, last_login_at = now()
                 where id = $1
            `, [user.id]);

            return created.rows[0];
        });

        await recordAuthEvent(user.org_id, "login", user.id, null);

        setSessionCookie(response, session.id);

        response.json({
            name: user.full_name,
            initials: user.initials,
            must_change_password: user.must_change_password
        });
    } catch (error) {
        next(error);
    }
});

/* POST /api/auth/logout */
auth.post("/logout", async (request, response, next) => {
    try {
        if (request.user) {
            await query(
                "update sessions set revoked_at = now() where id = $1",
                [request.user.session_id]
            );
            await recordAuthEvent(request.user.org_id, "logout", request.user.id, null);
        }

        clearSessionCookie(response);
        response.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

/* POST /api/auth/change-password  { current_password, new_password }

   Changing a password revokes every other session for that person. If
   the reason for changing it is that somebody else knew it, leaving
   their session alive would defeat the point. */
auth.post("/change-password", requireAuth, async (request, response, next) => {
    try {
        const { current_password, new_password } = request.body || {};

        if (!current_password || !new_password) {
            return response.status(400).json({
                error: "Current and new password are both required"
            });
        }

        const weak = checkPasswordStrength(new_password);
        if (weak) return response.status(422).json({ error: weak });

        const found = await query(
            "select password_hash, password_salt from users where id = $1",
            [request.user.id]
        );

        const ok = await verifyPassword(
            current_password,
            found.rows[0].password_hash,
            found.rows[0].password_salt
        );

        if (!ok) {
            return response.status(401).json({ error: "Current password is not correct" });
        }

        const { hash, salt } = await hashPassword(new_password);

        await withTransaction(async (client) => {
            await client.query(`
                update users
                   set password_hash = $2, password_salt = $3,
                       must_change_password = false
                 where id = $1
            `, [request.user.id, hash, salt]);

            await client.query(`
                update sessions set revoked_at = now()
                 where user_id = $1 and id <> $2 and revoked_at is null
            `, [request.user.id, request.user.session_id]);
        });

        await recordAuthEvent(request.user.org_id, "password_changed", request.user.id, null);

        response.json({ ok: true, other_sessions_ended: true });
    } catch (error) {
        next(error);
    }
});

/* GET /api/auth/sessions
   Somebody's own live sessions, so they can see if an account is being
   used somewhere they do not recognise. */
auth.get("/sessions", requireAuth, async (request, response, next) => {
    try {
        const result = await query(`
            select id, created_at, last_seen_at, expires_at, ip, user_agent,
                   (id = $2) as current
              from sessions
             where user_id = $1 and revoked_at is null and expires_at > now()
             order by last_seen_at desc
        `, [request.user.id, request.user.session_id]);

        response.json({ sessions: result.rows });
    } catch (error) {
        next(error);
    }
});
