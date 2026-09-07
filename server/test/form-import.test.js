/* ============================================================
   Excel -> form schema importer.

   Builds a small workbook in-test (a section heading, a few labelled
   rows, one grid), uploads it, and checks the inferred schema has
   the sections / field types / table field it should; then applies
   it to a brand-new record type and confirms that type is usable.
   forms.manage gates every route; one org's imports are invisible to
   another.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const PORT = 3105;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
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
            body: JSON.stringify({ current_password: pw, new_password: "Import-Test-Passphrase-1x" })
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

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

/* A minimal PFMEA-shaped sheet. */
async function makeWorkbook() {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet("PFMEA");

    s.mergeCells("A1:D1");
    s.getCell("A1").value = "Header";
    s.getCell("A1").font = { bold: true };

    s.getCell("A2").value = "Customer:";
    s.getCell("A3").value = "Date Opened:";
    s.getCell("A4").value = "Severity:";
    s.getCell("A5").value = "Failure Description:";

    s.mergeCells("A7:E7");
    s.getCell("A7").value = "Analysis";
    s.getCell("A7").font = { bold: true };

    s.getCell("A8").value = "Process Step";
    s.getCell("B8").value = "Potential Failure Mode";
    s.getCell("C8").value = "Severity";
    s.getCell("D8").value = "Occurrence";

    s.getCell("A9").value = "Mill OD";
    s.getCell("B9").value = "Chatter";
    s.getCell("C9").value = 7;
    s.getCell("D9").value = 3;

    s.getCell("A10").value = "Drill";
    s.getCell("B10").value = "Off centre";
    s.getCell("C10").value = 5;
    s.getCell("D10").value = 2;

    return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(cookie, buffer, filename = "pfmea.xlsx") {
    const form = new FormData();
    form.append("file", new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), filename);
    const r = await fetch(BASE + "/api/forms/import", {
        method: "POST", headers: { Cookie: cookie }, body: form
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* */ }
    return { status: r.status, body, text };
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
        companyName: "Import Test A " + stamp,
        adminEmail: "import.a." + stamp + "@example.test", adminName: "Import Admin A"
    });
    other = await provisionOrganization({
        companyName: "Import Test B " + stamp,
        adminEmail: "import.b." + stamp + "@example.test", adminName: "Import Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Import Operator", email: "import.op." + stamp + "@example.test",
        initials: "IO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noManageCookie = await loginAs(op.body.email || ("import.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("an uploaded workbook infers sections, field types and a table", async () => {
    const up = await upload(adminCookie, await makeWorkbook());
    assert.equal(up.status, 201, up.text);

    const fields = up.body.fields;
    const byLabel = (l) => fields.find((f) => f.label === l);

    assert.ok(byLabel("Customer"), "Customer field inferred");
    assert.equal(byLabel("Customer").section, "Header");
    assert.equal(byLabel("Date Opened").type, "date");
    assert.equal(byLabel("Severity").type, "number");
    assert.equal(byLabel("Failure Description").type, "memo");

    const table = fields.find((f) => f.type === "table");
    assert.ok(table, "a table field was inferred");
    assert.equal(table.section, "Analysis");
    assert.equal(table.columns.length, 4);
    assert.equal(table.columns.find((c) => c.label === "Severity").type, "number");
});

test("the import is listed and its schema fetched", async () => {
    const up = await upload(adminCookie, await makeWorkbook());
    const id = up.body.import_id;

    const list = await api(adminCookie, "GET", "/api/forms/imports");
    assert.ok(list.body.imports.some((i) => i.id === id));

    const detail = await api(adminCookie, "GET", "/api/forms/imports/" + id);
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.schema.fields));
    assert.equal(detail.body.status, "inferred");
});

test("applying to a new type produces a usable form", async () => {
    const up = await upload(adminCookie, await makeWorkbook());
    const id = up.body.import_id;

    const applied = await api(adminCookie, "POST", "/api/forms/imports/" + id + "/apply", {
        target: "new", name: "PFMEA", prefix: "PFMEA", fields: up.body.fields
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.created, true);
    assert.equal(applied.body.applied_key, "pfmea");

    const form = await api(adminCookie, "GET", "/api/record-types/pfmea/form");
    assert.equal(form.status, 200);
    assert.ok(form.body.fields.some((f) => f.type === "table"));

    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "pfmea", title: "PFMEA for line 3",
        data: { customer: "Acme", analysis: [{ process_step: "Mill", potential_failure_mode: "Chatter", severity: 7 }] }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.match(rec.body.number, /^PFMEA-\d{4}-\d{4}$/);

    const detail = await api(adminCookie, "GET", "/api/forms/imports/" + id);
    assert.equal(detail.body.status, "applied");
});

test("a second apply to the same new prefix conflicts", async () => {
    const up = await upload(adminCookie, await makeWorkbook());
    const again = await api(adminCookie, "POST", "/api/forms/imports/" + up.body.import_id + "/apply", {
        target: "new", name: "PFMEA Two", prefix: "PFMEA", fields: up.body.fields
    });
    assert.equal(again.status, 409);
});

test("import routes need forms.manage", async () => {
    const denied = await upload(noManageCookie, await makeWorkbook());
    assert.equal(denied.status, 403);

    const list = await api(noManageCookie, "GET", "/api/forms/imports");
    assert.equal(list.status, 403);
});

test("a non-xlsx upload is refused", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("id,name\n1,x")], { type: "text/csv" }), "form.csv");
    const r = await fetch(BASE + "/api/forms/import", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(r.status, 422);
});

test("one org's imports are invisible to another", async () => {
    const up = await upload(adminCookie, await makeWorkbook());
    const get = await api(otherCookie, "GET", "/api/forms/imports/" + up.body.import_id);
    assert.equal(get.status, 404);

    const list = await api(otherCookie, "GET", "/api/forms/imports");
    assert.equal(list.body.imports.some((i) => i.id === up.body.import_id), false);
});
