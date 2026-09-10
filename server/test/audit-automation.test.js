/* ============================================================
   Internal + In-Process audit automation.

   Internal: an `audit` record with a failing checklist answer, run the
   automation -> the four-folder tree on disk, one DI raised and linked,
   a scored PDF report, automation_logs keyed by record_id; re-run is
   idempotent (no second DI).

   In-process: an LPA template + audit, answer a check `fail`, complete
   the audit -> the completion response carries an automation summary,
   an NCR was raised and written back to lpa_answers.ncr_number, the
   folder tree + report exist, logs keyed by lpa_audit_id; re-run does
   not raise a second NCR.

   Plus the derived phase, the permission gates and tenant isolation.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";
import { STORAGE_ROOT } from "../src/file-storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");

const PORT = 3127;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let operatorCookie;   // lpa.read, not lpa.audit; no audit.read
let qiCookie;         // audit.read, not audit.schedule
let templateId;

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
            body: JSON.stringify({ current_password: pw, new_password: "Audit-Auto-Test-1x" })
        });
        assert.equal(changed.status, 200);
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

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
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
        companyName: "Audit Auto A " + stamp,
        adminEmail: "aa.a." + stamp + "@example.test", adminName: "Audit Auto Admin A"
    });
    other = await provisionOrganization({
        companyName: "Audit Auto B " + stamp,
        adminEmail: "aa.b." + stamp + "@example.test", adminName: "Audit Auto Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Audit Operator", email: "aa.op." + stamp + "@example.test",
        initials: "AO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("aa.op." + stamp + "@example.test"),
        op.body.temporary_password);

    const qe = await api(adminCookie, "POST", "/api/users", {
        full_name: "Audit QI", email: "aa.qi." + stamp + "@example.test",
        initials: "AQ" + (stamp % 100000), role: "quality_inspector"
    });
    assert.equal(qe.status, 201, JSON.stringify(qe.body));
    qiCookie = await loginAs(qe.body.email || ("aa.qi." + stamp + "@example.test"),
        qe.body.temporary_password);

    /* One shared LPA template + question bank - internal audits point
       their checklist_template_id at it too. */
    const t = await api(adminCookie, "POST", "/api/lpa/templates",
        { name: "Process audit checklist", description: "shared" });
    assert.equal(t.status, 201, JSON.stringify(t.body));
    templateId = t.body.id;
    for (const [text, critical] of [
        ["Work instruction at the station is current", false],
        ["Operator can state the key characteristic", true],
        ["First-off inspection recorded this shift", false]
    ]) {
        const q = await api(adminCookie, "POST",
            "/api/lpa/templates/" + templateId + "/questions", { text, critical });
        assert.equal(q.status, 201, JSON.stringify(q.body));
    }
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

/* ---------------- internal audits ---------------- */

let auditNumber;

test("internal: an audit with a failing checklist runs the full automation", async () => {
    const created = await api(adminCookie, "POST", "/api/records", {
        type: "audit", title: "Q3 machining area audit",
        data: { scope: "Machining", auditor: "L. Grant" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    auditNumber = created.body.number;
    assert.match(auditNumber, /^AUD-\d{4}-\d{4}$/);

    const patched = await api(adminCookie, "PATCH", "/api/records/" + auditNumber, {
        data: {
            checklist_template_id: templateId,
            checklist: [
                { text: "Work instruction current", result: "pass" },
                { text: "Operator can state the KC", result: "fail", note: "unsure of tolerance" },
                { text: "First-off recorded", result: "pass" }
            ]
        }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const run = await api(adminCookie, "POST", "/api/audits/" + auditNumber + "/automation/run");
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(run.body.steps.map((s) => s.step),
        ["folders", "checklist", "findings", "actions", "report"]);
    assert.ok(run.body.steps.every((s) => s.status === "done"),
        JSON.stringify(run.body.steps));
});

test("internal: the folder tree, DI link, report and phase", async () => {
    const summary = await api(adminCookie, "GET", "/api/audits/" + auditNumber + "/automation");
    assert.equal(summary.status, 200);
    const root = summary.body.folder_root;

    for (const name of ["01_Checklists", "02_Findings", "03_Actions", "04_Reports"]) {
        assert.ok(await exists(join(STORAGE_ROOT, "audit-folders", root, name)),
            name + " should exist on disk");
    }
    assert.ok(await exists(join(STORAGE_ROOT, "audit-folders", root, "04_Reports", "audit-report.pdf")));

    const rec = await api(adminCookie, "GET", "/api/records/" + auditNumber);
    const di = rec.body.links.find((l) => l.type === "di");
    assert.ok(di, "a DI is linked child_of the audit");

    assert.equal(summary.body.kind, "internal");
    assert.equal(summary.body.phase, "Actions Assigned");
    assert.equal(summary.body.score.pass, 2);
    assert.equal(summary.body.score.total, 3);
    assert.equal(summary.body.steps.filter((s) => s.status === "done").length, 5);

    const logs = await api(adminCookie, "GET", "/api/audits/" + auditNumber + "/automation/logs");
    assert.ok(logs.body.count >= 5);
    assert.ok(logs.body.logs.every((l) => l.run_source === "manual"));
});

test("internal: re-running does not raise a second DI", async () => {
    const before = await api(adminCookie, "GET", "/api/records/" + auditNumber);
    const diCountBefore = before.body.links.filter((l) => l.type === "di").length;
    assert.equal(diCountBefore, 1);

    const rerun = await api(adminCookie, "POST", "/api/audits/" + auditNumber + "/automation/run");
    assert.equal(rerun.status, 200);
    const findings = rerun.body.steps.find((s) => s.step === "findings");
    assert.equal(findings.status, "skipped");

    const after = await api(adminCookie, "GET", "/api/records/" + auditNumber);
    assert.equal(after.body.links.filter((l) => l.type === "di").length, 1);
});

test("internal: a single step runs standalone; ?force regenerates the report", async () => {
    const one = await api(adminCookie, "POST",
        "/api/audits/" + auditNumber + "/automation/report?force=true");
    assert.equal(one.status, 200);
    assert.equal(one.body.steps[0].step, "report");
    assert.equal(one.body.steps[0].status, "done");

    const bad = await api(adminCookie, "POST", "/api/audits/" + auditNumber + "/automation/nope");
    assert.equal(bad.status, 400);
});

test("internal: auto-fires on the schedule transition", async () => {
    const created = await api(adminCookie, "POST", "/api/records", {
        type: "audit", title: "Auto-fire audit", data: { scope: "Assembly" }
    });
    const num = created.body.number;
    await api(adminCookie, "PATCH", "/api/records/" + num,
        { data: { checklist_template_id: templateId } });

    const rec = await api(adminCookie, "GET", "/api/records/" + num);
    const toScheduled = rec.body.transitions.find((t) => t.to === "scheduled");
    assert.ok(toScheduled, "audit can move to scheduled");
    const moved = await api(adminCookie, "POST", "/api/records/" + num + "/transition",
        { to: "scheduled" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const summary = await api(adminCookie, "GET", "/api/audits/" + num + "/automation");
    assert.equal(summary.body.phase, "Checklist Generated");
    const byStep = Object.fromEntries(summary.body.steps.map((s) => [s.step, s.status]));
    assert.equal(byStep.folders, "done");
    assert.equal(byStep.checklist, "done");
    assert.equal(byStep.findings, "pending");
});

/* ---------------- in-process (LPA) audits ---------------- */

let lpaAuditId;

test("in-process: completing an audit auto-raises an NCR for a failed check", async () => {
    const adhoc = await api(adminCookie, "POST", "/api/lpa/audits",
        { template_id: templateId, layer: "Shift supervisor", area: "Cell 7" });
    assert.equal(adhoc.status, 201, JSON.stringify(adhoc.body));
    lpaAuditId = adhoc.body.id;

    const full = await api(adminCookie, "GET", "/api/lpa/audits/" + lpaAuditId);
    const qids = full.body.questions.map((q) => q.question_id);
    await api(adminCookie, "PUT", "/api/lpa/audits/" + lpaAuditId + "/answers/" + qids[0], { result: "pass" });
    await api(adminCookie, "PUT", "/api/lpa/audits/" + lpaAuditId + "/answers/" + qids[1],
        { result: "fail", note: "could not answer" });
    await api(adminCookie, "PUT", "/api/lpa/audits/" + lpaAuditId + "/answers/" + qids[2], { result: "pass" });

    const done = await api(adminCookie, "POST", "/api/lpa/audits/" + lpaAuditId + "/complete");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.automation, "the completion response carries an automation summary");
    assert.ok(done.body.automation.steps.every((s) => s.status === "done"),
        JSON.stringify(done.body.automation.steps));

    const after = await api(adminCookie, "GET", "/api/lpa/audits/" + lpaAuditId);
    const failed = after.body.questions.find((q) => q.question_id === qids[1]);
    assert.match(failed.ncr_number, /^NCR-\d{4}-\d{4}$/, "an NCR number was written back");
});

test("in-process: folder tree, report, logs and phase", async () => {
    const summary = await api(adminCookie, "GET", "/api/lpa/audits/" + lpaAuditId + "/automation");
    assert.equal(summary.status, 200);
    assert.equal(summary.body.kind, "in_process");
    assert.equal(summary.body.phase, "Closed");
    assert.equal(summary.body.score.pass, 2);
    assert.equal(summary.body.score.total, 3);

    const root = summary.body.folder_root;
    for (const name of ["01_Checklists", "02_Findings", "03_Actions", "04_Reports"]) {
        assert.ok(await exists(join(STORAGE_ROOT, "audit-folders", root, name)), name);
    }
    assert.ok(await exists(join(STORAGE_ROOT, "audit-folders", root, "04_Reports", "audit-report.pdf")));

    const logs = await api(adminCookie, "GET", "/api/lpa/audits/" + lpaAuditId + "/automation/logs");
    assert.ok(logs.body.count >= 5);
    assert.ok(logs.body.logs.some((l) => l.run_source === "auto"));
});

test("in-process: re-running does not raise a second NCR", async () => {
    const before = await query(
        "select count(*)::int n from records r join record_types rt on rt.id = r.record_type_id "
        + "where r.org_id = $1 and rt.key = 'ncr'", [tenant.orgId]);

    const rerun = await api(adminCookie, "POST",
        "/api/lpa/audits/" + lpaAuditId + "/automation/run");
    assert.equal(rerun.status, 200);
    assert.equal(rerun.body.steps.find((s) => s.step === "findings").status, "done");

    const after = await query(
        "select count(*)::int n from records r join record_types rt on rt.id = r.record_type_id "
        + "where r.org_id = $1 and rt.key = 'ncr'", [tenant.orgId]);
    assert.equal(after.rows[0].n, before.rows[0].n, "no new NCR on the second run");
});

/* ---------------- gates ---------------- */

test("reading automation is allowed where running it is not", async () => {
    /* quality_engineer: audit.read but not audit.schedule */
    const okInternal = await api(qiCookie, "GET",
        "/api/audits/" + auditNumber + "/automation/logs");
    assert.equal(okInternal.status, 200);
    const noInternal = await api(qiCookie, "POST",
        "/api/audits/" + auditNumber + "/automation/run", {});
    assert.equal(noInternal.status, 403);

    /* operator: lpa.read but not lpa.audit */
    const okLpa = await api(operatorCookie, "GET",
        "/api/lpa/audits/" + lpaAuditId + "/automation");
    assert.equal(okLpa.status, 200);
    const noLpa = await api(operatorCookie, "POST",
        "/api/lpa/audits/" + lpaAuditId + "/automation/run", {});
    assert.equal(noLpa.status, 403);
});

test("another tenant gets 404 on every automation route", async () => {
    const paths = [
        ["GET", "/api/audits/" + auditNumber + "/automation"],
        ["POST", "/api/audits/" + auditNumber + "/automation/run"],
        ["GET", "/api/lpa/audits/" + lpaAuditId + "/automation"],
        ["POST", "/api/lpa/audits/" + lpaAuditId + "/automation/run"]
    ];
    for (const [method, path] of paths) {
        const r = await api(otherCookie, method, path, method === "POST" ? {} : undefined);
        assert.equal(r.status, 404, method + " " + path);
    }
});
