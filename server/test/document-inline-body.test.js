/* ============================================================
   Document Control - documents authored in the app (migration 045).

   A revision may carry a `body` text instead of an uploaded file;
   documents.versioning is 'letter' (A, B, C) or 'numeric' (1.0, 2.0);
   and releasing a revision stamps superseded_at on the one it
   replaces. The file path is unchanged - covered by
   document-control.test.js.
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
const PORT = 3136;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
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
            body: JSON.stringify({ current_password: pw, new_password: "Doc-Inline-Body-1x" })
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

async function uploadDoc(cookie, docNumber) {
    const form = new FormData();
    form.append("doc_number", docNumber);
    form.append("title", docNumber + " title");
    form.append("file", new Blob([Buffer.from("%PDF-1.4 tiny\n")], { type: "application/pdf" }), "spec.pdf");
    const r = await fetch(BASE + "/api/documents", { method: "POST", headers: { Cookie: cookie }, body: form });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text || "null") };
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

const revisions = (cookie, num) => api(cookie, "GET", "/api/documents/" + num + "/revisions");
const revOf = (list, r) => list.body.revisions.find((x) => x.revision === r);

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
        companyName: "Doc Inline " + stamp,
        adminEmail: "doc.inline." + stamp + "@example.test", adminName: "Doc Inline Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Doc Inline Op", email: "doc.inline.op." + stamp + "@example.test",
        initials: "DI" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("doc.inline.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a numeric document authored in the app up-issues 1.0 -> 2.0 and supersedes on release", async () => {
    const created = await api(adminCookie, "POST", "/api/documents", {
        doc_number: "WI-INLINE-1", title: "Deburr work instruction",
        versioning: "numeric", body: "1. Break all sharp edges 0.2-0.5mm.\n2. Inspect under 10x."
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.document.versioning, "numeric");
    assert.equal(created.body.revision.revision, "1.0");
    assert.equal(created.body.revision.has_body, true);

    let rel = await api(adminCookie, "POST", "/api/documents/WI-INLINE-1/revisions/1.0/release");
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal(rel.body.current_revision, "1.0");
    assert.equal(rel.body.superseded, null, "nothing to supersede yet");

    /* up-issue with no explicit revision -> server picks 2.0 */
    const up = await api(adminCookie, "POST", "/api/documents/WI-INLINE-1/revisions", {
        body: "1. Break all sharp edges 0.2-0.5mm.\n2. Inspect under 10x.\n3. Log lot number.",
        change_summary: "add lot logging"
    });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.revision, "2.0");
    assert.equal(up.body.has_body, true);

    const list = await api(adminCookie, "GET", "/api/documents");
    const doc = list.body.documents.find((d) => d.doc_number === "WI-INLINE-1");
    assert.equal(doc.status, "in_approval", "up-issue leaves the doc pending, current still 1.0");
    assert.equal(doc.current_revision, "1.0");

    rel = await api(adminCookie, "POST", "/api/documents/WI-INLINE-1/revisions/2.0/release");
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal(rel.body.current_revision, "2.0");
    assert.equal(rel.body.superseded, "1.0", "releasing 2.0 supersedes 1.0");

    const revs = await revisions(adminCookie, "WI-INLINE-1");
    assert.ok(revOf(revs, "1.0").superseded_at, "1.0 is stamped superseded");
    assert.equal(revOf(revs, "2.0").superseded_at, null, "2.0 is current");
    assert.equal((await api(adminCookie, "GET", "/api/documents")).body.documents
        .find((d) => d.doc_number === "WI-INLINE-1").status, "released");
});

test("a body-only revision downloads as plain text", async () => {
    await api(adminCookie, "POST", "/api/documents", {
        doc_number: "WI-INLINE-2", title: "Gowning procedure",
        versioning: "numeric", body: "Don a fresh smock before entering the clean area."
    });
    await api(adminCookie, "POST", "/api/documents/WI-INLINE-2/revisions/1.0/release");

    const r = await fetch(BASE + "/api/documents/WI-INLINE-2/revisions/current/download",
        { headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/plain/);
    assert.equal((await r.text()).trim(), "Don a fresh smock before entering the clean area.");
});

test("the default versioning is still letter, and the file path is untouched", async () => {
    const up = await uploadDoc(adminCookie, "WI-INLINE-3");
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.revision.revision, "A");

    const doc = (await api(adminCookie, "GET", "/api/documents")).body.documents
        .find((d) => d.doc_number === "WI-INLINE-3");
    assert.equal(doc.versioning, "letter");

    const next = await api(adminCookie, "POST", "/api/documents/WI-INLINE-3/revisions", {
        body: "supersedes the uploaded spec", change_summary: "rewrite inline"
    });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.revision, "B");
});

test("a document with neither a file nor a body is a 400", async () => {
    const bad = await api(adminCookie, "POST", "/api/documents", {
        doc_number: "WI-INLINE-4", title: "empty"
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /file or a body/);
});

test("authoring a revision inline still needs document.create", async () => {
    const denied = await api(operatorCookie, "POST", "/api/documents/WI-INLINE-1/revisions", {
        body: "operator edit", change_summary: "nope"
    });
    assert.equal(denied.status, 403);
});
