/* ============================================================
   Training records can now be written, not just computed.

   Proves the /api/training routes end to end against a real running
   instance: record a whole session (one document, two people, one
   sign-off PDF), see it in the list and reflected in the competency
   matrix, open one record, read its evidence back, edit it, and be
   turned away without the training.record permission.

   Self-contained, in the style of tenant-isolation.test.js: provisions
   a throwaway org, runs the app on a spare port, cleans up after.
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
let adminCookie;
let deniedCookie;
let docId;

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
    if (body.must_change_password) {
        await fetch(BASE + "/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: temporaryPassword, new_password: "Training-Test-1x" })
        });
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
    try { body = JSON.parse(text); } catch { /* not always JSON */ }
    return { status: response.status, body };
}

function makePdf() {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [200, 200] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text("Training sign-off sheet", 20, 90);
        doc.end();
    });
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(BASE + "/api/health");
            if (r.ok) return;
        } catch { /* not up yet */ }
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
        companyName: "Training Test " + stamp,
        adminEmail: "training." + stamp + "@example.test",
        adminName: "Training Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    /* Fixtures the training matrix needs: a released document, a role
       required to hold it, and two people in that role. */
    const doc = await query(`
        insert into documents (org_id, doc_number, title, current_revision, status)
        values ($1, 'WI-TRN-01', 'Test work instruction', 'B', 'released')
        returning id
    `, [tenant.orgId]);
    docId = doc.rows[0].id;

    await query(`
        insert into document_requirements (org_id, role, document_id)
        values ($1, 'operator', $2)
    `, [tenant.orgId, docId]);

    const stampShort = stamp % 100000;
    const alice = await api(adminCookie, "POST", "/api/users", {
        full_name: "Alice Operator", email: "alice." + stamp + "@example.test",
        initials: "AO" + stampShort, role: "operator"
    });
    const bob = await api(adminCookie, "POST", "/api/users", {
        full_name: "Bob Operator", email: "bob." + stamp + "@example.test",
        initials: "BO" + stampShort, role: "operator"
    });
    assert.equal(alice.status, 201);
    assert.equal(bob.status, 201);
    before.aliceInitials = alice.body.initials;
    before.bobInitials = bob.body.initials;

    /* A role with no training.record, for the negative case. */
    const noPerm = await query(`
        select r.key from roles r
         where r.org_id = $1
           and not exists (
               select 1 from role_permissions rp
                where rp.org_id = r.org_id and rp.role_key = r.key
                  and rp.permission_key = 'training.record')
         limit 1
    `, [tenant.orgId]);
    const deniedUser = await api(adminCookie, "POST", "/api/users", {
        full_name: "No Trainer", email: "notrainer." + stamp + "@example.test",
        initials: "NT" + stampShort, role: noPerm.rows[0].key
    });
    assert.equal(deniedUser.status, 201, JSON.stringify(deniedUser.body));
    deniedCookie = await loginAs(deniedUser.body.email || ("notrainer." + stamp + "@example.test"),
        deniedUser.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a training session records one row per person and shows in the list", async () => {
    const pdf = await makePdf();
    const form = new FormData();
    form.append("document", "WI-TRN-01");
    form.append("revision_trained", "B");
    form.append("trained_on", "2026-06-01");
    form.append("next_review", "2027-06-01");
    form.append("notes", "Line 3 changeover procedure");
    form.append("users", JSON.stringify([before.aliceInitials, before.bobInitials]));
    form.append("evidence", new Blob([pdf], { type: "application/pdf" }), "signoff.pdf");

    const recorded = await fetch(BASE + "/api/training", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const recordedBody = await recorded.json();
    assert.equal(recorded.status, 201, JSON.stringify(recordedBody));
    assert.equal(recordedBody.count, 2);

    const list = await api(adminCookie, "GET", "/api/training");
    assert.equal(list.status, 200);
    const mine = list.body.records.filter((r) => r.doc_number === "WI-TRN-01");
    assert.equal(mine.length, 2);
    assert.ok(mine.every((r) => r.revision_trained === "B" && r.has_evidence && r.is_current));
});

test("the competency matrix reflects the trained revision", async () => {
    const matrix = await api(adminCookie, "GET", "/api/training/matrix");
    assert.equal(matrix.status, 200);
    const alice = matrix.body.matrix.find((r) => r.operator === "Alice Operator");
    assert.ok(alice, "Alice should be in the matrix");
    const cell = alice.documents["WI-TRN-01"];
    assert.equal(cell.trained_revision, "B");
    assert.equal(cell.ok, true);
    assert.ok(cell.training_record_id, "the cell should carry its record id");
});

test("a record opens and its evidence reads back as a PDF", async () => {
    const list = await api(adminCookie, "GET", "/api/training");
    const id = list.body.records.find((r) => r.doc_number === "WI-TRN-01").id;

    const one = await api(adminCookie, "GET", "/api/training/" + id);
    assert.equal(one.status, 200);
    assert.equal(one.body.doc_number, "WI-TRN-01");
    assert.equal(one.body.evidence_filename, "signoff.pdf");

    const evidence = await fetch(BASE + "/api/training/" + id + "/evidence", { headers: { Cookie: adminCookie } });
    assert.equal(evidence.status, 200);
    assert.equal(evidence.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await evidence.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.subarray(0, 4).toString() === "%PDF");
});

test("a record can be edited", async () => {
    const list = await api(adminCookie, "GET", "/api/training");
    const id = list.body.records.find((r) => r.doc_number === "WI-TRN-01").id;

    const form = new FormData();
    form.append("revision_trained", "B");
    form.append("trained_on", "2026-06-01");
    form.append("next_review", "2028-01-15");
    form.append("notes", "revised review interval");

    const patched = await fetch(BASE + "/api/training/" + id, {
        method: "PATCH", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(patched.status, 200, await patched.text());

    const one = await api(adminCookie, "GET", "/api/training/" + id);
    assert.equal(String(one.body.next_review).slice(0, 10), "2028-01-15");
});

test("recording training needs the training.record permission", async () => {
    const form = new FormData();
    form.append("document", "WI-TRN-01");
    form.append("revision_trained", "B");
    form.append("trained_on", "2026-06-01");
    form.append("users", JSON.stringify([before.aliceInitials]));

    const denied = await fetch(BASE + "/api/training", {
        method: "POST", headers: { Cookie: deniedCookie }, body: form
    });
    assert.equal(denied.status, 403);
});
