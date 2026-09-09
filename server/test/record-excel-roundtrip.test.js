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

    /* the spreadsheet the user filled is kept on the record */
    assert.equal(up.body.source_attached, true);
    const atts = await api(adminCookie, "GET", "/api/records/" + up.body.number + "/attachments");
    assert.ok(atts.body.attachments.some((a) => /\.xlsx$/i.test(a.filename)),
        "the filled workbook is attached: " + JSON.stringify(atts.body.attachments));
});

test("a spreadsheet that is not a filled template is rejected, not made into an empty record", async () => {
    /* a bare workbook with an unrelated sheet - the shape a user's own
       hand-built form has */
    const junk = new ExcelJS.Workbook();
    const s = junk.addWorksheet("My 8D Form");
    s.addRow(["Problem Statement:", ""]);
    s.addRow(["Team Leader:", ""]);
    const buffer = Buffer.from(await junk.xlsx.writeBuffer());

    const countPfmea = async () => (await query(
        "select count(*)::int n from records r join record_types rt on rt.id = r.record_type_id "
        + "where rt.org_id = $1 and rt.key = 'pfmea'", [tenant.orgId])).rows[0].n;

    const before = await countPfmea();
    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea", buffer);
    assert.equal(up.status, 422, JSON.stringify(up.body));
    assert.match(up.body.error, /Excel template/i);
    assert.equal(await countPfmea(), before, "no record was created from the junk file");
});

test("a bundled template installs with its own spreadsheet as the layout, and fills from it", async () => {
    /* work_order_form ships server/src/form-templates/excel/work_order_form.xlsx
       + .map.json - installing it stamps that layout onto form v1. */
    const install = await api(adminCookie, "POST", "/api/form-templates/work_order_form/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));
    assert.equal(install.body.excel_template, true, "the bundled spreadsheet was attached on install");

    /* the blank template download is the customer's own file - its own
       sheet name, no generated "Form" sheet */
    const { status, wb } = await downloadXlsx(adminCookie,
        "/api/records/excel-template?type=work_order_form");
    assert.equal(status, 200);
    assert.ok(wb.getWorksheet("Work Order Template"), "download is the bundled layout");
    assert.equal(wb.getWorksheet("Form"), undefined, "not the generated Field/Value grid");

    /* fill the customer layout: header cells + two routing rows */
    const ws = wb.getWorksheet("Work Order Template");
    ws.getCell("B5").value = "WO-7788";
    ws.getCell("F5").value = "PN-4471-C";
    ws.getCell("B6").value = "Ridgeline Precision";
    /* routing grid: header is row 15, data from row 16 */
    ws.getCell("A16").value = "10"; ws.getCell("B16").value = "Receiving"; ws.getCell("C16").value = "WH-1";
    ws.getCell("A17").value = "20"; ws.getCell("B17").value = "CNC Mill"; ws.getCell("C17").value = "CNC-3";
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=work_order_form", buffer);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.number, /^WOF-\d{4}-\d{4}$/);
    assert.equal(up.body.source_attached, true);

    const rec = await api(adminCookie, "GET", "/api/records/" + up.body.number);
    const d = rec.body.record.data;
    assert.equal(d.work_order_number, "WO-7788");
    assert.equal(d.part_number, "PN-4471-C");
    assert.equal(d.customer, "Ridgeline Precision");
    assert.equal(d.routing.length, 2, "both routing rows read from the customer layout");
    assert.equal(d.routing[0].op_number, "10");
    assert.equal(d.routing[1].operation_desc, "CNC Mill");
});

test("the bundled 8D form fills from the user's own Blank 8D sheet", async () => {
    const install = await api(adminCookie, "POST", "/api/form-templates/eight_d_report/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));
    assert.equal(install.body.excel_template, true);

    const { status, wb } = await downloadXlsx(adminCookie,
        "/api/records/excel-template?type=eight_d_report");
    assert.equal(status, 200);
    assert.ok(wb.getWorksheet("Blank 8D"), "download is the customer's own 8D sheet");

    const ws = wb.getWorksheet("Blank 8D");
    ws.getCell("D7").value = "Global Automotive Corp";       // customer
    ws.getCell("D13").value = "PN-4471";                     // part no / code
    ws.getCell("F21").value = "Porosity at final inspection, 12 of 400 on lot 88.";
    ws.getCell("C31").value = "100% sort at outgoing dock; suspect lots held.";
    ws.getCell("C40").value = "Mould vent blocked - gas entrapment during pour.";
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=eight_d_report", buffer);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.number, /^D8R-\d{4}-\d{4}$/);

    const rec = await api(adminCookie, "GET", "/api/records/" + up.body.number);
    const d = rec.body.record.data;
    assert.equal(d.customer, "Global Automotive Corp");
    assert.equal(d.part_no_code, "PN-4471");
    assert.match(d.problem_statement, /Porosity at final inspection/);
    assert.match(d.containment_actions, /100% sort/);
    assert.match(d.root_cause, /Mould vent blocked/);
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

test("a required field the sheet did not fill is a warning, and the record is still created", async () => {
    const { wb } = await downloadXlsx(adminCookie, "/api/records/excel-template?type=pfmea");
    const tableSheet = wb.worksheets.map((s) => s.name).find((n) => n !== "Form");
    /* title only - process_name (required) left blank */
    fillTemplate(wb, { title: "Started in Excel", header: {}, tableSheet, tableRows: [] });
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const dry = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea&dry_run=true", buffer);
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.errors, [], "no hard errors");
    assert.ok(dry.body.warnings.some((w) => /process name/i.test(w)), JSON.stringify(dry.body.warnings));

    const up = await uploadXlsx(adminCookie, "/api/records/excel?type=pfmea", buffer);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.ok(up.body.warnings.some((w) => /process name/i.test(w)), JSON.stringify(up.body.warnings));

    const rec = await api(adminCookie, "GET", "/api/records/" + up.body.number);
    assert.equal(rec.body.record.title, "Started in Excel");
    assert.equal(rec.body.record.data.process_name, undefined, "the blank required field stayed blank");
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
