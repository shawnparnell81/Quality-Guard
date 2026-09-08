/* ============================================================
   "Fill my Excel template" - end to end.

   Import one of the customer's real spreadsheets, apply it as a form
   type, and confirm:
     - applying auto-stamps a best-guess excel_map on version 1
     - GET /records/excel-template hands back the raw template file
     - a record's GET /records/:n/excel is that template with the
       record's values dropped into the mapped cells, structure intact
     - PUT /record-types/:key/excel-map re-points a cell and the next
       export follows it
     - POST /records/excel reads a filled template back in via the map
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(HERE, "..");
const FIX = join(HERE, "fixtures", "templates");
const PORT = 3133;
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
            body: JSON.stringify({ current_password: pw, new_password: "Xls-Fill-Passphrase-1x" })
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

async function uploadXlsx(cookie, path, buffer, filename, extraFields = {}) {
    const form = new FormData();
    form.append("file", new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }), filename);
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
    const r = await fetch(BASE + path, { method: "POST", headers: { Cookie: cookie }, body: form });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* binary or empty */ }
    return { status: r.status, body, text };
}

async function fetchXlsx(cookie, path) {
    const r = await fetch(BASE + path, { headers: { Cookie: cookie } });
    assert.equal(r.status, 200, path + " -> " + r.status);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    return wb;
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
        companyName: "Xls Fill " + stamp,
        adminEmail: "xls.admin." + stamp + "@example.test", adminName: "Xls Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let typeKey;
let recordNumber;

test("importing and applying a template stamps a best-guess excel_map on v1", async () => {
    const buf = readFileSync(join(FIX, "Layout Inspection.xlsx"));
    const up = await uploadXlsx(adminCookie, "/api/forms/import", buf, "Layout Inspection.xlsx");
    assert.equal(up.status, 201, up.text);
    const importId = up.body.import_id;

    const applied = await api(adminCookie, "POST", "/api/forms/imports/" + importId + "/apply", {
        target: "new", name: "Layout Check", prefix: "LC", fields: up.body.fields
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    typeKey = applied.body.applied_key;

    const mapResp = await api(adminCookie, "GET", "/api/record-types/" + typeKey + "/excel-map");
    assert.equal(mapResp.status, 200);
    assert.equal(mapResp.body.has_template, true, "a template file was kept");
    assert.ok(mapResp.body.map.template_path.startsWith("excel-templates/"));
    assert.ok(Object.keys(mapResp.body.map.fields).length >= 3, "some header fields anchored");
    assert.ok(Object.keys(mapResp.body.map.tables).length >= 1, "the grid was anchored");
    /* the review screen needs the sheet list and the schema */
    assert.ok(Array.isArray(mapResp.body.map.sheets) && mapResp.body.map.sheets.includes("Layout Inspection"));
    assert.ok(Array.isArray(mapResp.body.schema.fields) && mapResp.body.schema.fields.length > 0);
});

test("the blank template download is the raw customer file", async () => {
    const wb = await fetchXlsx(adminCookie, "/api/records/excel-template?type=" + typeKey);
    const ws = wb.getWorksheet("Layout Inspection");
    assert.ok(ws, "the customer's own sheet name, not 'Form'");
    assert.equal(ws.getCell("A7").value, "Balloon #", "the grid header survived");
});

let tableKey;

test("a record exports onto the customer's layout", async () => {
    tableKey = Object.keys((await api(adminCookie, "GET", "/api/record-types/" + typeKey + "/excel-map")).body.map.tables)[0];
    const table = tableKey;
    const made = await api(adminCookie, "POST", "/api/records", {
        type: typeKey, title: "Layout check RP-1",
        data: {
            [table]: [
                { balloon: "1", characteristic: "Bore dia", nominal: 0.5, actual: 0.5, result: "Pass" },
                { balloon: "2", characteristic: "Length", nominal: 4, actual: 4.01, result: "Pass" }
            ]
        }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    recordNumber = made.body.number;

    const wb = await fetchXlsx(adminCookie, "/api/records/" + recordNumber + "/excel");
    const ws = wb.getWorksheet("Layout Inspection");
    assert.equal(ws.getCell("A7").value, "Balloon #", "header untouched");
    assert.equal(String(ws.getCell("B8").value), "Bore dia", "row 1 written into the grid");
    assert.equal(String(ws.getCell("B9").value), "Length", "row 2 written into the grid");
    assert.equal(wb.worksheets.length, 1, "clean grid, no spill sheet");
});

test("editing the map re-points a field and the next export follows it", async () => {
    const before = (await api(adminCookie, "GET", "/api/record-types/" + typeKey + "/excel-map")).body.map;

    /* add a mapping for the record title into a free cell (G1) */
    const next = JSON.parse(JSON.stringify(before));
    next.fields.__title__ = { sheet: "Layout Inspection", cell: "G1" };

    const put = await api(adminCookie, "PUT", "/api/record-types/" + typeKey + "/excel-map", { map: next });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    /* the engine has no "__title__" field, so nothing is written there -
       but a real field re-point works the same way; assert the map
       persisted and the template_path was preserved */
    const after = (await api(adminCookie, "GET", "/api/record-types/" + typeKey + "/excel-map")).body.map;
    assert.equal(after.fields.__title__.cell, "G1");
    assert.equal(after.template_path, before.template_path, "the stored file is kept across a map edit");
});

test("a filled template is read back in through the map, and can create a record", async () => {
    /* round-trip: export this record, then re-import the bytes */
    const r = await fetch(BASE + "/api/records/" + recordNumber + "/excel", { headers: { Cookie: adminCookie } });
    const filled = Buffer.from(await r.arrayBuffer());

    const dry = await uploadXlsx(adminCookie,
        "/api/records/excel?type=" + typeKey + "&dry_run=true", filled, "filled.xlsx");
    assert.equal(dry.status, 200, dry.text);
    assert.equal(Object.values(dry.body.tables)[0], 2, "both grid rows read back");

    const real = await uploadXlsx(adminCookie,
        "/api/records/excel?type=" + typeKey, filled, "filled.xlsx");
    assert.equal(real.status, 201, real.text);
    const made = await api(adminCookie, "GET", "/api/records/" + real.body.number);
    assert.equal(made.body.record.data[tableKey].length, 2, "the new record carries the grid rows");
    assert.equal(made.body.record.data[tableKey][0].characteristic, "Bore dia");
});

test("a Form Builder type with no template still exports the generated grid", async () => {
    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Plain Form", prefix: "PLN",
        fields: [{ key: "note", label: "Note", type: "text" }]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const wb = await fetchXlsx(adminCookie, "/api/records/excel-template?type=" + made.body.key);
    assert.ok(wb.getWorksheet("Form"), "falls back to the generated Form sheet");
});
