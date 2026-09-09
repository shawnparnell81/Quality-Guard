/* ============================================================
   Rate limiting (audit M12).

   Three layers: a generous global per-IP cap on /api, a strict
   per-IP cap on /api/auth (password-spray), and a per-user cap on
   the document endpoints (Excel / PDF / import). This spawns a
   server with deliberately tiny caps via env and proves each one
   trips with a 429 + Retry-After + code "rate_limited".

   Test order matters: the global bucket is shared, so the two
   targeted tests (which spend little of it) run first and the global
   burst runs last with headroom to spare.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3145;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let bootLog = "";
let tenant;
let session;

function cookieValue(setCookie, name) {
    if (!setCookie) return null;
    const m = new RegExp("(?:^|,\\s*)" + name + "=([^;]+)").exec(setCookie);
    return m ? m[1] : null;
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE + "\n" + bootLog);
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"], {
        cwd: serverRoot,
        env: {
            ...process.env,
            PORT: String(PORT),
            RATE_LIMIT_OFF: "",
            RATE_LIMIT_GLOBAL_PER_MIN: "250",
            RATE_LIMIT_AUTH_PER_15MIN: "6",
            RATE_LIMIT_HEAVY_PER_MIN: "5"
        },
        stdio: "pipe"
    });
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "RL Test " + stamp,
        adminEmail: "rl.admin." + stamp + "@example.test", adminName: "RL Admin"
    });
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: tenant.admin.email, password: tenant.temporaryPassword })
    });
    session = cookieValue(login.headers.get("set-cookie"), "qg_session");
    assert.ok(session);
    const changed = await fetch(BASE + "/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "qg_session=" + session },
        body: JSON.stringify({
            current_password: tenant.temporaryPassword, new_password: "Rl-Test-Passphrase-1x"
        })
    });
    assert.equal(changed.status, 200);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the /api/auth cap trips after RATE_LIMIT_AUTH_PER_15MIN", async () => {
    let sawLimit = null;
    for (let i = 0; i < 12; i++) {
        const r = await fetch(BASE + "/api/auth/login", {
            method: "POST", headers: { "Content-Type": "application/json" },
            /* a distinct unknown email each time - a 401 that never
               engages the per-account lockout, only the IP rate cap */
            body: JSON.stringify({ email: "spray-" + i + "@nope.test", password: "x" })
        });
        if (r.status === 429) { sawLimit = r; break; }
        assert.equal(r.status, 401, "before the cap, it is a normal auth failure");
    }
    assert.ok(sawLimit, "the auth cap eventually returned 429");
    assert.ok(Number(sawLimit.headers.get("retry-after")) > 0, "with a Retry-After");
    assert.equal((await sawLimit.json()).code, "rate_limited");
});

test("the document-endpoint cap trips per user after RATE_LIMIT_HEAVY_PER_MIN", async () => {
    let sawLimit = null;
    for (let i = 0; i < 12; i++) {
        const r = await fetch(BASE + "/api/records/NCR-DOES-NOT-EXIST/excel", {
            headers: { Cookie: "qg_session=" + session }
        });
        if (r.status === 429) { sawLimit = r; break; }
        assert.equal(r.status, 404, "before the cap, the missing record is a plain 404");
    }
    assert.ok(sawLimit, "the heavy-endpoint cap returned 429");
    assert.equal((await sawLimit.json()).code, "rate_limited");
});

test("a non-document endpoint is not touched by the heavy cap", async () => {
    /* the heavy test just spent its budget; an ordinary read still works */
    const r = await fetch(BASE + "/api/me", { headers: { Cookie: "qg_session=" + session } });
    assert.equal(r.status, 200);
});

test("the global per-IP cap trips on a burst", async () => {
    let sawLimit = false;
    for (let i = 0; i < 300; i++) {
        const r = await fetch(BASE + "/api/health");
        if (r.status === 429) {
            sawLimit = true;
            assert.ok(Number(r.headers.get("retry-after")) > 0);
            assert.equal((await r.json()).code, "rate_limited");
            break;
        }
    }
    assert.ok(sawLimit, "a long burst from one IP is eventually capped");
});
