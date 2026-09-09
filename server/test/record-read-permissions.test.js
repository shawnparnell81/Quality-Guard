/* ============================================================
   Record read permissions (P0 audit fix H6).

   The <type>.read permissions were seeded and used in the nav but
   never enforced on the record path. Now: a ?type the caller cannot
   read is 403; GET /:number for a type they cannot read is 403; the
   untyped register and the command-palette search are silently
   narrowed to the types they can read. Types with no .read permission
   in the catalogue (scar, di, ecn, ...) stay open.
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
const PORT = 3140;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;    // general_manager — holds every .read
let operatorCookie; // holds ncr.read + capa.read, NOT complaint.read

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
            body: JSON.stringify({ current_password: pw, new_password: "Read-Perms-Test-1x" })
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

let complaintNo;
let ncrNo;

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
        companyName: "Read Perms " + stamp,
        adminEmail: "rp.admin." + stamp + "@example.test", adminName: "RP Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "RP Operator", email: "rp.op." + stamp + "@example.test",
        initials: "RP" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("rp.op." + stamp + "@example.test"),
        op.body.temporary_password);

    const c = await api(adminCookie, "POST", "/api/records", {
        type: "complaint", title: "Squealing brake kit ZEBRAWIDGET",
        data: { customer: "Voss Automotive", description: "noise complaint from field" }
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    complaintNo = c.body.number;

    const n = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Bore oversize ZEBRAWIDGET", data: { disposition: "Rework" }
    });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    ncrNo = n.body.number;
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a type the caller cannot read is 403 on detail and on ?type=", async () => {
    const detail = await api(operatorCookie, "GET", "/api/records/" + complaintNo);
    assert.equal(detail.status, 403);
    assert.equal(detail.body.required, "complaint.read");

    const list = await api(operatorCookie, "GET", "/api/records?type=complaint");
    assert.equal(list.status, 403);
    assert.equal(list.body.required, "complaint.read");
});

test("a type the caller CAN read is still fine", async () => {
    const detail = await api(operatorCookie, "GET", "/api/records/" + ncrNo);
    assert.equal(detail.status, 200);

    const list = await api(operatorCookie, "GET", "/api/records?type=ncr");
    assert.equal(list.status, 200);
    assert.ok(list.body.records.some((r) => r.number === ncrNo));
});

test("the untyped register is narrowed to readable types", async () => {
    const list = await api(operatorCookie, "GET", "/api/records?limit=500");
    assert.equal(list.status, 200);
    assert.ok(list.body.records.some((r) => r.number === ncrNo), "sees the NCR");
    assert.ok(!list.body.records.some((r) => r.number === complaintNo), "does not see the complaint");
});

test("command-palette search does not surface unreadable records", async () => {
    const seen = await api(operatorCookie, "GET", "/api/records/search?q=ZEBRAWIDGET");
    assert.equal(seen.status, 200);
    const numbers = seen.body.records.map((r) => r.number);
    assert.ok(numbers.includes(ncrNo));
    assert.ok(!numbers.includes(complaintNo));
});

test("an admin with the permission reads normally", async () => {
    assert.equal((await api(adminCookie, "GET", "/api/records/" + complaintNo)).status, 200);
    assert.equal((await api(adminCookie, "GET", "/api/records?type=complaint")).status, 200);
});
