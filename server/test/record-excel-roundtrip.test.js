/* ============================================================
   One form <-> one Excel file (forms rework 2/5).

   Download a form type's blank .xlsx, fill the Form sheet and the
   table sheet, upload it back -> one record with header fields and
   table rows populated (computed columns filled server-side). Then
   export that record to .xlsx and confirm it round-trips.

   Self-contained: provisions a throwaway org, runs the app on a
   spare port, cleans up after itself.
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
const PORT = 3123;
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
            body: JSON.stringify({ current_password: pw, new_password: "Xlsx-Test-Passphrase-1x" })
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

async function downloadXlsx(cookie, path) {
    const r = await fetch(BASE + path, { headers: { Cookie: cookie } });
    const buffer = Buffer.from(await r.arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return { status: r.status, headers: r.headers, wb, buffer };
}

async function uploadXlsx(cookie, path, buffer) {
    const fd = new FormData();
    fd.append("file", new Blob([buffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "form.xlsx");
    const r = await fetch(BASE + path, { method: "POST", headers: { Cookie: cookie }, body: fd });
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

/* Fill a downloaded template workbook: set the Value column on the
   Form sheet for the given keys, and add rows to the first table
   sheet. */
function fillTemplate(wb, { title, header, tableSheet, tableRows }) {
    const form = wb.getWorksheet("Form");
    form.eachRow((row) => {
        const key = String(row.getCell(1).value || "").trim();
        if (key === "__title__") { row.getCell(3).value = title; return; }
        if (key && key in header) row.getCell(3).value = header[key];
    });

    const sheet = wb.getWorksheet(tableSheet);
    const headers = sheet.getRow(1).values.slice(1);
    for (const r of tableRows) {
        const line = headers.map((h) => r[h] ?? null);
        sheet.addRow(line);
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
        companyName: "Xlsx Test " + stamp,
        adminEmail: "xlsx.admin." + stamp + "@example.test", adminName: "Xlsx Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const install = await api(adminCookie, "POST", "/api/form-templates/pfmea/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the blank template has a Form sheet and a sheet per table", async () => {
    const { status, headers, wb } = await downloadXlsx(adminCookie, "/api/records/excel-template?type=pfmea");
    assert.equal(status, 200);
    assert.match(headers.get("content-disposition"), /pfmea-template\.xlsx/);

    const form = wb.getWorksheet("Form");
    assert.ok(form, "there is a Form sheet");
    const keys = [];
    form.eachRow((row) => keys.push(String(row.getCell(1).value || "")));
    assert.ok(keys.includes("__title__"), "carries the summary row");
    assert.ok(keys.includes("process_name"), "carries the header fields by key");

    /* the analysis table is its own sheet with all its columns */
    const tableName = wb.worksheets.map((s) => s.name).find((n) => n !== "Form");
    assert.ok(tableName, "there is a table sheet");
    const th = wb.getWorksheet(tableName).getRow(1).values.slice(1);
    assert.ok(th.includes("RPN"), "the table sheet has its columns: " + th.join(", "));
});

test("a filled template uploads as one record with rows and computed RPN", async () => {
    const { wb } = await downloadXlsx(adminCookie, "/api/records/excel-template?type=pfmea");
    const tableSheet = wb.worksheets.map((s) => s.name).find((n) => n !== "Form");

    fillTemplate(wb, {
        title: "OP20 bore PFMEA",
        header: { process_name: "OP20 bore", process_responsibility: "Mfg Eng" },
        tableSheet,
        tableRows: [
            { "Process step / function": "Load part", "Potential failure mode": "Not seated",
              "Sev": 8, "Occ": 4, "Det": 6 },
            { "Process step / function": "Bore", "Potential failure mode": "Oversize",
              "Sev": 7, "Occ": 5, "Det": 3 }
        ]
    });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea", buffer);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.number, /^PFMEA-\d{4}-\d{4}$/);

    const rec = await api(adminCookie, "GET", "/api/records/" + up.body.number);
    assert.equal(rec.body.record.title, "OP20 bore PFMEA");
    assert.equal(rec.body.record.data.process_name, "OP20 bore");
    assert.equal(rec.body.record.data.analysis.length, 2);
    assert.equal(rec.body.record.data.analysis[0].rpn, 8 * 4 * 6, "RPN computed server-side");
});

test("dry_run previews without creating", async () => {
    const { wb } = await downloadXlsx(adminCookie, "/api/records/excel-template?type=pfmea");
    const tableSheet = wb.worksheets.map((s) => s.name).find((n) => n !== "Form");
    fillTemplate(wb, { title: "Preview only", header: { process_name: "OP30" }, tableSheet, tableRows: [] });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const before = (await api(adminCookie, "GET", "/api/records?type=pfmea")).body.total;
    const dry = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea&dry_run=true", buffer);
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dry_run, true);
    assert.equal(dry.body.title, "Preview only");
    assert.equal(dry.body.header.process_name, "OP30");
    const after = (await api(adminCookie, "GET", "/api/records?type=pfmea")).body.total;
    assert.equal(after, before, "nothing was created");
});

test("a bad cell is a reported error, not a crash", async () => {
    const { wb } = await downloadXlsx(adminCookie, "/api/records/excel-template?type=pfmea");
    const tableSheet = wb.worksheets.map((s) => s.name).find((n) => n !== "Form");
    fillTemplate(wb, {
        title: "Bad data", header: { process_name: "OP40" }, tableSheet,
        tableRows: [{ "Process step / function": "x", "Sev": "not a number" }]
    });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea", buffer);
    assert.equal(up.status, 422);
    assert.ok(up.body.errors.some((e) => /number/i.test(e)), JSON.stringify(up.body.errors));
});

test("a filled record exports to Excel and round-trips", async () => {
    /* make a record in-app, export it, re-upload the export */
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "pfmea", title: "Round trip",
        data: { process_name: "OP50", analysis: [
            { process_step: "Deburr", failure_mode: "Missed", severity: 6, occurrence: 3, detection: 4 }
        ] }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const exported = await downloadXlsx(adminCookie, "/api/records/" + made.body.number + "/excel");
    assert.equal(exported.status, 200);
    const form = exported.wb.getWorksheet("Form");
    let processName;
    form.eachRow((row) => {
        if (String(row.getCell(1).value || "") === "process_name") processName = row.getCell(3).value;
    });
    assert.equal(processName, "OP50", "the export carries the filled values");

    const back = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea", exported.buffer);
    assert.equal(back.status, 201, JSON.stringify(back.body));
    const rec = await api(adminCookie, "GET", "/api/records/" + back.body.number);
    assert.equal(rec.body.record.data.process_name, "OP50");
    assert.equal(rec.body.record.data.analysis.length, 1);
});

test("unknown type and missing file are rejected", async () => {
    const noType = await uploadXlsx(adminCookie, "/api/records/excel?type=not_a_type",
        Buffer.from("x"));
    assert.equal(noType.status, 400);

    const noFile = await fetch(BASE + "/api/records/excel?type=pfmea",
        { method: "POST", headers: { Cookie: adminCookie } });
    assert.equal(noFile.status, 400);
});
