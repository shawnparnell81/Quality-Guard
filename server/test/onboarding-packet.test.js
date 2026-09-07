/* ============================================================
   The vendor onboarding packet: every stage of a candidate's file,
   with the documents that back it - uploaded here, or linked to a
   controlled document that already exists.

   Proves the /api/onboarding/:vendor/packet routes end to end:
   read the packet, upload a PDF to a stage, read it back, link a
   controlled document, remove one, and be turned away without
   vendor.approve. Tenant-isolated. Self-contained.
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

const PORT = 3095;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let deniedCookie;
const VENDOR = "Test Grinding Co";

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
    const cookie = extractCookie(login);
    if (body.must_change_password) {
        await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: pw, new_password: "Packet-Test-1x" })
        });
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

function makePdf() {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [200, 200] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text("Vendor questionnaire", 20, 90);
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

async function seedVendor(orgId) {
    const v = await query(
        "insert into vendors (org_id, name, scope, status) values ($1, $2, 'Centreless grinding', 'onboarding') returning id",
        [orgId, VENDOR]
    );
    const vendorId = v.rows[0].id;
    await query(`
        insert into vendor_onboarding_stages (vendor_id, stage_key, name, detail, status, position)
        values ($1, 'questionnaire', 'Questionnaire returned', 'Self assessment', 'pending', 1),
               ($1, 'certification', 'Certification verified', 'ISO 9001 confirmed', 'pending', 2),
               ($1, 'avl',           'Added to approved list', 'QM signature', 'pending', 3)
    `, [vendorId]);
    return vendorId;
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
        companyName: "Packet Test A " + stamp,
        adminEmail: "packet.a." + stamp + "@example.test", adminName: "Packet Admin A"
    });
    other = await provisionOrganization({
        companyName: "Packet Test B " + stamp,
        adminEmail: "packet.b." + stamp + "@example.test", adminName: "Packet Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    await seedVendor(tenant.orgId);

    /* A controlled document to link. */
    await query(`
        insert into documents (org_id, doc_number, title, current_revision, status)
        values ($1, 'QM-001', 'Quality Manual', 'H', 'released')
    `, [tenant.orgId]);

    /* A role with no vendor.approve, for the negative case. */
    const noPerm = await query(`
        select r.key from roles r
         where r.org_id = $1 and not exists (
             select 1 from role_permissions rp
              where rp.org_id = r.org_id and rp.role_key = r.key and rp.permission_key = 'vendor.approve')
         limit 1
    `, [tenant.orgId]);
    const denied = await api(adminCookie, "POST", "/api/users", {
        full_name: "No Approver", email: "noapprove." + stamp + "@example.test",
        initials: "NA" + (stamp % 100000), role: noPerm.rows[0].key
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    deniedCookie = await loginAs(denied.body.email || ("noapprove." + stamp + "@example.test"),
        denied.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the packet lists every stage with an empty document list", async () => {
    const packet = await api(adminCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    assert.equal(packet.status, 200, JSON.stringify(packet.body));
    assert.equal(packet.body.vendor.name, VENDOR);
    assert.equal(packet.body.stages.length, 3);
    assert.ok(packet.body.stages.every((s) => Array.isArray(s.documents) && s.documents.length === 0));
});

test("a PDF uploads to a stage and reads back", async () => {
    const pdf = await makePdf();
    const form = new FormData();
    form.append("note", "returned 12 Aug, scored 88");
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "questionnaire.pdf");

    const added = await fetch(BASE + "/api/onboarding/" + encodeURIComponent(VENDOR) + "/stages/questionnaire/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const addedBody = await added.json();
    assert.equal(added.status, 201, JSON.stringify(addedBody));
    assert.equal(addedBody.kind, "upload");

    const packet = await api(adminCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    const stage = packet.body.stages.find((s) => s.stage_key === "questionnaire");
    assert.equal(stage.documents.length, 1);
    assert.equal(stage.documents[0].original_filename, "questionnaire.pdf");
    assert.equal(stage.documents[0].note, "returned 12 Aug, scored 88");

    const dl = await fetch(BASE + packetDocUrl(stage.documents[0].id, "questionnaire"), { headers: { Cookie: adminCookie } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.subarray(0, 4).toString() === "%PDF");
});

function packetDocUrl(id, stageKey) {
    return "/api/onboarding/" + encodeURIComponent(VENDOR) + "/stages/" + stageKey + "/documents/" + id + "/download";
}

test("a controlled document links to a stage", async () => {
    const form = new FormData();
    form.append("document", "QM-001");
    form.append("note", "reference copy");

    const added = await fetch(BASE + "/api/onboarding/" + encodeURIComponent(VENDOR) + "/stages/certification/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const addedBody = await added.json();
    assert.equal(added.status, 201, JSON.stringify(addedBody));
    assert.equal(addedBody.kind, "link");

    const packet = await api(adminCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    const stage = packet.body.stages.find((s) => s.stage_key === "certification");
    assert.equal(stage.documents.length, 1);
    assert.equal(stage.documents[0].kind, "link");
    assert.equal(stage.documents[0].doc_number, "QM-001");
});

test("a document can be removed from a stage", async () => {
    const packet = await api(adminCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    const doc = packet.body.stages.find((s) => s.stage_key === "questionnaire").documents[0];

    const removed = await api(adminCookie, "DELETE",
        "/api/onboarding/" + encodeURIComponent(VENDOR) + "/stages/questionnaire/documents/" + doc.id);
    assert.equal(removed.status, 200);

    const after = await api(adminCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    assert.equal(after.body.stages.find((s) => s.stage_key === "questionnaire").documents.length, 0);
});

test("attaching a document needs vendor.approve", async () => {
    const form = new FormData();
    form.append("document", "QM-001");
    const denied = await fetch(BASE + "/api/onboarding/" + encodeURIComponent(VENDOR) + "/stages/avl/documents", {
        method: "POST", headers: { Cookie: deniedCookie }, body: form
    });
    assert.equal(denied.status, 403);
});

test("another tenant cannot see the packet", async () => {
    const packet = await api(otherCookie, "GET", "/api/onboarding/" + encodeURIComponent(VENDOR) + "/packet");
    assert.equal(packet.status, 404);
});
