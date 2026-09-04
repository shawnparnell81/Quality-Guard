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

import { query, DEMO_ORG_ID } from "./db.js";

export const SESSION_COOKIE = "qg_session";
export const SESSION_HOURS = 12;

/* Express does not parse cookies on its own, and the whole job is
   five lines, so no dependency. */
function readCookie(request, name) {
    const header = request.headers.cookie;
    if (!header) return null;

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;

        if (part.slice(0, index).trim() === name) {
            return decodeURIComponent(part.slice(index + 1).trim());
        }
    }

    return null;
}

export function setSessionCookie(response, sessionId) {
    const parts = [
        SESSION_COOKIE + "=" + sessionId,
        "Path=/",
        "HttpOnly",                       /* JavaScript cannot read it, so XSS cannot steal it */
        "SameSite=Lax",                   /* not sent on cross-site POSTs, which blunts CSRF */
        "Max-Age=" + SESSION_HOURS * 3600
    ];

    /* Secure would stop the cookie working over plain http in
       development. In production this must always be on. */
    if (process.env.NODE_ENV === "production") parts.push("Secure");

    response.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(response) {
    response.setHeader(
        "Set-Cookie",
        SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
    );
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
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;

    const result = await query(`
        select u.id, u.full_name, u.initials, u.role, u.active,
               u.must_change_password,
               r.name as role_name,
               s.id as session_id, s.expires_at
          from sessions s
          join users u on u.id = s.user_id
          join roles r on r.key = u.role
         where s.id = $1
           and s.revoked_at is null
           and s.expires_at > now()
           and u.active
           and u.org_id = $2
    `, [sessionId, DEMO_ORG_ID]);

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
                "select permission_key from role_permissions where role_key = $1",
                [user.role]
            );

            request.user = user;
            request.permissions = new Set(granted.rows.map((row) => row.permission_key));
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
    ecn:       "change.create"
};

export function createPermissionFor(request) {
    return CREATE_PERMISSION[request.body?.type] || null;
}

/* Closing a record is a different authority from opening one. */
const CLOSE_PERMISSION = {
    ncr:   "ncr.close",
    capa:  "capa.close",
    audit: "audit.close"
};

export function closePermissionFor(type) {
    return CLOSE_PERMISSION[type] || null;
}
