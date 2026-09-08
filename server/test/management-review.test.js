/* ============================================================
   Management review, clause 9.3 - the write side.

   The 9.3.2 input pack has always been auto-compiled; this covers the
   parts added to make it a working record: creating a review,
   attendance, 9.3.3 actions, linking an action to the CAPA carrying
   it out, the status walk, and the minutes PDF.

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
const PORT = 3110;
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
            body: JSON.stringify({ current_password: pw, new_password: "Review-Test-Passphrase-1x" })
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
        companyName: "Review Test A " + stamp,
        adminEmail: "review.a." + stamp + "@example.test", adminName: "Review Admin A"
    });
    other = await provisionOrganization({
        companyName: "Review Test B " + stamp,
        adminEmail: "review.b." + stamp + "@example.test", adminName: "Review Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Review Operator", email: "review.op." + stamp + "@example.test",
        initials: "RO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("review.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let reviewRef;

test("a review is created and its 9.3.2 pack has all twelve inputs", async () => {
    const created = await api(adminCookie, "POST", "/api/reviews",
        { period: "2026 Q3", held_on: "2026-08-15" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.reference, /^MR-\d{4}-\d{2}$/);
    reviewRef = created.body.reference;

    const pack = await api(adminCookie, "GET", "/api/reviews/" + reviewRef + "/inputs");
    assert.equal(pack.status, 200);
    const clauses = pack.body.inputs.map((i) => i.clause);
    for (const c of ["9.3.2 a", "9.3.2 b", "9.3.2 c1", "9.3.2 c2", "9.3.2 c3", "9.3.2 c4",
        "9.3.2 c5", "9.3.2 c6", "9.3.2 c7", "9.3.2 d", "9.3.2 e", "9.3.2 f"]) {
        assert.ok(clauses.includes(c), "9.3.2 pack has " + c);
    }
    assert.deepEqual(pack.body.attendance, []);
    assert.deepEqual(pack.body.actions, []);
});

test("attendance is recorded and removed", async () => {
    const added = await api(adminCookie, "POST", "/api/reviews/" + reviewRef + "/attendance",
        { name: "Dana Whitfield", role: "Quality Manager (chair)" });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    let pack = await api(adminCookie, "GET", "/api/reviews/" + reviewRef + "/inputs");
    assert.equal(pack.body.attendance.length, 1);
    assert.equal(pack.body.attendance[0].name, "Dana Whitfield");

    const removed = await api(adminCookie, "DELETE",
        "/api/reviews/" + reviewRef + "/attendance/" + added.body.id);
    assert.equal(removed.status, 200);

    pack = await api(adminCookie, "GET", "/api/reviews/" + reviewRef + "/inputs");
    assert.equal(pack.body.attendance.length, 0);
});

test("a 9.3.3 action links to the CAPA carrying it out", async () => {
    const action = await api(adminCookie, "POST", "/api/reviews/" + reviewRef + "/actions",
        { decision: "Tighten incoming inspection sampling on Nordvik castings", due_on: "2026-09-30" });
    assert.equal(action.status, 201, JSON.stringify(action.body));

    const capa = await api(adminCookie, "POST", "/api/records", {
        type: "capa", title: "Incoming sampling plan for Nordvik",
        data: { source: "Management review " + reviewRef, problem_statement: "Sampling too loose." }
    });
    assert.equal(capa.status, 201, JSON.stringify(capa.body));

    const linked = await api(adminCookie, "PATCH",
        "/api/reviews/" + reviewRef + "/actions/" + action.body.id,
        { status: "in_progress", linked_record: capa.body.number });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));

    const pack = await api(adminCookie, "GET", "/api/reviews/" + reviewRef + "/inputs");
    const row = pack.body.actions.find((a) => a.id === action.body.id);
    assert.equal(row.status, "in_progress");
    assert.equal(row.linked_record, capa.body.number);
    assert.ok(row.linked_status, "the linked CAPA's live status comes back with the action");
});

test("a review walks planned -> in progress -> closed", async () => {
    let moved = await api(adminCookie, "PATCH", "/api/reviews/" + reviewRef,
        { status: "in_progress", held_on: "2026-08-15" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.status, "in_progress");

    moved = await api(adminCookie, "PATCH", "/api/reviews/" + reviewRef, { status: "closed" });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.status, "closed");
});

test("the minutes export as a PDF", async () => {
    const r = await fetch(BASE + "/api/reviews/" + reviewRef + "/pdf", { headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), "%PDF");
    assert.ok(buf.length > 800, "the minutes PDF has content");
});

test("creating a review needs review.manage", async () => {
    const denied = await api(operatorCookie, "POST", "/api/reviews", { period: "2026 Q4" });
    assert.equal(denied.status, 403);
});

test("one org's review is invisible to another", async () => {
    const seen = await api(otherCookie, "GET", "/api/reviews/" + reviewRef + "/inputs");
    assert.equal(seen.status, 404);
});
