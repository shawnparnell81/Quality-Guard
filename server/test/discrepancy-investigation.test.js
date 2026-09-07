/* ============================================================
   Discrepancy Investigation - the bridge from an internal audit
   finding to the corrective forms.

   Proves the chain end to end: an audit raises a DI (once); the DI
   carries the completed NCR / 8D / CAPA forms as controlled documents
   in three slots, filled by upload or by linking an existing
   document; a DI cannot close until all three are attached; an audit
   cannot close until its DI is closed; di.manage and di.close are
   enforced; and one tenant's audit or DI is invisible to another.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const PORT = 3092;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let noCloseCookie;
let noManageCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Di-Test-Passphrase-1x" })
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

function makePdf(caption) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [180, 180] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text(caption, 20, 80);
        doc.end();
    });
}

async function attachForm(cookie, diNumber, slot, { file, filename, document: docNumber }) {
    const form = new FormData();
    if (file) form.append("file", new Blob([file], { type: "application/pdf" }), filename || "form.pdf");
    if (docNumber) form.append("document", docNumber);
    const r = await fetch(BASE + "/api/di/" + diNumber + "/forms/" + slot, {
        method: "POST", headers: { Cookie: cookie }, body: form
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* */ }
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

/* Drive a DI open -> investigating -> linked_closure. */
async function toLinkedClosure(cookie, diNumber) {
    for (const to of ["investigating", "linked_closure"]) {
        const mv = await api(cookie, "POST", "/api/records/" + diNumber + "/transition", { to, reason: "t" });
        assert.equal(mv.status, 200, "DI -> " + to + ": " + JSON.stringify(mv.body));
    }
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
        companyName: "DI Test A " + stamp,
        adminEmail: "di.a." + stamp + "@example.test", adminName: "DI Admin A"
    });
    other = await provisionOrganization({
        companyName: "DI Test B " + stamp,
        adminEmail: "di.b." + stamp + "@example.test", adminName: "DI Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    /* A role with di.manage but NOT di.close, and one with neither. */
    const eng = await api(adminCookie, "POST", "/api/users", {
        full_name: "DI Engineer", email: "di.eng." + stamp + "@example.test",
        initials: "DE" + (stamp % 100000), role: "quality_engineer"
    });
    assert.equal(eng.status, 201, JSON.stringify(eng.body));
    noCloseCookie = await loginAs(eng.body.email || ("di.eng." + stamp + "@example.test"),
        eng.body.temporary_password);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "DI Operator", email: "di.op." + stamp + "@example.test",
        initials: "DO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noManageCookie = await loginAs(op.body.email || ("di.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

async function raiseAudit(cookie, scope) {
    const a = await api(cookie, "POST", "/api/records", {
        type: "audit", title: scope + " audit", data: { scope, auditor: "R. Vandermeer" }
    });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    return a.body.number;
}

test("an audit raises exactly one DI", async () => {
    const auditNum = await raiseAudit(adminCookie, "Machining");

    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Machining",
        finding: "Op 30 running without a released control plan"
    });
    assert.equal(di.status, 201, JSON.stringify(di.body));
    assert.match(di.body.number, /^DI-\d{4}-\d{4}$/);

    const dup = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Machining", finding: "x"
    });
    assert.equal(dup.status, 409);

    /* The audit now shows the DI as a linked child. */
    const auditGet = await api(adminCookie, "GET", "/api/records/" + auditNum);
    assert.ok(auditGet.body.links.some((l) => l.number === di.body.number && l.type === "di"),
        "audit links to its DI");
});

test("raising a DI needs di.manage; a missing finding is rejected", async () => {
    const auditNum = await raiseAudit(adminCookie, "Assembly");

    const denied = await api(noManageCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Assembly", finding: "y"
    });
    assert.equal(denied.status, 403);

    const incomplete = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Assembly"
    });
    assert.equal(incomplete.status, 422);
});

test("the DI carries three form slots, filled by upload or by link", async () => {
    const auditNum = await raiseAudit(adminCookie, "Plating");
    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Plating", finding: "Thickness out of spec, no reaction plan"
    });
    const diNum = di.body.number;

    let forms = await api(adminCookie, "GET", "/api/di/" + diNum + "/forms");
    assert.equal(forms.status, 200);
    assert.deepEqual(forms.body.forms.map((f) => f.slot), ["ncr", "eightd", "capa"]);
    assert.equal(forms.body.gate.all_attached, false);
    assert.deepEqual(forms.body.gate.missing.sort(), ["8D report", "CAPA form", "NCR form"]);

    /* Upload a completed NCR form. */
    const up = await attachForm(adminCookie, diNum, "ncr", {
        file: await makePdf("NCR form"), filename: "ncr.pdf"
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const ncrSlot = up.body.forms.find((f) => f.slot === "ncr");
    assert.match(ncrSlot.document.doc_number, /DI-.*-NCR/);

    /* Link an existing controlled document into the 8D slot. */
    const cd = new FormData();
    cd.append("doc_number", "8D-DONE-1");
    cd.append("title", "8D report - completed");
    cd.append("change_summary", "init");
    cd.append("file", new Blob([await makePdf("8D")], { type: "application/pdf" }), "8d.pdf");
    const cdRes = await fetch(BASE + "/api/documents", { method: "POST", headers: { Cookie: adminCookie }, body: cd });
    assert.equal(cdRes.status, 201, await cdRes.text());

    const linked = await attachForm(adminCookie, diNum, "eightd", { document: "8D-DONE-1" });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.forms.find((f) => f.slot === "eightd").document.doc_number, "8D-DONE-1");
    assert.equal(linked.body.gate.all_attached, false, "CAPA form still missing");

    /* An unknown slot is rejected. */
    const bad = await attachForm(adminCookie, diNum, "fishbone", { document: "8D-DONE-1" });
    assert.equal(bad.status, 400);
});

test("a DI cannot close until all three forms are attached", async () => {
    const auditNum = await raiseAudit(adminCookie, "Heat Treat");
    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Heat Treat", finding: "Furnace survey overdue"
    });
    const diNum = di.body.number;

    await attachForm(adminCookie, diNum, "ncr", { file: await makePdf("ncr"), filename: "n.pdf" });
    await attachForm(adminCookie, diNum, "eightd", { file: await makePdf("8d"), filename: "e.pdf" });
    await toLinkedClosure(adminCookie, diNum);

    /* CAPA form still missing. */
    const blocked = await api(adminCookie, "POST", "/api/records/" + diNum + "/transition",
        { to: "closed", reason: "done" });
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.body.missing, ["CAPA form"]);

    /* The GET mirror says the same, before anyone clicks. */
    const rec = await api(adminCookie, "GET", "/api/records/" + diNum);
    const closeMove = rec.body.transitions.find((t) => t.to === "closed");
    assert.equal(closeMove.allowed, false);
    assert.match(closeMove.blocked_because, /NCR, 8D and CAPA forms/);

    await attachForm(adminCookie, diNum, "capa", { file: await makePdf("capa"), filename: "c.pdf" });

    const closed = await api(adminCookie, "POST", "/api/records/" + diNum + "/transition",
        { to: "closed", reason: "resolved" });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
});

test("closing a DI needs di.close; a quality_engineer cannot", async () => {
    const auditNum = await raiseAudit(adminCookie, "Grinding");
    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Grinding", finding: "Wheel dressing not logged"
    });
    const diNum = di.body.number;
    for (const slot of ["ncr", "eightd", "capa"]) {
        await attachForm(adminCookie, diNum, slot, { file: await makePdf(slot), filename: slot + ".pdf" });
    }
    await toLinkedClosure(adminCookie, diNum);

    const denied = await api(noCloseCookie, "POST", "/api/records/" + diNum + "/transition",
        { to: "closed", reason: "x" });
    assert.equal(denied.status, 403);

    /* ...but the engineer could do the earlier steps (di.manage). */
    const reopen = await api(noCloseCookie, "POST", "/api/records/" + diNum + "/transition",
        { to: "investigating", reason: "more work" });
    assert.equal(reopen.status, 200);
});

test("an audit cannot close until its DI is closed", async () => {
    const auditNum = await raiseAudit(adminCookie, "Receiving");
    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Receiving", finding: "Incoming inspection skipped on 3 lots"
    });
    const diNum = di.body.number;

    await api(adminCookie, "POST", "/api/records/" + auditNum + "/transition",
        { to: "scheduled", reason: "t" });

    const blocked = await api(adminCookie, "POST", "/api/records/" + auditNum + "/transition",
        { to: "closed", reason: "t" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, new RegExp(diNum));

    /* Close the DI, then the audit closes. */
    for (const slot of ["ncr", "eightd", "capa"]) {
        await attachForm(adminCookie, diNum, slot, { file: await makePdf(slot), filename: slot + ".pdf" });
    }
    await toLinkedClosure(adminCookie, diNum);
    await api(adminCookie, "POST", "/api/records/" + diNum + "/transition", { to: "closed", reason: "resolved" });

    const auditClosed = await api(adminCookie, "POST", "/api/records/" + auditNum + "/transition",
        { to: "closed", reason: "finding resolved" });
    assert.equal(auditClosed.status, 200, JSON.stringify(auditClosed.body));
});

test("another tenant cannot see the audit or its DI", async () => {
    const auditNum = await raiseAudit(adminCookie, "Shipping");
    const di = await api(adminCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "Shipping", finding: "Label control gap"
    });

    const crossAudit = await api(otherCookie, "POST", "/api/di", {
        audit_number: auditNum, department: "x", finding: "y"
    });
    assert.equal(crossAudit.status, 404, "B cannot raise a DI against A's audit");

    const crossForms = await api(otherCookie, "GET", "/api/di/" + di.body.number + "/forms");
    assert.equal(crossForms.status, 404, "B cannot read A's DI forms");
});
