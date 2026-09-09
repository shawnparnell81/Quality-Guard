/* ============================================================
   Security headers (audit fix C2).

   Every response - the API, the app shell, the static assets, the
   landing page - carries nosniff, DENY framing, a same-origin
   referrer policy, and an ENFORCED Content-Security-Policy. Every
   inline <script> was extracted to its own file, so script-src
   'self' holds with no 'unsafe-inline'. HSTS is only sent when
   NODE_ENV=production.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3139;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let bootLog = "";

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE + "\n" + bootLog);
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    await waitForHealth(15000);
});

after(() => { if (serverProcess) serverProcess.kill(); });

const paths = ["/api/health", "/app", "/", "/style.css"];

for (const path of paths) {
    test("security headers are present on " + path, async () => {
        const r = await fetch(BASE + path);
        assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
        assert.equal(r.headers.get("x-frame-options"), "DENY", path);
        assert.equal(r.headers.get("referrer-policy"), "same-origin", path);
        assert.equal(r.headers.get("cross-origin-opener-policy"), "same-origin", path);

        const csp = r.headers.get("content-security-policy");
        assert.ok(csp, path + " has an enforced CSP");
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /object-src 'none'/);
        assert.match(csp, /script-src 'self'/);
        /* script-src carries nothing that loosens it */
        assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
        assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);

        /* fully enforced now - no Report-Only variant */
        assert.equal(r.headers.get("content-security-policy-report-only"), null, path);
    });
}

test("HSTS is not sent outside production", async () => {
    /* the test runner starts the server with NODE_ENV unset / "test" */
    const r = await fetch(BASE + "/api/health");
    assert.equal(r.headers.get("strict-transport-security"), null);
});

/* The CSRF gate (audit fix C3) runs after requireAuth, so it only
   applies to signed-in sessions - see csrf.test.js for its coverage. */
