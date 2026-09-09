/* ============================================================
   QMS GUARDIAN API

   Start with:  npm start
   Health check: http://localhost:3001/api/health
   ============================================================ */

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { pool, requestContext } from "./db.js";
import { log } from "./logger.js";
import { identify, requireAuth, requirePasswordCurrent } from "./auth.js";
import { auth } from "./routes/auth.js";
import { records } from "./routes/records.js";
import { masterdata } from "./routes/masterdata.js";
import { dashboard, metrics } from "./routes/dashboard.js";
import { access, meHandler } from "./routes/access.js";
import { production } from "./routes/production.js";
import { change } from "./routes/change.js";
import { engineering } from "./routes/engineering.js";
import { operations } from "./routes/operations.js";
import { evaluate } from "./routes/evaluate.js";
import { turtle } from "./routes/turtle.js";
import { apqp } from "./routes/apqp.js";
import { reviewCharts } from "./routes/review-charts.js";
import { di } from "./routes/di.js";
import { ppap } from "./routes/ppap.js";
import { lpa } from "./routes/lpa.js";
import { logs } from "./routes/logs.js";
import { layout } from "./routes/layout.js";
import { formImport } from "./routes/form-import.js";
import { notifications } from "./routes/notifications.js";
import { formTemplates } from "./routes/form-templates.js";
import { streamHandler } from "./stream.js";
import { startDigestSchedule } from "./digest.js";

const app = express();
const PORT = Number(process.env.PORT || 3001);

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");
const startedAt = Date.now();

const VERSION = (() => {
    try {
        return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
    } catch { return "unknown"; }
})();

/* Can we actually talk to Postgres right now? Shared by /api/health
   and /api/ready. */
async function checkDatabase() {
    try {
        const result = await pool.query("select version() as version");
        return { ok: true, postgres: result.rows[0].version.split(",")[0] };
    } catch (error) {
        return { ok: false, detail: error.message };
    }
}

app.use(express.json({ limit: "1mb" }));

/* Security headers on every response - the static pages, the app
   shell and the API alike. Hand-rolled rather than pull in a
   dependency for a handful of setHeader calls, the same posture the
   cookie parser in auth.js takes.

   The CSP ships Report-Only: it blocks nothing, but a browser reports
   any resource the policy would have refused, so the inline <script>
   blocks still in login.html / change-password.html / landing.html
   show up as the work to do before it can be enforced. style-src
   keeps 'unsafe-inline' on purpose - the front end leans on style=""
   attributes and dynamically built inline styles, and style injection
   is a far smaller risk than script. HSTS is only sent in production,
   never over plain http in development. */
const CONTENT_SECURITY_POLICY = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: https://images.pexels.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com"
].join("; ");

app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    response.setHeader("Content-Security-Policy-Report-Only", CONTENT_SECURITY_POLICY);
    if (process.env.NODE_ENV === "production") {
        response.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    next();
});

/* The public address is the pitch, not the product. Visiting the bare
   domain shows the landing page; the working application only lives
   at /app, which nobody reaches without going through sign-in first
   (the app's own client-side session check bounces straight to
   /login.html for anyone not authenticated). */
app.get("/", (request, response) => {
    response.sendFile(join(publicDir, "landing.html"));
});

/* Both /app and /app/ land here (non-strict routing). index.html now
   uses absolute asset URLs (/style.css, /js/app.js) so a trailing
   slash no longer resolves them against /app/ and 404s. */
app.get("/app", (request, response) => {
    response.set("Cache-Control", "no-store");
    response.sendFile(join(publicDir, "index.html"));
});

/* Serving the front end from this same server means the browser sees
   one origin, so there is no CORS to configure and ES modules load
   normally. Only the public folder is exposed, never server/.env.

   index: false because / is handled above, deliberately, rather than
   express.static's own default of serving index.html for a directory
   request - that default is exactly the behaviour being turned off.

   This is not only convenience: the session cookie is SameSite=Lax
   and the API client sends credentials: "same-origin", so a front end
   served from a different origin (Live Server on :5500, say) could
   never actually authenticate against this API. Cross-origin support
   was removed rather than half-fixed; open the app at this server's
   own URL during development.

   no-store on the app's own JS/CSS/HTML: there is no build step and
   no asset hashing here, so a cached app.js after an update is a
   recurring "why isn't my change showing" trap. These files are
   small and same-origin - correctness beats the few saved KB. */
app.use(express.static(publicDir, {
    index: false,
    setHeaders(response, filePath) {
        if (/\.(?:js|css|html)$/i.test(filePath)) {
            response.setHeader("Cache-Control", "no-store");
        }
    }
}));

/* Every request gets an id (an inbound X-Request-Id is honoured so a
   proxy's trace carries through), echoed back on the response and
   attached to its log line and any error it raises. One structured
   line per request on finish - info, or warn/error for 4xx/5xx. */
app.use((request, response, next) => {
    const started = Date.now();
    const id = request.headers["x-request-id"] || randomUUID();
    request.id = id;
    response.setHeader("X-Request-Id", id);

    response.on("finish", () => {
        const status = response.statusCode;
        const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
        log[level]("request", {
            request_id: id,
            method: request.method,
            path: request.originalUrl,
            status,
            ms: Date.now() - started,
            user_id: request.user?.id,
            org_id: request.user?.org_id
        });
    });
    next();
});

/* Health: process up, and a quick database ping. 200 when both are
   fine, 503 when the database is unreachable. This is the endpoint a
   person or a simple monitor hits to ask "is it okay?". */
app.get("/api/health", async (request, response) => {
    const db = await checkDatabase();
    response.status(db.ok ? 200 : 503).json({
        status: db.ok ? "ok" : "degraded",
        version: VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        node: process.version,
        database: db.ok ? "connected" : "unreachable",
        postgres: db.postgres,
        detail: db.ok ? undefined : db.detail
    });
});

/* Readiness: the k8s-style probe. Same database check, minimal body,
   200 ready / 503 not - so an orchestrator holds traffic off a node
   until it can actually answer. */
app.get("/api/ready", async (request, response) => {
    const db = await checkDatabase();
    response.status(db.ok ? 200 : 503).json({
        ready: db.ok,
        database: db.ok ? "connected" : "unreachable",
        detail: db.ok ? undefined : db.detail
    });
});

/* Non-production only: raise a known error so the single error
   handler below can be exercised end to end. Unauthenticated on
   purpose - it only exists to prove the error envelope. */
if (process.env.NODE_ENV !== "production") {
    app.get("/api/_diag/boom", () => {
        throw Object.assign(new Error("intentional test error"), { status: 418 });
    });
}

/* Identity is resolved for every API request before any route runs,
   so request.user and request.can() are always available. */
app.use("/api", identify);

/* Carry the signed-in user through the request's async chain so a
   write transaction can tell the database who is acting (the
   record_audit trigger reads it). Runs for the whole /api subtree,
   including unauthenticated calls - the store just has no user then. */
app.use("/api", (request, response, next) => {
    requestContext.run({ userId: request.user?.id }, next);
});

/* Sign-in has to be reachable without being signed in. */
app.use("/api/auth", auth);

/* Everything past this line requires a session. Guarding it in one
   place means a new route cannot be left unprotected by accident,
   which is the usual way this goes wrong. */
app.use("/api", requireAuth);

/* /api/me stays reachable while a password change is outstanding, so
   the change-password screen can greet somebody by name. */
app.get("/api/me", meHandler);

/* And past this line, an outstanding password change blocks the lot. */
app.use("/api", requirePasswordCurrent);

/* Live change feed (SSE). A single handler, not a router - it holds
   the connection open and streams { entity, id, action } for the
   caller's org until the tab closes. */
app.get("/api/stream", streamHandler);

app.use("/api/records", records);
app.use("/api/dashboard", dashboard);
app.use("/api", metrics);
app.use("/api", access);
app.use("/api", production);
app.use("/api", change);
app.use("/api", engineering);
app.use("/api", operations);
app.use("/api", evaluate);
app.use("/api", turtle);
app.use("/api", apqp);
app.use("/api", reviewCharts);
app.use("/api", di);
app.use("/api", ppap);
app.use("/api", lpa);
app.use("/api", logs);
app.use("/api", layout);
app.use("/api", formImport);
app.use("/api", formTemplates);
app.use("/api", notifications);
app.use("/api", masterdata);

app.use((request, response) => {
    response.status(404).json({
        error: "No route for " + request.method + " " + request.path,
        request_id: request.id
    });
});

/* One error handler for the whole app. The status comes from the
   error (routes set 4xx deliberately - a bad file type, a missing
   field); anything without one is a real 500. The stack is always
   logged with the request id; the client sees the error's own
   message for a 4xx, and a generic line for a 5xx unless this is a
   development server (a database error string can leak schema
   detail). */
app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);

    const status = Number(error.status || error.statusCode) || 500;
    const level = status >= 500 ? "error" : "warn";
    log[level]("request_error", {
        request_id: request.id,
        method: request.method,
        path: request.originalUrl,
        status,
        err: error
    });

    const inDevelopment = process.env.NODE_ENV !== "production";
    const clientMessage = status < 500
        ? error.message
        : (inDevelopment ? error.message : "Internal server error");

    response.status(status).json({
        error: clientMessage,
        request_id: request.id,
        ...(status >= 500 && inDevelopment ? { detail: error.message } : {})
    });
});

const server = app.listen(PORT, () => {
    console.log("QMS Guardian running on http://localhost:" + PORT);
    console.log("  Landing: http://localhost:" + PORT + "/");
    console.log("  App:     http://localhost:" + PORT + "/app");
    console.log("  Health:  http://localhost:" + PORT + "/api/health");
    console.log("  Ready:   http://localhost:" + PORT + "/api/ready");

    /* Several protections are gated on NODE_ENV=production and default
       to OFF: the Secure flag on the session cookie, hiding 5xx detail
       from clients, HSTS, and the guard that ignores the 30-day
       "remember me" session. Silent in dev is fine; silent on a real
       deployment is the foot-gun. Say so, loudly, once. */
    if (process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test") {
        console.warn(
            "\n  !!  NODE_ENV is not \"production\".\n"
            + "  !!  Secure cookies, 5xx-detail suppression, HSTS and the\n"
            + "  !!  remember-me guard are ALL DISABLED. Set NODE_ENV=production\n"
            + "  !!  for any deployment reachable off localhost.\n"
        );
    }

    log.info("server_started", { port: PORT, version: VERSION, node: process.version });
    startDigestSchedule();
});

/* A dev server that fails to bind looks identical to one that is
   running - the old page stays on screen - right up until you notice
   nothing you change takes effect. The usual cause is a second
   `npm run dev` left over from earlier. Say that plainly and exit,
   rather than dumping a listen EADDRINUSE stack trace that buries the
   one useful line. Any other listen error is unexpected, so rethrow
   it and let the process crash with its real trace. */
server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
        console.error(
            "\nPort " + PORT + " is already in use - another QMS Guardian"
            + " server is probably still running.\n"
            + "Stop it first (Ctrl+C in its terminal), or on Windows:\n"
            + "  powershell -Command \"$c = Get-NetTCPConnection -LocalPort "
            + PORT + " -State Listen -ErrorAction SilentlyContinue;"
            + " if ($c) { Stop-Process -Id $c.OwningProcess -Force }\"\n"
        );
        process.exit(1);
    }
    throw error;
});

/* Close the pool cleanly so Postgres does not keep the connections
   until they time out. */
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        console.log("\nShutting down.");
        server.close(async () => {
            await pool.end();
            process.exit(0);
        });
    });
}
