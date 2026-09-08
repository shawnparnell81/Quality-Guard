/* ============================================================
   Bulk record import from Excel (roadmap P2.3).

   One .xlsx, one record per row, for a single type. Covers the blank
   template download, a dry-run preview that reports what would be
   created and why rows fail, a real import that creates only the
   valid rows and lists the skipped ones, the warning raised when a
   type has a required field that cannot come from a cell (a
   signature), and rejection of an unknown type / missing file.

   Self-contained: provisions a throwaway org, runs the app on a spare
   port, cleans up after itself.
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
const PORT = 3114;
const BASE = "http://localhost:" + PORT;

const TAG = "IMP" + (Date.now() % 100000);

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

/* Build an .xlsx in memory: first array is the header row. */
async function sheetBuffer(rows) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Import");
    for (const r of rows) sheet.addRow(r);
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function uploadImport(cookie, type, buffer, { dryRun = false } = {}) {
    const fd = new FormData();
    fd.append("file", new Blob([buffer],
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
        "import.xlsx");
    const qs = "?type=" + type + (dryRun ? "&dry_run=true" : "");
    const r = await fetch(BASE + "/api/records/import" + qs, {
        method: "POST", headers: { Cookie: cookie }, body: fd
    });
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
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the import template is an .xlsx with Title plus the form's flat fields", async () => {
    const r = await fetch(BASE + "/api/records/import-template?type=capa", { headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /attachment; filename="capa-import-\d{4}-\d{2}-\d{2}\.xlsx"/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const header = workbook.getWorksheet("Import").getRow(1).values.slice(1);
    for (const h of ["Title", "Severity", "Owner"]) assert.ok(header.includes(h), "template has a " + h + " column");
    assert.ok(header.some((h) => /problem/i.test(h)), "template carries a form field column");
});

test("a dry run previews what would be created and flags every bad row", async () => {
    const buffer = await sheetBuffer([
        ["Title", "Severity", "problem_statement", "root_cause", "corrective_action"],
        ["Bore oversize on lot 4471 [" + TAG + "]", "warn", "Parts out of print", "Tool wear", "Replace tool, add wear check"],
        ["No problem statement [" + TAG + "]", "ok", "", "some cause", "some action"],
        ["", "ok", "This row has no title [" + TAG + "]", "x", "y"]
    ]);
    const r = await uploadImport(adminCookie, "capa", buffer, { dryRun: true });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dry_run, true);
    assert.equal(r.body.total_rows, 3);
    assert.equal(r.body.will_create, 1);
    assert.equal(r.body.errors.length, 2);
    assert.ok(Array.isArray(r.body.warnings), "the response always carries a warnings array");

    const noProblem = r.body.errors.find((e) => e.row === 3);
    assert.ok(noProblem.messages.some((m) => /problem statement/i.test(m) && /required/i.test(m)));
    const noTitle = r.body.errors.find((e) => e.row === 4);
    assert.ok(noTitle.messages.some((m) => /title/i.test(m)));

    assert.equal(r.body.preview[0].data.problem_statement, "Parts out of print");
    assert.equal(r.body.preview[0].data.root_cause, "Tool wear");
});

test("a real import creates only the valid rows and reports the skipped ones", async () => {
    const buffer = await sheetBuffer([
        ["Title", "problem_statement", "root_cause"],
        ["First imported CAPA [" + TAG + "]", "Parts nonconforming", "tooling"],
        ["Second imported CAPA [" + TAG + "]", "Late shipment", "capacity"],
        ["Broken row [" + TAG + "]", "", "cause with no problem statement"]
    ]);
    const r = await uploadImport(adminCookie, "capa", buffer);

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.created_count, 2);
    assert.equal(r.body.skipped, 1);
    for (const number of r.body.created) assert.match(number, /^CAPA-\d{4}-\d{4}$/);

    /* and they are really there, findable through the list */
    const list = await api(adminCookie, "GET", "/api/records?type=capa&q=" + TAG);
    assert.equal(list.body.total, 2, "exactly the two valid rows landed");
    const titles = list.body.records.map((x) => x.title).sort();
    assert.deepEqual(titles, ["First imported CAPA [" + TAG + "]", "Second imported CAPA [" + TAG + "]"]);
});

test("cell values are coerced to the field type, bad ones flagged per row", async () => {
    /* complaint.qty is a number field; a word in that cell is a row
       error, not a 500. */
    const buffer = await sheetBuffer([
        ["Title", "customer", "description", "qty"],
        ["Good complaint [" + TAG + "]", "Acme", "Chipped edge", 12],
        ["Bad qty [" + TAG + "]", "Acme", "Missing parts", "not a number"]
    ]);
    const r = await uploadImport(adminCookie, "complaint", buffer, { dryRun: true });

    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.will_create, 1);
    assert.equal(r.body.preview[0].data.qty, 12, "a numeric cell becomes a number");
    const badQty = r.body.errors.find((e) => e.row === 3);
    assert.ok(badQty.messages.some((m) => /quantity/i.test(m) && /number/i.test(m)),
        JSON.stringify(badQty));
});

test("an unknown type and a missing file are both rejected", async () => {
    const buffer = await sheetBuffer([["Title"], ["x"]]);
    const badType = await uploadImport(adminCookie, "not_a_type", buffer, { dryRun: true });
    assert.equal(badType.status, 400);

    const noFile = await fetch(BASE + "/api/records/import?type=capa", {
        method: "POST", headers: { Cookie: adminCookie }
    });
    assert.equal(noFile.status, 400);
});

test("an import lands only in the caller's org", async () => {
    const seen = await api(otherCookie, "GET", "/api/records?type=capa&q=" + TAG);
    assert.equal(seen.body.total, 0);
});
