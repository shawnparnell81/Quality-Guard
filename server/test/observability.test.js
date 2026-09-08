/* ============================================================
   Logging, errors, health (P4.3).

   /api/health carries version + uptime and a database ping;
   /api/ready is the readiness probe; every response carries an
   X-Request-Id (an inbound one is honoured); the single error
   handler keeps a route's own status code and puts request_id in
   the body; and the request logger emits one JSON line per request.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3119;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let bootLog = "";

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    await waitForHealth(15000);
});

after(() => {
    if (serverProcess) serverProcess.kill();
});

test("/api/health reports version, uptime and the database", async () => {
    const r = await fetch(BASE + "/api/health");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.status, "ok");
    assert.equal(body.database, "connected");
    assert.equal(typeof body.version, "string");
    assert.equal(typeof body.uptime_s, "number");
    assert.ok(body.uptime_s >= 0);
    assert.match(body.node, /^v\d/);
});

test("/api/ready is a 200 readiness probe", async () => {
    const r = await fetch(BASE + "/api/ready");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ready, true);
    assert.equal(body.database, "connected");
});

test("every response carries an X-Request-Id, and an inbound one is kept", async () => {
    const fresh = await fetch(BASE + "/api/health");
    assert.match(fresh.headers.get("x-request-id") || "", /[0-9a-f-]{36}/);

    const carried = await fetch(BASE + "/api/health", {
        headers: { "X-Request-Id": "trace-abc-123" }
    });
    assert.equal(carried.headers.get("x-request-id"), "trace-abc-123");
});

test("the 404 handler names the route and includes the request id", async () => {
    /* a non-/api path: an unknown /api/* path is a 401 from requireAuth,
       which never reaches the 404 handler. */
    const r = await fetch(BASE + "/definitely-not-here");
    assert.equal(r.status, 404);
    const body = await r.json();
    assert.match(body.error, /No route for GET \/definitely-not-here/);
    assert.equal(body.request_id, r.headers.get("x-request-id"));
});

test("the error handler keeps a route's status and returns request_id", async () => {
    const r = await fetch(BASE + "/api/_diag/boom", { headers: { "X-Request-Id": "boom-1" } });
    assert.equal(r.status, 418, "the error's own status, not a blanket 500");
    const body = await r.json();
    assert.equal(body.request_id, "boom-1");
    assert.equal(body.error, "intentional test error");   // <500 -> real message

    /* and it was logged as a structured line, with the id and status */
    await sleep(100);
    const errorLine = bootLog.split("\n").reverse()
        .find((l) => l.includes("request_error") && l.includes("boom-1"));
    assert.ok(errorLine, "an error log line was emitted");
    const parsed = JSON.parse(errorLine);
    assert.equal(parsed.level, "warn");        // 4xx -> warn
    assert.equal(parsed.status, 418);
    assert.equal(parsed.err.status, 418);
});

test("each request logs one structured JSON line", async () => {
    await fetch(BASE + "/api/health", { headers: { "X-Request-Id": "log-check-1" } });
    await sleep(100);

    const line = bootLog.split("\n").reverse()
        .find((l) => l.includes('"msg":"request"') && l.includes("log-check-1"));
    assert.ok(line, "a request log line was emitted");
    const parsed = JSON.parse(line);
    assert.equal(parsed.method, "GET");
    assert.equal(parsed.path, "/api/health");
    assert.equal(parsed.status, 200);
    assert.equal(typeof parsed.ms, "number");
    assert.equal(parsed.request_id, "log-check-1");
    assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
});
