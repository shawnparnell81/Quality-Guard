/* ============================================================
   Per-organization layout for the dashboard and menu bar.

   One row per (org, kind). Any signed-in user can read it; changing
   it needs layout.manage. A null layout in a PUT resets to the
   built-in default. Proves all of that, plus that the two orgs'
   layouts are independent.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const PORT = 3103;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;   // provisioned admin = general_manager: holds layout.manage
let otherCookie;
let noManageCookie; // operator: no layout.manage

function extractCookie(r) {
    const raw = r.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

async function loginAs(email, pw) {
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pw })
    });
    assert.equal(login.status, 200, "login should succeed for " + email);
    const body = await login.json();
    let cookie = extractCookie(login);
    if (body.must_change_password) {
        const changed = await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: pw, new_password: "Layout-Test-Passphrase-1x" })
        });
        assert.equal(changed.status, 200, "forced password change should succeed");
        cookie = extractCookie(changed) || cookie;
    }
    return cookie;
}

async function api(cookie, method, path, payload) {
    const r = await fetch(BASE + path, {
        method, headers: { "Content-Type": "application/json", Cookie: cookie },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not always JSON */ }
    return { status: r.status, body };
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

const SAMPLE = {
    order: [
        { key: "events", col: 1 },
        { key: "suppliers", col: 0 },
        { key: "coming-due", col: 0 }
    ],
    hidden: ["training-gaps"]
};

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    let bootLog = "";
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("Test server exited early:\n" + bootLog);
    });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "Layout Test A " + stamp,
        adminEmail: "layout.a." + stamp + "@example.test", adminName: "Layout Admin A"
    });
    other = await provisionOrganization({
        companyName: "Layout Test B " + stamp,
        adminEmail: "layout.b." + stamp + "@example.test", adminName: "Layout Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Layout Operator", email: "layout.op." + stamp + "@example.test",
        initials: "LP" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noManageCookie = await loginAs(op.body.email || ("layout.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("an unset layout reads as null, and the admin can manage it", async () => {
    const got = await api(adminCookie, "GET", "/api/layout/dashboard");
    assert.equal(got.status, 200);
    assert.equal(got.body.layout, null);
    assert.equal(got.body.can_manage, true);
});

test("saving a layout stores it for the org and a read reflects it", async () => {
    const saved = await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: SAMPLE });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.layout, SAMPLE);

    const got = await api(adminCookie, "GET", "/api/layout/dashboard");
    assert.deepEqual(got.body.layout, SAMPLE);
    assert.ok(got.body.updated_at);
});

test("saving again replaces the previous layout", async () => {
    const next = { order: [{ key: "events", col: 0 }], hidden: [] };
    const saved = await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: next });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.layout, next);
});

test("a null layout resets to the default", async () => {
    const reset = await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: null });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.layout, null);

    const got = await api(adminCookie, "GET", "/api/layout/dashboard");
    assert.equal(got.body.layout, null);
});

test("the nav layout is a separate row", async () => {
    const navLayout = { departments: [{ name: "Quality", items: ["ncr", "capa"] }] };
    const saved = await api(adminCookie, "PUT", "/api/layout/nav", { layout: navLayout });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.layout, navLayout);

    /* the dashboard layout is untouched */
    const dash = await api(adminCookie, "GET", "/api/layout/dashboard");
    assert.equal(dash.body.layout, null);
});

test("a non-object layout is refused", async () => {
    const bad = await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: [1, 2, 3] });
    assert.equal(bad.status, 422);
    const bad2 = await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: "left" });
    assert.equal(bad2.status, 422);
});

test("an unknown layout kind is a 404", async () => {
    const get = await api(adminCookie, "GET", "/api/layout/sidebar");
    assert.equal(get.status, 404);
    const put = await api(adminCookie, "PUT", "/api/layout/sidebar", { layout: {} });
    assert.equal(put.status, 404);
});

test("changing a layout needs layout.manage; reading does not", async () => {
    const denied = await api(noManageCookie, "PUT", "/api/layout/dashboard", { layout: SAMPLE });
    assert.equal(denied.status, 403);

    const read = await api(noManageCookie, "GET", "/api/layout/dashboard");
    assert.equal(read.status, 200);
    assert.equal(read.body.can_manage, false);
});

test("one org's layout does not touch another's", async () => {
    await api(adminCookie, "PUT", "/api/layout/dashboard", { layout: SAMPLE });

    const otherGot = await api(otherCookie, "GET", "/api/layout/dashboard");
    assert.equal(otherGot.status, 200);
    assert.equal(otherGot.body.layout, null);
});
