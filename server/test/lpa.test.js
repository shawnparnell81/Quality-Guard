/* ============================================================
   Layered Process Audit, IATF 16949 clause 9.2.2.

   Covers: templates and their question bank, a schedule that rolls
   forward on GET /api/lpa into an audit instance, answering pass /
   fail / n-a with a linked NCR on a fail, completing an audit, a
   past-due schedule producing a missed audit, and the LPA health
   block on the dashboard.

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
const PORT = 3112;
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
            body: JSON.stringify({ current_password: pw, new_password: "Lpa-Test-Passphrase-1x" })
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

const isoDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
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
        companyName: "LPA Test A " + stamp,
        adminEmail: "lpa.a." + stamp + "@example.test", adminName: "Lpa Admin A"
    });
    other = await provisionOrganization({
        companyName: "LPA Test B " + stamp,
        adminEmail: "lpa.b." + stamp + "@example.test", adminName: "Lpa Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Lpa Operator", email: "lpa.op." + stamp + "@example.test",
        initials: "LO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("lpa.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let templateId;
let questionIds = [];

test("a template and its question bank", async () => {
    const t = await api(adminCookie, "POST", "/api/lpa/templates",
        { name: "Machining cell daily", description: "Shift start checks" });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    templateId = t.body.id;

    for (const [text, critical] of [
        ["Work instruction at the station is the current revision", false],
        ["Operator can state the key characteristic and its tolerance", true],
        ["First-off inspection recorded this shift", false]
    ]) {
        const q = await api(adminCookie, "POST", "/api/lpa/templates/" + templateId + "/questions",
            { text, critical });
        assert.equal(q.status, 201, JSON.stringify(q.body));
        questionIds.push(q.body.id);
    }

    const full = await api(adminCookie, "GET", "/api/lpa/templates/" + templateId);
    assert.equal(full.body.questions.length, 3);
    assert.equal(full.body.questions.find((q) => q.critical).text.startsWith("Operator can state"), true);
});

test("a schedule rolls forward into an audit on GET /api/lpa", async () => {
    const s = await api(adminCookie, "POST", "/api/lpa/schedules", {
        template_id: templateId, layer: "Shift supervisor", area: "Cell 4",
        frequency_days: 7, start_on: new Date().toISOString().slice(0, 10)
    });
    assert.equal(s.status, 201, JSON.stringify(s.body));

    const board = await api(adminCookie, "GET", "/api/lpa");
    assert.equal(board.status, 200);
    const audit = board.body.audits.find((a) => a.area === "Cell 4");
    assert.ok(audit, "an audit was materialised for the due schedule");
    assert.equal(audit.status, "scheduled");

    /* next_due moved a week out, so a second read does not duplicate. */
    const sched = board.body.schedules.find((x) => x.area === "Cell 4");
    assert.notEqual(sched.next_due.slice(0, 10), new Date().toISOString().slice(0, 10));
    const again = await api(adminCookie, "GET", "/api/lpa");
    assert.equal(again.body.audits.filter((a) => a.area === "Cell 4").length, 1);
});

test("answering pass / fail / n-a scores the audit and a fail can raise an NCR", async () => {
    const board = await api(adminCookie, "GET", "/api/lpa");
    const auditId = board.body.audits.find((a) => a.area === "Cell 4").id;

    let full = await api(adminCookie, "GET", "/api/lpa/audits/" + auditId);
    const qids = full.body.questions.map((q) => q.question_id);

    await api(adminCookie, "PUT", "/api/lpa/audits/" + auditId + "/answers/" + qids[0], { result: "pass" });
    await api(adminCookie, "PUT", "/api/lpa/audits/" + auditId + "/answers/" + qids[2], { result: "na", note: "no run this shift" });

    const ncr = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Operator could not state the KC tolerance",
        data: { detection_point: "Internal audit", disposition: "Rework" }
    });
    assert.equal(ncr.status, 201, JSON.stringify(ncr.body));

    const failed = await api(adminCookie, "PUT", "/api/lpa/audits/" + auditId + "/answers/" + qids[1],
        { result: "fail", note: "asked twice, unsure", ncr_number: ncr.body.number });
    assert.equal(failed.status, 200);

    full = await api(adminCookie, "GET", "/api/lpa/audits/" + auditId);
    assert.equal(full.body.status, "in_progress");
    assert.equal(full.body.score_pass, 1);
    assert.equal(full.body.score_total, 2, "n-a is not counted in the total");
    assert.equal(full.body.questions.find((q) => q.question_id === qids[1]).ncr_number, ncr.body.number);

    /* Every question answered - now it can complete. */
    const done = await api(adminCookie, "POST", "/api/lpa/audits/" + auditId + "/complete");
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const after = await api(adminCookie, "GET", "/api/lpa/audits/" + auditId);
    assert.equal(after.body.status, "complete");
    assert.ok(after.body.performed_on);
});

test("completing before every question is answered is refused", async () => {
    const adhoc = await api(adminCookie, "POST", "/api/lpa/audits",
        { template_id: templateId, layer: "Area manager", area: "Cell 9" });
    assert.equal(adhoc.status, 201);

    const blocked = await api(adminCookie, "POST", "/api/lpa/audits/" + adhoc.body.id + "/complete");
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /unanswered/);
});

test("a past-due schedule produces a missed audit and shows on the dashboard", async () => {
    const s = await api(adminCookie, "POST", "/api/lpa/schedules", {
        template_id: templateId, layer: "Plant manager", area: "Cell 12",
        frequency_days: 3, start_on: isoDaysAgo(10)
    });
    assert.equal(s.status, 201);

    const board = await api(adminCookie, "GET", "/api/lpa");
    const missed = board.body.audits.find((a) => a.area === "Cell 12");
    assert.ok(missed, "the overdue schedule produced an audit");
    assert.equal(missed.status, "missed");
    assert.ok(board.body.stats.missed_30d >= 1);

    const dash = await api(adminCookie, "GET", "/api/dashboard");
    assert.ok(dash.body.lpa, "the dashboard carries an lpa block");
    assert.equal(typeof dash.body.lpa.open, "number");
    assert.ok(dash.body.lpa.overdue >= 1);
});

test("templates and schedules need lpa.manage; answering needs lpa.audit", async () => {
    const canRead = await api(operatorCookie, "GET", "/api/lpa");
    assert.equal(canRead.status, 200, "an operator can view LPAs (lpa.read)");

    const denied = await api(operatorCookie, "POST", "/api/lpa/templates", { name: "x" });
    assert.equal(denied.status, 403);

    const board = await api(adminCookie, "GET", "/api/lpa");
    const auditId = board.body.audits[0].id;
    const full = await api(adminCookie, "GET", "/api/lpa/audits/" + auditId);
    const noAnswer = await api(operatorCookie, "PUT",
        "/api/lpa/audits/" + auditId + "/answers/" + full.body.questions[0].question_id, { result: "pass" });
    assert.equal(noAnswer.status, 403);
});

test("one org's audit is invisible to another", async () => {
    const board = await api(adminCookie, "GET", "/api/lpa");
    const auditId = board.body.audits[0].id;
    const seen = await api(otherCookie, "GET", "/api/lpa/audits/" + auditId);
    assert.equal(seen.status, 404);
});
