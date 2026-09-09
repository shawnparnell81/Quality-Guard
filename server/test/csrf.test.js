/* ============================================================
   CSRF defence (audit fix C3).

   A state-changing /api request from a signed-in session must look
   same-origin - its Origin (or Referer) has to be this host - and,
   when it looks like a browser request, carry the qg_csrf token that
   GET /api/me handed out, echoed in X-CSRF-Token and matching the
   cookie. A caller with no Origin and no Referer is not a browser
   and passes (it is not a CSRF vector); the SameSite=Lax session
   cookie and requireAuth are what stop it doing anything.

   Separately: GET /api/lpa no longer rolls schedules forward. That
   is a write, so it moved to POST /api/lpa/roll and a server timer.
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
const PORT = 3143;
const BASE = "http://localhost:" + PORT;
const ORIGIN = BASE;   // the server's own origin

let serverProcess;
let bootLog = "";
let tenant;
let session;   // qg_session cookie value
let csrf;      // qg_csrf token value

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
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "CSRF Test " + stamp,
        adminEmail: "csrf.admin." + stamp + "@example.test", adminName: "CSRF Admin"
    });

    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: tenant.admin.email, password: tenant.temporaryPassword })
    });
    session = cookieValue(login.headers.get("set-cookie"), "qg_session");
    assert.ok(session, "login set a session cookie");

    const changed = await fetch(BASE + "/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "qg_session=" + session },
        body: JSON.stringify({
            current_password: tenant.temporaryPassword, new_password: "Csrf-Test-Passphrase-1x"
        })
    });
    assert.equal(changed.status, 200);

    /* the SPA's first call - a GET - is where the token is issued */
    const me = await fetch(BASE + "/api/me", { headers: { Cookie: "qg_session=" + session } });
    csrf = cookieValue(me.headers.get("set-cookie"), "qg_csrf");
    assert.ok(csrf, "GET /api/me issued a qg_csrf token");
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

/* GET /api/me on a session that already holds the token does not
   mint a second one - it stays stable for the session. */
test("the CSRF token is issued once and stays stable", async () => {
    const again = await fetch(BASE + "/api/me", {
        headers: { Cookie: "qg_session=" + session + "; qg_csrf=" + csrf }
    });
    assert.equal(cookieValue(again.headers.get("set-cookie"), "qg_csrf"), null,
        "no fresh token when one is already held");
});

test("a same-origin write with a matching token succeeds", async () => {
    const r = await fetch(BASE + "/api/lpa/roll", {
        method: "POST",
        headers: {
            Origin: ORIGIN,
            Cookie: "qg_session=" + session + "; qg_csrf=" + csrf,
            "X-CSRF-Token": csrf
        }
    });
    assert.equal(r.status, 200);
});

test("a browser write with no token is refused", async () => {
    const r = await fetch(BASE + "/api/lpa/roll", {
        method: "POST",
        headers: { Origin: ORIGIN, Cookie: "qg_session=" + session + "; qg_csrf=" + csrf }
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "csrf");
});

test("a browser write with a wrong token is refused", async () => {
    const r = await fetch(BASE + "/api/lpa/roll", {
        method: "POST",
        headers: {
            Origin: ORIGIN,
            Cookie: "qg_session=" + session + "; qg_csrf=" + csrf,
            "X-CSRF-Token": "not-the-real-token"
        }
    });
    assert.equal(r.status, 403);
});

test("a cross-site Origin is refused even with a stolen-looking token", async () => {
    const r = await fetch(BASE + "/api/lpa/roll", {
        method: "POST",
        headers: {
            Origin: "https://evil.example",
            Cookie: "qg_session=" + session + "; qg_csrf=" + csrf,
            "X-CSRF-Token": csrf
        }
    });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "csrf");
});

test("a non-browser client (no Origin, no Referer) is not CSRF-checked", async () => {
    /* the token check only escalates for requests that look like a
       browser; a script with just the session cookie still works */
    const r = await fetch(BASE + "/api/lpa/roll", {
        method: "POST",
        headers: { Cookie: "qg_session=" + session }
    });
    assert.equal(r.status, 200);
});

test("a safe verb is never CSRF-checked", async () => {
    const r = await fetch(BASE + "/api/lpa", {
        headers: {
            Origin: "https://evil.example",
            Cookie: "qg_session=" + session
        }
    });
    assert.equal(r.status, 200);
});

/* ---- the LPA roll is no longer a GET side effect ---- */

test("GET /api/lpa does not roll schedules forward; POST /api/lpa/roll does", async () => {
    const auth = { Cookie: "qg_session=" + session };

    const tpl = await (await fetch(BASE + "/api/lpa/templates", {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Roll test" })
    })).json();
    await fetch(BASE + "/api/lpa/templates/" + tpl.id + "/questions", {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Is the area clean?" })
    });
    await fetch(BASE + "/api/lpa/schedules", {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
            template_id: tpl.id, layer: "Shift lead", area: "Cell 9",
            frequency_days: 7, start_on: "2020-01-01"   // long overdue
        })
    });

    /* a plain GET must NOT have materialised the overdue instance */
    const before = await (await fetch(BASE + "/api/lpa", { headers: auth })).json();
    assert.equal(before.audits.filter((a) => a.area === "Cell 9").length, 0,
        "GET left the overdue schedule alone");

    /* the explicit roll does */
    const rolled = await fetch(BASE + "/api/lpa/roll", { method: "POST", headers: auth });
    assert.equal(rolled.status, 200);

    const after = await (await fetch(BASE + "/api/lpa", { headers: auth })).json();
    assert.equal(after.audits.filter((a) => a.area === "Cell 9").length, 1,
        "POST /api/lpa/roll materialised it");
});
