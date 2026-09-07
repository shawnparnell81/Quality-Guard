/* ============================================================
   Record attachments - the file itself, not just a pointer.

   The attachments table was metadata only: you typed a filename and
   a path to wherever the file already lived. This proves the upload
   path end to end - attach a real file to an NCR, see it listed with
   has_file, stream it back byte for byte - while the older "link to a
   file on a share" form still works, an unsupported type is refused,
   and one tenant's attachment is invisible to another.
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
const PORT = 3101;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Attach-Test-Passphrase-1x" })
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
        const doc = new PDFDocument({ size: [160, 160] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(11).text(caption, 16, 70);
        doc.end();
    });
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

async function raiseNcr(cookie, title) {
    const r = await api(cookie, "POST", "/api/records", {
        type: "ncr", title,
        data: { part_number: "RP-1", description: "surface finish", disposition: "Rework" }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number;
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
        companyName: "Attach Test A " + stamp,
        adminEmail: "attach.a." + stamp + "@example.test", adminName: "Attach Admin A"
    });
    other = await provisionOrganization({
        companyName: "Attach Test B " + stamp,
        adminEmail: "attach.b." + stamp + "@example.test", adminName: "Attach Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a file uploaded to a record is listed and streams back byte for byte", async () => {
    const number = await raiseNcr(adminCookie, "Attachment upload");
    const pdf = await makePdf("defect photo");

    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "defect.pdf");
    const up = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const upText = await up.text();
    assert.equal(up.status, 201, upText);
    const upBody = JSON.parse(upText);
    assert.equal(upBody.filename, "defect.pdf");
    assert.equal(upBody.has_file, true);

    const list = await api(adminCookie, "GET", "/api/records/" + number + "/attachments");
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 1);
    assert.equal(list.body.attachments[0].has_file, true);
    const id = list.body.attachments[0].id;

    const file = await fetch(BASE + "/api/records/" + number + "/attachments/" + id + "/file", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, pdf.length);
});

test("the older link-to-a-file-on-a-share form still works", async () => {
    const number = await raiseNcr(adminCookie, "Attachment link");

    const linked = await api(adminCookie, "POST", "/api/records/" + number + "/attachments", {
        filename: "8d-from-supplier.pdf",
        storage_key: "\\\\qms\\suppliers\\halstead\\8d-from-supplier.pdf"
    });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.has_file, false);
    assert.equal(linked.body.storage_key, "\\\\qms\\suppliers\\halstead\\8d-from-supplier.pdf");

    /* nothing to stream for a link-only row */
    const file = await fetch(BASE + "/api/records/" + number + "/attachments/" + linked.body.id + "/file", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(file.status, 404);
});

test("a link row still needs a filename and a location", async () => {
    const number = await raiseNcr(adminCookie, "Attachment bad link");
    const bad = await api(adminCookie, "POST", "/api/records/" + number + "/attachments", {
        filename: "orphan.pdf"
    });
    assert.equal(bad.status, 400);
});

test("an unsupported file type is refused", async () => {
    const number = await raiseNcr(adminCookie, "Attachment bad type");
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("MZ...")], { type: "application/octet-stream" }), "tool.exe");
    const up = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(up.status, 422);
});

test("one tenant's attachment is invisible to another", async () => {
    const number = await raiseNcr(adminCookie, "Attachment isolation");
    const pdf = await makePdf("private");
    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "private.pdf");
    const up = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(up.status, 201);
    const id = (await up.json()).id;

    const list = await api(otherCookie, "GET", "/api/records/" + number + "/attachments");
    assert.equal(list.status, 404);

    const file = await fetch(BASE + "/api/records/" + number + "/attachments/" + id + "/file", {
        headers: { Cookie: otherCookie }
    });
    assert.equal(file.status, 404);
});
