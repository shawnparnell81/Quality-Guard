/* ============================================================
   QUALITYGUARD API

   Start with:  npm start
   Health check: http://localhost:3001/api/health
   ============================================================ */

import express from "express";
import cors from "cors";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { pool } from "./db.js";
import { identify, requireAuth, requirePasswordCurrent } from "./auth.js";
import { auth } from "./routes/auth.js";
import { records } from "./routes/records.js";
import { masterdata } from "./routes/masterdata.js";
import { dashboard } from "./routes/dashboard.js";
import { access, meHandler } from "./routes/access.js";
import { production } from "./routes/production.js";
import { change } from "./routes/change.js";
import { engineering } from "./routes/engineering.js";
import { operations } from "./routes/operations.js";
import { evaluate } from "./routes/evaluate.js";

const app = express();
const PORT = Number(process.env.PORT || 3001);

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");

app.use(express.json({ limit: "1mb" }));

/* Serving the front end from this same server means the browser sees
   one origin, so there is no CORS to configure and ES modules load
   normally. Only the public folder is exposed, never server/.env. */
app.use(express.static(publicDir));

/* Kept for the case where the front end is served from somewhere else,
   such as the Live Server extension on port 5500. */
app.use(cors({
    origin: process.env.CLIENT_ORIGIN
        ? process.env.CLIENT_ORIGIN.split(",")
        : true
}));

/* One line per request. Enough to see what the front end is asking
   for without pulling in a logging library. */
app.use((request, response, next) => {
    const started = Date.now();
    response.on("finish", () => {
        console.log(
            request.method + " " + request.originalUrl
            + " " + response.statusCode
            + " " + (Date.now() - started) + "ms"
        );
    });
    next();
});

app.get("/api/health", async (request, response) => {
    try {
        const result = await pool.query("select now() as time, version() as version");
        response.json({
            status: "ok",
            database: "connected",
            time: result.rows[0].time,
            postgres: result.rows[0].version.split(",")[0]
        });
    } catch (error) {
        response.status(503).json({
            status: "degraded",
            database: "unreachable",
            detail: error.message
        });
    }
});

/* Identity is resolved for every API request before any route runs,
   so request.user and request.can() are always available. */
app.use("/api", identify);

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

app.use("/api/records", records);
app.use("/api/dashboard", dashboard);
app.use("/api", access);
app.use("/api", production);
app.use("/api", change);
app.use("/api", engineering);
app.use("/api", operations);
app.use("/api", evaluate);
app.use("/api", masterdata);

app.use((request, response) => {
    response.status(404).json({ error: "No route for " + request.method + " " + request.path });
});

/* Errors return a useful message in development and a generic one in
   production, because a database error string can leak schema detail. */
app.use((error, request, response, next) => {
    console.error(error);

    const inDevelopment = process.env.NODE_ENV !== "production";

    response.status(500).json({
        error: "Internal server error",
        detail: inDevelopment ? error.message : undefined
    });
});

const server = app.listen(PORT, () => {
    console.log("QualityGuard running on http://localhost:" + PORT);
    console.log("  App:    http://localhost:" + PORT + "/");
    console.log("  Health: http://localhost:" + PORT + "/api/health");
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
