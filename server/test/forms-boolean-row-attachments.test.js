/* ============================================================
   Boolean fields and per-row attachments (forms finalisation).

   Proves the checkbox field type survives publish + create + read +
   Excel + PDF, and that a file can be pinned to one row of a table
   field: every table row gets a stable server-assigned "_id", a
   round-tripped PATCH keeps those ids, an attachment carries a
   row_ref = "<fieldKey>:<rowId>", a bad ref is a 400, and a clone
   gets fresh ids so it never shares an attachment with its source.
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
const PORT = 3131;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Bool-Test-Passphrase-1x" })
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
        companyName: "Bool Test " + stamp,
        adminEmail: "bool.admin." + stamp + "@example.test", adminName: "Bool Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Quality Form", prefix: "QF", clause: "8.5",
        fields: [
            { key: "safety", label: "Safety / regulatory", type: "boolean", section: "Header" },
            {
                key: "checks", label: "Checks", type: "table", rowAttachments: true,
                columns: [
                    { key: "item", label: "Item", type: "text" },
                    { key: "verified", label: "Verified", type: "boolean" },
                    { key: "sev", label: "SEV", type: "number" },
                    { key: "occ", label: "OCC", type: "number" },
                    { key: "det", label: "DET", type: "number" },
                    { key: "rpn", label: "RPN", type: "computed", compute: "product",
                      inputs: ["sev", "occ", "det"] }
                ]
            }
        ]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let number;
let rowIds;

test("a boolean field and boolean column store true/false and every table row gets an _id", async () => {
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "quality_form", title: "OP10 checks",
        data: {
            safety: true,
            checks: [
                { item: "Torque", verified: true, sev: 5, occ: 4, det: 3 },
                { item: "Gap", sev: 2, occ: 2, det: 2 }
            ]
        }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    number = made.body.number;

    const got = await api(adminCookie, "GET", "/api/records/" + number);
    const data = got.body.record.data;
    assert.equal(data.safety, true);
    assert.equal(data.checks[0].verified, true);
    assert.equal(data.checks[1].verified, undefined, "an unticked box is simply absent");
    assert.equal(data.checks[0].rpn, 60, "computed column still recomputes");
    assert.equal(typeof data.checks[0]._id, "string");
    assert.notEqual(data.checks[0]._id, data.checks[1]._id);

    rowIds = data.checks.map((r) => r._id);
});

test("a PATCH that sends the rows back with their _id keeps them; a new row gets a fresh id", async () => {
    const patched = await api(adminCookie, "PATCH", "/api/records/" + number, {
        reason: "add a check",
        data: {
            checks: [
                { _id: rowIds[0], item: "Torque", verified: true, sev: 5, occ: 4, det: 3 },
                { _id: rowIds[1], item: "Gap", sev: 2, occ: 2, det: 2 },
                { item: "Flush", verified: true }
            ]
        }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const got = await api(adminCookie, "GET", "/api/records/" + number);
    const checks = got.body.record.data.checks;
    assert.equal(checks.length, 3);
    assert.equal(checks[0]._id, rowIds[0], "row 1 keeps its id");
    assert.equal(checks[1]._id, rowIds[1], "row 2 keeps its id");
    assert.equal(typeof checks[2]._id, "string");
    assert.ok(![rowIds[0], rowIds[1]].includes(checks[2]._id), "the new row gets a fresh id");
    rowIds = checks.map((r) => r._id);
});

test("the server re-mints a made-up or duplicated _id on write (audit M5)", async () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const patched = await api(adminCookie, "PATCH", "/api/records/" + number, {
        reason: "hostile client sends bad ids",
        data: {
            checks: [
                { _id: rowIds[0], item: "Torque" },                 // real -> kept
                { _id: "totally-made-up", item: "Gap" },            // not a uuid -> re-minted
                { _id: rowIds[0], item: "Flush" },                  // dup of row 1 -> re-minted
                { _id: "00000000-0000-0000-0000-000000000000", item: "Extra" }  // uuid but not on this record -> re-minted
            ]
        }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const checks = (await api(adminCookie, "GET", "/api/records/" + number)).body.record.data.checks;
    assert.equal(checks.length, 4);
    assert.equal(checks[0]._id, rowIds[0], "the one real id is honoured");
    assert.match(checks[1]._id, UUID);
    assert.notEqual(checks[1]._id, "totally-made-up");
    assert.notEqual(checks[2]._id, rowIds[0], "the duplicate got its own id");
    assert.notEqual(checks[3]._id, "00000000-0000-0000-0000-000000000000");
    /* all four ids are distinct */
    assert.equal(new Set(checks.map((r) => r._id)).size, 4);
    rowIds = checks.map((r) => r._id);
});

test("a file attaches to one row via row_ref, and a bad row_ref is a 400", async () => {
    const pdf = await makePdf("torque check photo");
    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "torque.pdf");
    form.append("row_ref", "checks:" + rowIds[0]);

    const up = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const upText = await up.text();
    assert.equal(up.status, 201, upText);
    assert.equal(JSON.parse(upText).row_ref, "checks:" + rowIds[0]);

    const list = await api(adminCookie, "GET", "/api/records/" + number + "/attachments");
    assert.equal(list.body.attachments[0].row_ref, "checks:" + rowIds[0]);

    const bogusRow = new FormData();
    bogusRow.append("file", new Blob([pdf], { type: "application/pdf" }), "x.pdf");
    bogusRow.append("row_ref", "checks:not-a-real-row");
    const bad = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: bogusRow
    });
    assert.equal(bad.status, 400, await bad.text());

    const bogusField = new FormData();
    bogusField.append("file", new Blob([pdf], { type: "application/pdf" }), "y.pdf");
    bogusField.append("row_ref", "nosuchfield:" + rowIds[0]);
    const bad2 = await fetch(BASE + "/api/records/" + number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: bogusField
    });
    assert.equal(bad2.status, 400);
});

test("a file field is a field-scoped slot: attach via row_ref \"<key>:_\"", async () => {
    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "File Slot Form", prefix: "FSL",
        fields: [
            { key: "note", label: "Note", type: "text" },
            { key: "photos", label: "Photos", type: "file" }
        ]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "file_slot_form", title: "with a file slot", data: { note: "see photos" }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));

    const pdf = await makePdf("evidence");
    const good = new FormData();
    good.append("file", new Blob([pdf], { type: "application/pdf" }), "ev.pdf");
    good.append("row_ref", "photos:_");
    const up = await fetch(BASE + "/api/records/" + rec.body.number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: good
    });
    assert.equal(up.status, 201, await up.text());
    assert.equal(JSON.parse(await (await fetch(BASE + "/api/records/" + rec.body.number
        + "/attachments", { headers: { Cookie: adminCookie } })).text()).attachments[0].row_ref, "photos:_");

    /* ":_" only works for an actual file field */
    const bad = new FormData();
    bad.append("file", new Blob([pdf], { type: "application/pdf" }), "x.pdf");
    bad.append("row_ref", "note:_");
    const badResp = await fetch(BASE + "/api/records/" + rec.body.number + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: bad
    });
    assert.equal(badResp.status, 400);
});

test("a clone gets fresh row ids so it never shares an attachment with its source", async () => {
    const clone = await api(adminCookie, "POST", "/api/records/" + number + "/clone");
    assert.equal(clone.status, 201, JSON.stringify(clone.body));

    const got = await api(adminCookie, "GET", "/api/records/" + clone.body.number);
    const cloneIds = got.body.record.data.checks.map((r) => r._id);
    assert.equal(cloneIds.every((id) => typeof id === "string"), true);
    assert.equal(cloneIds.some((id) => rowIds.includes(id)), false, "no id carried over from the source");
});

test("the record exports to Excel and PDF with the checkbox rendered as Yes/No", async () => {
    const xlsx = await fetch(BASE + "/api/records/" + number + "/excel", { headers: { Cookie: adminCookie } });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get("content-type"), /spreadsheetml/);

    /* round-trip the export: the boolean comes back as true */
    const buf = Buffer.from(await xlsx.arrayBuffer());
    const form = new FormData();
    form.append("file", new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), "qf.xlsx");
    const dry = await fetch(BASE + "/api/records/excel?type=quality_form&dry_run=true", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const dryBody = JSON.parse(await dry.text());
    assert.equal(dry.status, 200, JSON.stringify(dryBody));
    assert.equal(dryBody.header.safety, true, "Yes round-trips back to true");

    const pdf = await fetch(BASE + "/api/records/" + number + "/pdf", { headers: { Cookie: adminCookie } });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
});

test("rowAttachments must be a boolean", async () => {
    const bad = await api(adminCookie, "POST", "/api/record-types", {
        name: "Bad Form", prefix: "BF",
        fields: [{ key: "t", label: "T", type: "table", rowAttachments: "yes",
            columns: [{ key: "c", label: "C", type: "text" }] }]
    });
    assert.equal(bad.status, 422);
});
