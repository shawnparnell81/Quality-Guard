/* ============================================================
   Engineering can upload its own files.

   The app has no CAD tool, so a drawing has to carry the file it was
   drawn in. This proves /api/drawings end to end: create a drawing
   with its file, read it back, add a revision with its own file,
   download both, release one, and that a role without drawing.create
   is turned away and a bad file type is refused. Plus the Engineering
   Documents side: a controlled document tagged category "engineering"
   and the filtered list.
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
const PORT = 3091;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let deniedCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Eng-Upload-Test-1x" })
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

async function uploadDrawing(cookie, { number, title, file, filename }) {
    const form = new FormData();
    form.append("drawing_number", number);
    form.append("title", title);
    form.append("change_summary", "Initial issue");
    form.append("file", new Blob([file], { type: "application/pdf" }), filename || "dwg.pdf");
    const r = await fetch(BASE + "/api/drawings", { method: "POST", headers: { Cookie: cookie }, body: form });
    return { status: r.status, body: await r.json().catch(() => null) };
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
        companyName: "Eng Upload A " + stamp,
        adminEmail: "eng.a." + stamp + "@example.test", adminName: "Eng Admin A"
    });
    other = await provisionOrganization({
        companyName: "Eng Upload B " + stamp,
        adminEmail: "eng.b." + stamp + "@example.test", adminName: "Eng Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    /* An operator holds neither drawing.create nor document.create. */
    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Shop Operator", email: "eng.op." + stamp + "@example.test",
        initials: "EO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    deniedCookie = await loginAs(op.body.email || ("eng.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a drawing is created by uploading its file, and shows in the register", async () => {
    const pdf = await makePdf("Bracket, sheet 1");
    const created = await uploadDrawing(adminCookie, {
        number: "BRK-1000", title: "Weld bracket", file: pdf
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.revision, "A");

    const list = await api(adminCookie, "GET", "/api/drawings");
    assert.ok(list.body.drawings.some((d) => d.drawing_number === "BRK-1000"));

    const detail = await api(adminCookie, "GET", "/api/drawings/BRK-1000");
    assert.equal(detail.status, 200);
    const revA = detail.body.revisions.find((r) => r.revision === "A");
    assert.equal(revA.has_file, true);
    assert.equal(revA.status, "draft");
});

test("the uploaded file streams back", async () => {
    const res = await fetch(BASE + "/api/drawings/BRK-1000/revisions/A/file", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.subarray(0, 4).toString() === "%PDF");
});

test("a new revision takes the next letter and carries its own file", async () => {
    const pdf = await makePdf("Bracket, sheet 1 rev B");
    const form = new FormData();
    form.append("change_summary", "Added a gusset");
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "revb.pdf");
    const r = await fetch(BASE + "/api/drawings/BRK-1000/revisions", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const body = await r.json();
    assert.equal(r.status, 201, JSON.stringify(body));
    assert.equal(body.revision, "B");

    const fileB = await fetch(BASE + "/api/drawings/BRK-1000/revisions/B/file", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(fileB.status, 200);
});

test("release still works with the file columns in place", async () => {
    const released = await api(adminCookie, "POST", "/api/drawings/BRK-1000/revisions/A/release",
        { reason: "checked by RV" });
    assert.equal(released.status, 200, JSON.stringify(released.body));

    const detail = await api(adminCookie, "GET", "/api/drawings/BRK-1000");
    assert.equal(detail.body.drawing.current_revision, "A");
});

test("a bad file type is refused", async () => {
    const form = new FormData();
    form.append("drawing_number", "BAD-1");
    form.append("title", "nope");
    form.append("file", new Blob([Buffer.from("MZ")], { type: "application/octet-stream" }), "tool.exe");
    const r = await fetch(BASE + "/api/drawings", { method: "POST", headers: { Cookie: adminCookie }, body: form });
    assert.equal(r.status, 422);
});

test("a role without drawing.create cannot upload", async () => {
    const pdf = await makePdf("x");
    const denied = await uploadDrawing(deniedCookie, { number: "OP-1", title: "x", file: pdf });
    assert.equal(denied.status, 403);
});

test("another tenant cannot read or add to the drawing", async () => {
    const crossFile = await fetch(BASE + "/api/drawings/BRK-1000/revisions/A/file", {
        headers: { Cookie: otherCookie }
    });
    assert.equal(crossFile.status, 404);

    const form = new FormData();
    form.append("change_summary", "sneaky");
    form.append("file", new Blob([await makePdf("x")], { type: "application/pdf" }), "x.pdf");
    const crossRev = await fetch(BASE + "/api/drawings/BRK-1000/revisions", {
        method: "POST", headers: { Cookie: otherCookie }, body: form
    });
    assert.equal(crossRev.status, 404);
});

test("an engineering document is tagged and shows in the filtered list", async () => {
    const form = new FormData();
    form.append("doc_number", "ENG-SPEC-014");
    form.append("title", "Surface finish spec");
    form.append("category", "engineering");
    form.append("file", new Blob([await makePdf("spec")], { type: "application/pdf" }), "spec.pdf");
    const up = await fetch(BASE + "/api/documents", { method: "POST", headers: { Cookie: adminCookie }, body: form });
    assert.equal(up.status, 201, await up.text());

    const eng = await api(adminCookie, "GET", "/api/documents?category=engineering");
    assert.ok(eng.body.documents.some((d) => d.doc_number === "ENG-SPEC-014"));

    const quality = await api(adminCookie, "GET", "/api/documents?category=quality");
    assert.ok(!quality.body.documents.some((d) => d.doc_number === "ENG-SPEC-014"),
        "the engineering doc is not in another category's list");
});
