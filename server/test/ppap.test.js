/* ============================================================
   PPAP submission package, clause 8.3.4.4.

   Checks the ppap record type provisions, that GET /api/ppap/:number
   returns the 18 element slots and the submit gate, that filling a
   slot (a reference or "not applicable") counts toward the gate, and
   that a package cannot move to "submitted" until every element its
   level requires is on file.

   Self-contained: provisions a throwaway org, runs the app on a spare
   port, cleans up after itself.
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
const PORT = 3111;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
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
            body: JSON.stringify({ current_password: pw, new_password: "Ppap-Test-Passphrase-1x" })
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
        companyName: "PPAP Test A " + stamp,
        adminEmail: "ppap.a." + stamp + "@example.test", adminName: "Ppap Admin A"
    });
    other = await provisionOrganization({
        companyName: "PPAP Test B " + stamp,
        adminEmail: "ppap.b." + stamp + "@example.test", adminName: "Ppap Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Ppap Operator", email: "ppap.op." + stamp + "@example.test",
        initials: "PO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("ppap.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

function newPpap(cookie, level = "Level 3") {
    return api(cookie, "POST", "/api/records", {
        type: "ppap", title: "PPAP - RP-4471-A rev D",
        data: { part_number: "RP-4471-A", part_name: "Housing", revision: "D",
            customer: "Voss Automotive", submission_level: level, reason: "Initial submission" }
    });
}

test("the ppap type provisions with its 8.3.4.4 form", async () => {
    const form = await api(adminCookie, "GET", "/api/record-types/ppap/form");
    assert.equal(form.status, 200, JSON.stringify(form.body));
    const fields = form.body.fields;
    assert.equal(fields.find((f) => f.key === "submission_level").required, true);
    assert.equal(fields.find((f) => f.key === "part_number").required, true);
    assert.equal(fields.find((f) => f.key === "customer").required, true);
    assert.ok([...new Set(fields.map((f) => f.section))].includes("Submission"));
});

test("GET /api/ppap returns the 18 elements and a submit gate", async () => {
    const created = await newPpap(adminCookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.number, /^PPAP-\d{4}-\d{4}$/);

    const pkg = await api(adminCookie, "GET", "/api/ppap/" + created.body.number);
    assert.equal(pkg.status, 200);
    assert.equal(pkg.body.elements.length, 18);
    assert.equal(pkg.body.level, 3);
    assert.equal(pkg.body.gate.ready_to_submit, false);
    /* Level 3 requires 13 elements; none filled yet. */
    assert.equal(pkg.body.gate.missing.length, 13);
    assert.equal(pkg.body.elements.find((e) => e.element === 7).name, "Control plan");
    assert.equal(pkg.body.elements.find((e) => e.element === 7).required, true);
    assert.equal(pkg.body.elements.find((e) => e.element === 15).required, false);
});

test("a Level 3 package will not submit until every required element is filled", async () => {
    const created = await newPpap(adminCookie);
    const number = created.body.number;

    let moved = await api(adminCookie, "POST", "/api/records/" + number + "/transition",
        { to: "assembling" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    /* Empty required elements block the submit. */
    let blocked = await api(adminCookie, "POST", "/api/records/" + number + "/transition",
        { to: "submitted" });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.ok(Array.isArray(blocked.body.missing) && blocked.body.missing.length === 13);

    /* Fill 12 with a reference, one (Design records) marked N/A. */
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18]) {
        const put = await api(adminCookie, "PUT", "/api/ppap/" + number + "/elements/" + n,
            { reference: "DOC-" + n });
        assert.equal(put.status, 200, "element " + n + ": " + JSON.stringify(put.body));
    }
    const na = await api(adminCookie, "PUT", "/api/ppap/" + number + "/elements/1",
        { not_applicable: true, note: "Customer provides the design record." });
    assert.equal(na.status, 200);

    const pkg = await api(adminCookie, "GET", "/api/ppap/" + number);
    assert.equal(pkg.body.gate.ready_to_submit, true, JSON.stringify(pkg.body.gate.missing));

    moved = await api(adminCookie, "POST", "/api/records/" + number + "/transition", { to: "submitted" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    /* Clearing a required element blocks it again. */
    await api(adminCookie, "DELETE", "/api/ppap/" + number + "/elements/7");
    const after = await api(adminCookie, "GET", "/api/ppap/" + number);
    assert.equal(after.body.gate.ready_to_submit, false);
});

test("a slot needs a reference unless it is marked not applicable", async () => {
    const created = await newPpap(adminCookie);
    const bad = await api(adminCookie, "PUT", "/api/ppap/" + created.body.number + "/elements/3", {});
    assert.equal(bad.status, 400);
});

test("a Level 1 package only needs the PSW", async () => {
    const created = await newPpap(adminCookie, "Level 1");
    const number = created.body.number;

    await api(adminCookie, "POST", "/api/records/" + number + "/transition", { to: "assembling" });
    await api(adminCookie, "PUT", "/api/ppap/" + number + "/elements/18", { reference: "PSW-001" });

    const moved = await api(adminCookie, "POST", "/api/records/" + number + "/transition", { to: "submitted" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
});

test("assembling a PPAP needs ppap.manage", async () => {
    const denied = await newPpap(operatorCookie);
    assert.equal(denied.status, 403);

    const mine = await newPpap(adminCookie);
    const putDenied = await api(operatorCookie, "PUT",
        "/api/ppap/" + mine.body.number + "/elements/18", { reference: "X" });
    assert.equal(putDenied.status, 403);
});

test("one org's PPAP is invisible to another", async () => {
    const mine = await newPpap(adminCookie);
    const seen = await api(otherCookie, "GET", "/api/ppap/" + mine.body.number);
    assert.equal(seen.status, 404);
});
