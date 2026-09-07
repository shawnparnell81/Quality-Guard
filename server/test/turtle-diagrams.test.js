/* ============================================================
   ISO 9001 turtle diagrams per department.

   Proves /api/turtle end to end: a department starts as an empty
   skeleton, a save fills the six sides, a read reflects it, the PDF
   comes back as a PDF, editing needs turtle.manage, and one tenant's
   turtle never leaks into another's.
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
const PORT = 3094;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let deniedCookie;

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
    const cookie = extractCookie(login);
    if (body.must_change_password) {
        await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: pw, new_password: "Turtle-Test-1x" })
        });
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
        companyName: "Turtle Test A " + stamp,
        adminEmail: "turtle.a." + stamp + "@example.test", adminName: "Turtle Admin A"
    });
    other = await provisionOrganization({
        companyName: "Turtle Test B " + stamp,
        adminEmail: "turtle.b." + stamp + "@example.test", adminName: "Turtle Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const noPerm = await query(`
        select r.key from roles r
         where r.org_id = $1 and not exists (
             select 1 from role_permissions rp
              where rp.org_id = r.org_id and rp.role_key = r.key and rp.permission_key = 'turtle.manage')
         limit 1
    `, [tenant.orgId]);
    const denied = await api(adminCookie, "POST", "/api/users", {
        full_name: "No Turtle", email: "noturtle." + stamp + "@example.test",
        initials: "NT" + (stamp % 100000), role: noPerm.rows[0].key
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    deniedCookie = await loginAs(denied.body.email || ("noturtle." + stamp + "@example.test"),
        denied.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a department starts as an empty skeleton", async () => {
    const r = await api(adminCookie, "GET", "/api/turtle/purchasing");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.exists, false);
    assert.equal(r.body.process_name, "Purchasing process");
    for (const side of ["inputs", "outputs", "resources", "people", "methods", "metrics"]) {
        assert.deepEqual(r.body.sides[side], []);
    }
});

test("an unknown department is rejected", async () => {
    const r = await api(adminCookie, "GET", "/api/turtle/marketing");
    assert.equal(r.status, 400);
});

test("saving fills the six sides and a read reflects it", async () => {
    const saved = await api(adminCookie, "PUT", "/api/turtle/purchasing", {
        process_name: "Supplier selection & control",
        process_desc: "From requisition to an approved supplier on the AVL.",
        sides: {
            inputs: ["Purchase requisition", "Approved supplier list"],
            outputs: ["Purchase order", "Approved vendor"],
            resources: ["ERP", "Supplier questionnaire"],
            people: ["Purchasing Manager", "Quality Engineer"],
            methods: ["SOP-0088 Supplier Approval", "  ", "Vendor scoring"],
            metrics: ["Supplier OTD %", "Supplier PPM"]
        }
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.exists, true);
    assert.equal(saved.body.process_name, "Supplier selection & control");
    // blank line dropped
    assert.deepEqual(saved.body.sides.methods.map((e) => e.text),
        ["SOP-0088 Supplier Approval", "Vendor scoring"]);
    assert.equal(saved.body.sides.metrics.length, 2);
    assert.ok(saved.body.updated_by);

    const read = await api(adminCookie, "GET", "/api/turtle/purchasing");
    assert.equal(read.body.sides.inputs[0].text, "Purchase requisition");
});

test("the list shows which processes have a turtle", async () => {
    const r = await api(adminCookie, "GET", "/api/turtle");
    assert.equal(r.status, 200);
    assert.equal(r.body.diagrams.length, 6);
    const purchasing = r.body.diagrams.find((d) => d.department === "purchasing");
    assert.equal(purchasing.exists, true);
    assert.equal(purchasing.entry_count, 12);
    const production = r.body.diagrams.find((d) => d.department === "production");
    assert.equal(production.exists, false);
});

test("the PDF comes back as a PDF", async () => {
    const pdf = await fetch(BASE + "/api/turtle/purchasing/pdf", { headers: { Cookie: adminCookie } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.ok(bytes.length > 500 && bytes.subarray(0, 4).toString() === "%PDF");
});

test("editing a turtle needs turtle.manage", async () => {
    const denied = await api(deniedCookie, "PUT", "/api/turtle/quality", {
        process_name: "should not save", sides: {}
    });
    assert.equal(denied.status, 403);
});

test("another tenant's turtle is invisible", async () => {
    const r = await api(otherCookie, "GET", "/api/turtle/purchasing");
    assert.equal(r.status, 200);
    assert.equal(r.body.exists, false);
    assert.deepEqual(r.body.sides.inputs, []);
});
