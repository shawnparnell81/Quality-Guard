/* ============================================================
   Organisation onboarding state (P5.3).

   A fresh org reports onboarded:false with no standards; PATCH
   /api/organization updates the name and the (validated) standards
   list; onboarded:true latches on and survives; an empty patch is a
   400; and it all needs roles.manage.
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
const PORT = 3122;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let operatorCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Onb-Test-Passphrase-1x" })
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
        companyName: "Onboarding Test " + stamp,
        adminEmail: "onb.admin." + stamp + "@example.test", adminName: "Onb Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Onb Operator", email: "onb.op." + stamp + "@example.test",
        initials: "OO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("onb.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a fresh org is not onboarded and has no standards", async () => {
    const r = await api(adminCookie, "GET", "/api/organization");
    assert.equal(r.status, 200);
    assert.equal(r.body.onboarded, false);
    assert.deepEqual(r.body.standards, []);
});

test("PATCH updates the name and validates the standards list", async () => {
    const r = await api(adminCookie, "PATCH", "/api/organization", {
        name: "Ridgeline Machining",
        standards: ["ISO 9001", "IATF 16949", "Made Up 12345", "ISO 9001"]
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, "Ridgeline Machining");
    assert.deepEqual([...r.body.standards].sort(), ["ISO 9001", "IATF 16949"].sort());
    assert.equal(r.body.onboarded, false);

    const check = await api(adminCookie, "GET", "/api/organization");
    assert.equal(check.body.organization, "Ridgeline Machining");
});

test("onboarded:true latches and survives further reads", async () => {
    const done = await api(adminCookie, "PATCH", "/api/organization", { onboarded: true });
    assert.equal(done.body.onboarded, true);

    const again = await api(adminCookie, "PATCH", "/api/organization", { name: "Ridgeline Machining Co" });
    assert.equal(again.body.onboarded, true, "still onboarded after another patch");

    const get = await api(adminCookie, "GET", "/api/organization");
    assert.equal(get.body.onboarded, true);
});

test("an empty patch and a blank name are rejected", async () => {
    assert.equal((await api(adminCookie, "PATCH", "/api/organization", {})).status, 400);
    assert.equal((await api(adminCookie, "PATCH", "/api/organization", { name: "   " })).status, 400);
});

test("it needs roles.manage", async () => {
    const r = await api(operatorCookie, "PATCH", "/api/organization", { name: "nope" });
    assert.equal(r.status, 403);
});
