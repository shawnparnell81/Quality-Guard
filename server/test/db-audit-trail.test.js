/* ============================================================
   Database-level audit trail (migration 044).

   A trigger on the records table writes a full before/after snapshot
   to record_audit on every INSERT / UPDATE / DELETE. The signed-in
   user is carried into the transaction (db.js requestContext ->
   set_config('app.user_id')) so the trigger can attribute the change;
   a change made straight through the database is logged with no user.

   GET /api/records/:number/audit reads it back, gated on roles.manage.
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
const PORT = 3135;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;      // general_manager: holds roles.manage
let operatorCookie;   // operator: does not
let adminUserId;

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
            body: JSON.stringify({ current_password: pw, new_password: "Audit-Trail-Passphrase-1x" })
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
        companyName: "Audit Trail A " + stamp,
        adminEmail: "audit.a." + stamp + "@example.test", adminName: "Audit Admin A"
    });
    other = await provisionOrganization({
        companyName: "Audit Trail B " + stamp,
        adminEmail: "audit.b." + stamp + "@example.test", adminName: "Audit Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    adminUserId = (await query("select id from users where email = $1", [tenant.admin.email])).rows[0].id;

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Audit Operator", email: "audit.op." + stamp + "@example.test",
        initials: "AO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("audit.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    /* record_audit has no FK to organizations (so the trail outlives
       an org), so clear it explicitly before dropping the tenants. */
    for (const t of [tenant, other]) {
        if (!t) continue;
        await query("delete from record_audit where org_id = $1", [t.orgId]);
        await query("delete from organizations where id = $1", [t.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let number;
let recordId;   // the uuid - every audit query keys on this, never on the (per-org) number

test("creating a record writes an INSERT row attributed to the caller", async () => {
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Porosity on lot 4471",
        data: { part_number: "RP-1", description: "surface porosity", disposition: "Rework" }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    number = made.body.number;
    recordId = (await query("select id from records where number = $1 and org_id = $2",
        [number, tenant.orgId])).rows[0].id;

    const rows = (await query(`
        select action_type, changed_by, record_type, record_number, old_values, new_values
          from record_audit where record_id = $1
    `, [recordId])).rows;

    assert.equal(rows.length, 1);
    assert.equal(rows[0].action_type, "INSERT");
    assert.equal(rows[0].changed_by, adminUserId, "attributed to the signed-in user");
    assert.equal(rows[0].record_type, "ncr");
    assert.equal(rows[0].record_number, number);
    assert.equal(rows[0].old_values, null);
    assert.equal(rows[0].new_values.title, "Porosity on lot 4471");
    assert.equal(rows[0].new_values.data.part_number, "RP-1");
});

test("editing a record writes an UPDATE row with a before and after", async () => {
    const patched = await api(adminCookie, "PATCH", "/api/records/" + number, {
        title: "Porosity on lot 4471 (contained)", reason: "containment done"
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const upd = (await query(`
        select changed_by, old_values, new_values from record_audit
         where record_id = $1 and action_type = 'UPDATE'
         order by id desc limit 1
    `, [recordId])).rows[0];

    assert.equal(upd.changed_by, adminUserId);
    assert.equal(upd.old_values.title, "Porosity on lot 4471");
    assert.equal(upd.new_values.title, "Porosity on lot 4471 (contained)");
});

test("GET /:number/audit returns the history newest-first, roles.manage only", async () => {
    const denied = await api(operatorCookie, "GET", "/api/records/" + number + "/audit");
    assert.equal(denied.status, 403, "an operator cannot read the raw audit log");

    const ok = await api(adminCookie, "GET", "/api/records/" + number + "/audit");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.number, number);
    assert.ok(ok.body.count >= 2);

    const actions = ok.body.entries.map((e) => e.action_type);
    assert.equal(actions[0], "UPDATE", "newest first");
    assert.ok(actions.includes("INSERT"));

    const first = ok.body.entries[0];
    assert.equal(first.nc_id && typeof first.nc_id, "string");
    assert.equal(first.changed_by, adminUserId);
    assert.equal(first.changed_by_name, "Audit Admin A");
    assert.ok(first.old_values && first.new_values);
});

test("another org's record is a 404", async () => {
    const otherAdmin = await loginAs(other.admin.email, other.temporaryPassword);
    const r = await api(otherAdmin, "GET", "/api/records/" + number + "/audit");
    assert.equal(r.status, 404);
});

test("a change made straight through the database is logged with no user", async () => {
    await query("update records set severity = 'warn' where id = $1", [recordId]);   // no request context

    const outOfBand = (await query(`
        select changed_by, new_values from record_audit
         where record_id = $1 and action_type = 'UPDATE'
         order by id desc limit 1
    `, [recordId])).rows[0];

    assert.equal(outOfBand.changed_by, null, "no app session -> no attributed user");
    assert.equal(outOfBand.new_values.severity, "warn");
});
