/* ============================================================
   Clone a record (forms rework 4/5).

   POST /api/records/:number/clone makes a new record of the same
   type seeded with this one's data - the part-family workflow. This
   checks the copy carries header fields and table rows, recomputes
   computed columns, takes an optional new title, is owned by the
   caller, drops a SCAR's triggered_by link, and is confined to the
   caller's org.
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
const PORT = 3124;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let adminInitials;

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
            body: JSON.stringify({ current_password: pw, new_password: "Clone-Test-Passphrase-1x" })
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
        companyName: "Clone Test A " + stamp,
        adminEmail: "clone.a." + stamp + "@example.test", adminName: "Clone Admin A"
    });
    other = await provisionOrganization({
        companyName: "Clone Test B " + stamp,
        adminEmail: "clone.b." + stamp + "@example.test", adminName: "Clone Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);
    adminInitials = (await api(adminCookie, "GET", "/api/me")).body.initials;

    const install = await api(adminCookie, "POST", "/api/form-templates/pfmea/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let sourceNumber;

test("a clone carries header fields, table rows and recomputed RPN", async () => {
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "pfmea", title: "OP20 bore PFMEA",
        data: {
            process_name: "OP20 bore", process_responsibility: "Mfg Eng",
            analysis: [
                { process_step: "Load", failure_mode: "Not seated", severity: 8, occurrence: 4, detection: 6 },
                { process_step: "Bore", failure_mode: "Oversize", severity: 7, occurrence: 5, detection: 3 }
            ]
        }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    sourceNumber = made.body.number;

    const clone = await api(adminCookie, "POST", "/api/records/" + sourceNumber + "/clone");
    assert.equal(clone.status, 201, JSON.stringify(clone.body));
    assert.match(clone.body.number, /^PFMEA-\d{4}-\d{4}$/);
    assert.notEqual(clone.body.number, sourceNumber);
    assert.equal(clone.body.cloned_from, sourceNumber);

    const rec = await api(adminCookie, "GET", "/api/records/" + clone.body.number);
    assert.equal(rec.body.record.title, "Copy of OP20 bore PFMEA");
    assert.equal(rec.body.record.data.process_name, "OP20 bore");
    assert.equal(rec.body.record.data.analysis.length, 2);
    assert.equal(rec.body.record.data.analysis[0].rpn, 8 * 4 * 6);
    assert.equal(rec.body.record.owner_initials, adminInitials, "the caller owns the copy");
});

test("a clone can take a new title, and its own edits do not touch the source", async () => {
    const clone = await api(adminCookie, "POST", "/api/records/" + sourceNumber + "/clone",
        { title: "OP20 bore PFMEA rev B" });
    assert.equal(clone.body.number && clone.status, 201);

    await api(adminCookie, "PATCH", "/api/records/" + clone.body.number,
        { data: { process_name: "OP20 bore - CHANGED" }, reason: "edit the copy" });

    const src = await api(adminCookie, "GET", "/api/records/" + sourceNumber);
    assert.equal(src.body.record.data.process_name, "OP20 bore", "source is untouched");

    const cl = await api(adminCookie, "GET", "/api/records/" + clone.body.number);
    assert.equal(cl.body.record.title, "OP20 bore PFMEA rev B");
});

test("cloning a SCAR drops triggered_by so the copy does not re-link", async () => {
    const ncr = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Porosity", data: { disposition: "Rework" }
    });
    const scar = await api(adminCookie, "POST", "/api/records", {
        type: "scar", title: "Supplier porosity",
        data: { supplier: "Nordvik", part_number: "RP-1",
            defect_description: "Porosity over Class 2", triggered_by: ncr.body.number }
    });
    assert.equal(scar.status, 201, JSON.stringify(scar.body));

    const clone = await api(adminCookie, "POST", "/api/records/" + scar.body.number + "/clone");
    assert.equal(clone.status, 201);

    const cl = await api(adminCookie, "GET", "/api/records/" + clone.body.number);
    assert.equal(cl.body.record.data.triggered_by, undefined);
    assert.equal(cl.body.links.length, 0, "no caused_by link on the copy");
});

test("an unknown number and another org's record are both 404", async () => {
    assert.equal((await api(adminCookie, "POST", "/api/records/PFMEA-1999-0001/clone")).status, 404);
    assert.equal((await api(otherCookie, "POST", "/api/records/" + sourceNumber + "/clone")).status, 404);
});
