/* ============================================================
   An APQP program is its three deliverables - Process Flow Diagram,
   FMEA, Control Plan. This proves the slot layer end to end against a
   real running instance: open a program, see three empty slots, fill
   one by uploading a PDF and another by linking an existing controlled
   document, watch the Phase 3 gate flip once all three are attached,
   advance the program to Phase 3, then unlink a slot and watch the
   gate close again. Also: a role without apqp.manage is refused, and
   another tenant cannot see the program at all.

   Self-contained in the style of master-data-editing.test.js: it
   provisions its own throwaway orgs, runs the app as a child process
   on a spare port, and deletes everything it made afterwards.
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

const PORT = 3096;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let otherTenant;
let adminCookie;
let otherAdminCookie;
let operatorCookie;
let programNumber;

function extractCookie(response) {
    const raw = response.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

async function loginAs(email, temporaryPassword) {
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: temporaryPassword })
    });
    assert.equal(login.status, 200, "login should succeed for " + email);
    const body = await login.json();
    const cookie = extractCookie(login);
    assert.ok(cookie, "login should set a session cookie");

    if (body.must_change_password) {
        const changed = await fetch(BASE + "/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: temporaryPassword, new_password: "Apqp-Deliverables-1x" })
        });
        assert.equal(changed.status, 200, "forced password change should succeed");
    }

    return cookie;
}

async function api(cookie, method, path, payload) {
    const response = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not every response is JSON */ }
    return { status: response.status, body };
}

function makePdf(caption) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [200, 200] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text(caption, 20, 90);
        doc.end();
    });
}

async function attachSlot(cookie, number, slot, { file, filename, document: docNumber }) {
    const form = new FormData();
    if (file) form.append("file", new Blob([file], { type: "application/pdf" }), filename || "deliverable.pdf");
    if (docNumber) form.append("document", docNumber);

    const response = await fetch(BASE + "/api/apqp/" + encodeURIComponent(number)
        + "/deliverables/" + encodeURIComponent(slot), {
        method: "POST",
        headers: { Cookie: cookie },
        body: form
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not always JSON */ }
    return { status: response.status, body };
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(BASE + "/api/health");
            if (response.ok) return;
        } catch { /* not listening yet */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

before(async () => {
    serverProcess = spawn(
        process.execPath,
        ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" }
    );
    let bootLog = "";
    serverProcess.stdout.on("data", (chunk) => { bootLog += chunk; });
    serverProcess.stderr.on("data", (chunk) => { bootLog += chunk; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("Test server exited early:\n" + bootLog);
    });

    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "APQP Deliverables Test " + stamp,
        adminEmail: "apqp." + stamp + "@example.test",
        adminName: "APQP Admin"
    });
    otherTenant = await provisionOrganization({
        companyName: "APQP Bystander " + stamp,
        adminEmail: "apqp.other." + stamp + "@example.test",
        adminName: "Bystander Admin"
    });

    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherAdminCookie = await loginAs(otherTenant.admin.email, otherTenant.temporaryPassword);

    /* An operator holds no apqp.manage - the negative case. */
    const operator = await api(adminCookie, "POST", "/api/users", {
        full_name: "Test Operator", email: "apqp.op." + stamp + "@example.test",
        initials: "AO" + (stamp % 100), role: "operator"
    });
    assert.equal(operator.status, 201, JSON.stringify(operator.body));
    operatorCookie = await loginAs(
        operator.body.email || ("apqp.op." + stamp + "@example.test"),
        operator.body.temporary_password
    );

    const program = await api(adminCookie, "POST", "/api/records", {
        type: "apqp",
        title: "Bracket assembly launch",
        data: { customer: "Northwind Motors", part_number: "BRK-4471", ppap_level: "Level 3" }
    });
    assert.equal(program.status, 201, JSON.stringify(program.body));
    programNumber = program.body.number;
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (otherTenant) await query("delete from organizations where id = $1", [otherTenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a fresh program shows three empty deliverable slots and a closed gate", async () => {
    const got = await api(adminCookie, "GET", "/api/apqp/" + programNumber + "/deliverables");
    assert.equal(got.status, 200, JSON.stringify(got.body));

    assert.deepEqual(
        got.body.deliverables.map((d) => d.slot),
        ["process_flow", "fmea", "control_plan"],
        "the three slots come back in APQP order"
    );
    assert.ok(got.body.deliverables.every((d) => d.document === null), "nothing attached yet");
    assert.equal(got.body.gate.phase3_ready, false);
    assert.deepEqual(
        got.body.gate.missing.sort(),
        ["Control Plan", "FMEA", "Process Flow Diagram"]
    );
});

test("uploading a PDF fills the Process Flow slot with a new controlled document", async () => {
    const pdf = await makePdf("Process flow diagram");
    const attached = await attachSlot(adminCookie, programNumber, "process_flow", {
        file: pdf, filename: "process-flow.pdf"
    });
    assert.equal(attached.status, 201, JSON.stringify(attached.body));

    const slot = attached.body.deliverables.find((d) => d.slot === "process_flow");
    assert.ok(slot.document, "the slot now names a document");
    assert.match(slot.document.doc_number, /APQP-.*-PFD/, "the document number identifies it as this program's PFD");
    assert.equal(attached.body.gate.phase3_ready, false, "two still missing");

    /* The document is now linked to the program and visible in its documents list. */
    const docs = await api(adminCookie, "GET", "/api/documents?record=" + encodeURIComponent(programNumber));
    assert.ok(docs.body.documents.some((d) => d.doc_number === slot.document.doc_number),
        "the uploaded deliverable shows in the program's documents");
});

test("an existing controlled document can be linked into the FMEA slot", async () => {
    const pdf = await makePdf("FMEA worksheet");
    const form = new FormData();
    form.append("doc_number", "FMEA-APQP-TEST");
    form.append("title", "Process FMEA - bracket assembly");
    form.append("change_summary", "Initial issue");
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "pfmea.pdf");

    const created = await fetch(BASE + "/api/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(created.status, 201, await created.text());

    const linked = await attachSlot(adminCookie, programNumber, "fmea", { document: "FMEA-APQP-TEST" });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));

    const slot = linked.body.deliverables.find((d) => d.slot === "fmea");
    assert.equal(slot.document.doc_number, "FMEA-APQP-TEST");
    assert.equal(linked.body.gate.phase3_ready, false, "control plan still missing");
});

test("attaching the Control Plan opens the Phase 3 gate", async () => {
    const pdf = await makePdf("Control plan");
    const attached = await attachSlot(adminCookie, programNumber, "control_plan", {
        file: pdf, filename: "control-plan.pdf"
    });
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    assert.equal(attached.body.gate.phase3_ready, true, "all three attached");
    assert.deepEqual(attached.body.gate.missing, []);
});

test("with the gate open the program can be advanced to Phase 3", async () => {
    /* draft -> plan_define -> product_design -> process_design; only the
       last of those is what the client gates on the deliverables. */
    for (const to of ["plan_define", "product_design", "process_design"]) {
        const moved = await api(adminCookie, "POST", "/api/records/" + programNumber + "/transition", {
            to, reason: "phase gate met"
        });
        assert.equal(moved.status, 200, "advance to " + to + ": " + JSON.stringify(moved.body));
    }

    const now = await api(adminCookie, "GET", "/api/apqp/" + programNumber + "/deliverables");
    assert.equal(now.body.phase, "process_design");
});

test("unlinking a slot closes the gate again but leaves the document in Document Control", async () => {
    const removed = await fetch(BASE + "/api/apqp/" + encodeURIComponent(programNumber)
        + "/deliverables/process_flow", { method: "DELETE", headers: { Cookie: adminCookie } });
    const body = await removed.json();
    assert.equal(removed.status, 200, JSON.stringify(body));

    const slot = body.deliverables.find((d) => d.slot === "process_flow");
    assert.equal(slot.document, null, "the slot is empty");
    assert.equal(body.gate.phase3_ready, false);
    assert.deepEqual(body.gate.missing, ["Process Flow Diagram"]);

    /* The controlled document itself is untouched. */
    const docs = await api(adminCookie, "GET", "/api/documents?record=" + encodeURIComponent(programNumber));
    assert.ok(docs.body.documents.some((d) => /APQP-.*-PFD/.test(d.doc_number)),
        "the PFD document still exists, just not in the slot");
});

test("an unknown slot name is rejected", async () => {
    const bad = await attachSlot(adminCookie, programNumber, "gantt_chart", { document: "FMEA-APQP-TEST" });
    assert.equal(bad.status, 400);
});

test("a role without apqp.manage cannot attach a deliverable", async () => {
    const pdf = await makePdf("nope");
    const denied = await attachSlot(operatorCookie, programNumber, "process_flow", {
        file: pdf, filename: "nope.pdf"
    });
    assert.equal(denied.status, 403);

    const stillEmpty = await api(adminCookie, "GET", "/api/apqp/" + programNumber + "/deliverables");
    assert.equal(stillEmpty.body.deliverables.find((d) => d.slot === "process_flow").document, null,
        "the refused upload must not have landed");
});

test("another tenant cannot see the program's deliverables", async () => {
    const cross = await api(otherAdminCookie, "GET", "/api/apqp/" + programNumber + "/deliverables");
    assert.equal(cross.status, 404, "a program in another org is simply not there");
});
