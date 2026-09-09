/* ============================================================
   Identity and permissions.

   Two separate jobs:

     WHO you are      -> a session row, found from an httpOnly cookie
     WHAT you may do  -> role_permissions in the database

   Sessions are stored server side rather than signed into a token so
   that access can genuinely be withdrawn. Deactivating somebody at
   09:00 must end their session at 09:00, not whenever a token would
   have expired on its own.
   ============================================================ */

import { randomUUID } from "node:crypto";

import { query } from "./db.js";

export const SESSION_COOKIE = "qg_session";
export const CSRF_COOKIE = "qg_csrf";
export const SESSION_HOURS = 12;

/* Express does not parse cookies on its own, and the whole job is
   five lines, so no dependency. */
export function readCookie(request, name) {
    const header = request.headers.cookie;
    if (!header) return null;

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;

        if (part.slice(0, index).trim() === name) {
            /* A malformed %-sequence here should mean "no session", not
               a 500 on every request a broken or hostile client sends. */
            try {
                return decodeURIComponent(part.slice(index + 1).trim());
            } catch {
                return null;
            }
        }
    }

    return null;
}

export function setSessionCookie(response, sessionId, hours = SESSION_HOURS) {
    const parts = [
        SESSION_COOKIE + "=" + sessionId,
        "Path=/",
        "HttpOnly",                       /* JavaScript cannot read it, so XSS cannot steal it */
        "SameSite=Lax",                   /* not sent on cross-site POSTs, which blunts CSRF */
        "Max-Age=" + hours * 3600
    ];

    /* Secure would stop the cookie working over plain http in
       development. In production this must always be on. */
    if (process.env.NODE_ENV === "production") parts.push("Secure");

    response.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(response) {
    response.setHeader("Set-Cookie", [
        SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        CSRF_COOKIE + "=; Path=/; SameSite=Lax; Max-Age=0"
    ]);
}

/* CSRF: the double-submit-cookie half (audit fix C3).

   qg_csrf carries a random token and is deliberately NOT HttpOnly -
   the SPA reads it and echoes it in an X-CSRF-Token header on every
   state-changing request (see requireCsrf). A cross-site page can
   neither read this cookie nor set that header, so it cannot produce
   a matching pair. SameSite=Lax stays on both cookies as the first
   line of defence; this is the belt to its braces, and the thing
   that still holds if a future route is a mutating GET.

   Appended, not set: the session cookie is written in the same
   response on login, and setHeader would clobber it. */
export function setCsrfCookie(response, token = randomUUID(), hours = SESSION_HOURS) {
    const parts = [
        CSRF_COOKIE + "=" + token,
        "Path=/",
        "SameSite=Lax",
        "Max-Age=" + hours * 3600
    ];
    if (process.env.NODE_ENV === "production") parts.push("Secure");
    response.append("Set-Cookie", parts.join("; "));
    return token;
}

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(urlString) {
    try { return new URL(urlString).host; }
    catch { return null; }
}

/* Rejects a state-changing request that looks cross-site (audit fix
   C3).

   The gate is Origin / Referer. A browser always attaches one to a
   state-changing request and a page cannot forge another site's
   value; when present it must be this same host. That, with the
   SameSite=Lax session cookie (which is not even sent on a
   cross-site POST) and no CORS, is what stops a forged write.

   For requests that already look like a browser (an Origin or
   Referer is set) the double-submit token is also required: the SPA
   reads the non-HttpOnly qg_csrf cookie and echoes it in
   X-CSRF-Token, and the two must match.

   A caller with no Origin and no Referer is not a browser
   navigation - a CSRF attack rides a browser - so a script, an
   integration or a test harness passes here and is gated by
   requireAuth alone. */
export function requireCsrf(request, response, next) {
    if (CSRF_SAFE_METHODS.has(request.method)) return next();

    const stated = request.headers.origin || request.headers.referer || null;
    if (!stated) return next();

    const from = hostOf(stated);
    const allowed = [request.headers.host, request.headers["x-forwarded-host"]]
        .filter(Boolean);
    if (!from || !allowed.includes(from)) {
        return response.status(403).json({
            error: "This request looks cross-site and was refused",
            code: "csrf"
        });
    }

    const cookie = readCookie(request, CSRF_COOKIE);
    const header = request.headers["x-csrf-token"];
    if (!cookie || !header || header !== cookie) {
        return response.status(403).json({
            error: "Missing or invalid CSRF token", code: "csrf"
        });
    }

    next();
}

/* Finds the person behind a request, or null.

   A session is only good if it exists, has not expired, has not been
   revoked, and belongs to somebody still active. Any one of those
   failing means no user. */
async function resolveUser(request) {
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (!sessionId) return null;

    /* An invalid uuid in the cookie would otherwise raise a database
       error on every request. */
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return null;

    /* r.key = u.role alone is not enough now that roles are per
       organization: two different companies can each have their own
       "quality_manager", and without pinning the join to the same
       org_id this would match whichever one happened to be found. */
    const result = await query(`
        select u.id, u.org_id, u.full_name, u.initials, u.role, u.active,
               u.must_change_password,
               r.name as role_name,
               s.id as session_id, s.expires_at
          from sessions s
          join users u on u.id = s.user_id
          join roles r on r.key = u.role and r.org_id = u.org_id
         where s.id = $1
           and s.revoked_at is null
           and s.expires_at > now()
           and u.active
    `, [sessionId]);

    if (result.rowCount === 0) return null;

    /* Cheap liveness record. Useful when an auditor asks who was
       signed in at the time a record changed. */
    query("update sessions set last_seen_at = now() where id = $1", [sessionId])
        .catch(() => { /* never fail a request over this */ });

    return result.rows[0];
}

/* Attaches request.user, request.permissions and request.can(). */
export async function identify(request, response, next) {
    try {
        const user = await resolveUser(request);

        if (!user) {
            request.user = null;
            request.permissions = new Set();
        } else {
            const granted = await query(
                "select permission_key from role_permissions where org_id = $1 and role_key = $2",
                [user.org_id, user.role]
            );

            request.user = user;
            request.permissions = new Set(granted.rows.map((row) => row.permission_key));

            /* Hand the SPA a CSRF token to echo on writes (audit fix
               C3). Set on GETs only - the auth POSTs carry their own
               credential and a write response is not where the client
               reads it - and only when the caller does not already
               hold one. The SPA's first call is GET /api/me, so it
               always has the token before its first write. */
            if (request.method === "GET"
                && !readCookie(request, CSRF_COOKIE)
                && !request.path.startsWith("/auth/")) {
                setCsrfCookie(response);
            }
        }

        request.can = (key) => request.permissions.has(key);
        next();
    } catch (error) {
        next(error);
    }
}

/* Requires a signed-in user, whatever their role. */
export function requireAuth(request, response, next) {
    if (!request.user) {
        return response.status(401).json({ error: "Sign in required" });
    }
    next();
}

/* Blocks everything until a forced password change is done.

   A temporary password has been spoken aloud, written on a note, or
   sent by email. Until it is replaced it is not a credential, it is a
   handover, so an account holding one can do nothing but replace it.

   428 Precondition Required, not 401 or 403: the session is perfectly
   valid and the role is irrelevant. Something has to happen first, and
   the client needs to tell that apart from being signed out. */
export function requirePasswordCurrent(request, response, next) {
    if (request.user && request.user.must_change_password) {
        return response.status(428).json({
            error: "You must set a new password before continuing",
            code: "password_change_required"
        });
    }
    next();
}

/* Guards a route with a permission.

   Takes a key, or a function that works one out from the request, so a
   single endpoint can demand different authority depending on what it
   is being asked to do. Choosing "Rework" and choosing "Use-as-is" go
   through the same route and are not the same decision. */
export function requirePermission(keyOrResolver) {
    return (request, response, next) => {
        const key = typeof keyOrResolver === "function"
            ? keyOrResolver(request)
            : keyOrResolver;

        if (!key) return next();

        if (!request.user) {
            return response.status(401).json({ error: "Sign in required" });
        }

        if (!request.can(key)) {
            return response.status(403).json({
                error: "Your role does not permit this",
                required: key,
                your_role: request.user.role_name
            });
        }

        next();
    };
}

/* Which permission a record type needs before someone may raise one. */
const CREATE_PERMISSION = {
    ncr:       "ncr.create",
    capa:      "capa.create",
    complaint: "complaint.create",
    scar:      "scar.issue",
    audit:     "audit.schedule",
    risk:      "risk.manage",
    eightd:    "capa.create",
    ecn:       "change.create",
    apqp:      "apqp.manage",
    di:        "di.manage",
    fair:      "fair.manage",
    ppap:      "ppap.manage"
};

export function createPermissionFor(request) {
    return CREATE_PERMISSION[request.body?.type] || null;
}

/* Closing a record is a different authority from opening one. */
const CLOSE_PERMISSION = {
    ncr:   "ncr.close",
    capa:  "capa.close",
    audit: "audit.close",
    di:    "di.close"
};

export function closePermissionFor(type) {
    return CLOSE_PERMISSION[type] || null;
}

/* Which permission a record type needs before someone may read one.
   Only the types the permission catalogue actually defines a ".read"
   for are listed - every other type stays readable by any signed-in
   user in the org, which is the behaviour before this map existed. 8D
   reads on capa.read, matching how its create borrows capa.create. */
const READ_PERMISSION = {
    ncr:       "ncr.read",
    capa:      "capa.read",
    eightd:    "capa.read",
    complaint: "complaint.read",
    audit:     "audit.read",
    risk:      "risk.read"
};

export function readPermissionFor(type) {
    return READ_PERMISSION[type] || null;
}

/* The record-type keys a caller may NOT read - used to scope the
   register when no ?type filter pins it to one. */
export function unreadableTypes(request) {
    return Object.entries(READ_PERMISSION)
        .filter(([, permission]) => !request.can(permission))
        .map(([type]) => type);
}
