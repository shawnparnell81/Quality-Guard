/* ============================================================
   Document Control: the register now reports whether a document's
   *current* revision actually has a file behind it
   (current_has_file), so the UI can open a released document
   straight from its row and flag the ones with nothing attached.

   Self-contained: provisions a throwaway org, runs the app on a
   spare port, cleans up after itself. Never touches seed data.
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
const PORT = 3107;
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
            body: JSON.stringify({ current_password: pw, new_password: "Doc-Control-Test-1x" })
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

async function uploadDocument(cookie, docNumber, filename = "spec.pdf") {
    const form = new FormData();
    form.append("doc_number", docNumber);
    form.append("title", docNumber + " title");
    form.append("change_summary", "Initial upload");
    form.append("file", new Blob([Buffer.from("%PDF-1.4 tiny\n")], { type: "application/pdf" }), filename);
    const r = await fetch(BASE + "/api/documents", { method: "POST", headers: { Cookie: cookie }, body: form });
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

const docOf = (list, num) => list.body.documents.find((d) => d.doc_number === num);

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
        companyName: "Doc Control A " + stamp,
        adminEmail: "doc.a." + stamp + "@example.test", adminName: "Doc Admin A"
    });
    other = await provisionOrganization({
        companyName: "Doc Control B " + stamp,
        adminEmail: "doc.b." + stamp + "@example.test", adminName: "Doc Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Doc Operator", email: "doc.op." + stamp + "@example.test",
        initials: "DO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("doc.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a freshly uploaded document has no file on its current revision until it is released", async () => {
    const up = await uploadDocument(adminCookie, "DC-001");
    assert.equal(up.status, 201, JSON.stringify(up.body));

    let list = await api(adminCookie, "GET", "/api/documents");
    let doc = docOf(list, "DC-001");
    assert.ok(doc, "the document is in the register");
    assert.notEqual(doc.status, "released", "a new upload is not released");
    assert.equal(doc.current_revision, null, "nothing is the current revision yet");
    assert.equal(doc.current_has_file, false, "the (absent) current revision has no file");
    assert.equal(Number(doc.revision_count), 1, "rev A exists, it is just not current");

    const released = await api(adminCookie, "POST", "/api/documents/DC-001/revisions/A/release");
    assert.equal(released.status, 200, JSON.stringify(released.body));

    list = await api(adminCookie, "GET", "/api/documents");
    doc = docOf(list, "DC-001");
    assert.equal(doc.status, "released");
    assert.equal(doc.current_revision, "A");
    assert.equal(doc.current_has_file, true, "the current revision now has a file to open");
});

test("current_has_file tracks the current revision, not just any revision", async () => {
    const up = await uploadDocument(adminCookie, "DC-002");
    assert.equal(up.status, 201);
    await api(adminCookie, "POST", "/api/documents/DC-002/revisions/A/release");

    /* A new revision B is uploaded but never released - the current
       revision is still A, which has a file. */
    const form = new FormData();
    form.append("change_summary", "reworked");
    form.append("file", new Blob([Buffer.from("%PDF-1.4 b\n")], { type: "application/pdf" }), "rev-b.pdf");
    const revB = await fetch(BASE + "/api/documents/DC-002/revisions", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(revB.status, 201);

    const list = await api(adminCookie, "GET", "/api/documents");
    const doc = docOf(list, "DC-002");
    assert.equal(doc.current_revision, "A", "an unreleased rev B does not become current");
    assert.equal(doc.current_has_file, true, "current rev A still has its file");
    assert.equal(Number(doc.revision_count), 2);
});

test("uploading a document needs document.create", async () => {
    const denied = await uploadDocument(operatorCookie, "DC-NOPE");
    assert.equal(denied.status, 403);
});

test("one org's documents are invisible to another", async () => {
    const list = await api(otherCookie, "GET", "/api/documents");
    assert.equal(list.body.documents.some((d) => d.doc_number === "DC-001"), false);
});
