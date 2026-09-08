/* ============================================================
   Register list endpoint: GET /api/records with sort, search and
   pagination (roadmap P2.1).

   Checks that the list route honours ?q= (ilike over number and
   title), ?sort=/?dir= against the column whitelist, ?limit=/?offset=
   paging, and that it returns `total` (the count under the same
   filters, before limit/offset) so a register can say "showing
   51-100 of 214". An unknown sort key falls back rather than erroring,
   and one org's count never leaks into another's.

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
const PORT = 3113;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;

/* A token stamped into every title this test creates, so a q= search
   isolates exactly our rows from anything provisioning seeded. */
const TAG = "ZZ" + (Date.now() % 100000);

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
            body: JSON.stringify({ current_password: pw, new_password: "Reg-List-Passphrase-1x" })
        });
        assert.equal(changed.status, 200, "forced password change should succeed");
        cookie = extractCookie(changed) || cookie;
    }
    return cookie;
}

/* Fetch an .xlsx export and read it back with exceljs. */
async function exportSheet(cookie, path) {
    const r = await fetch(BASE + path, { headers: { Cookie: cookie } });
    const buffer = Buffer.from(await r.arrayBuffer());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return { status: r.status, headers: r.headers, workbook, sheet: workbook.getWorksheet("Records") };
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

/* Seven NCRs whose titles sort into a known order (the leading word). */
const TITLES = [
    "Alpha bore diameter oversize",
    "Bravo surface finish out of spec",
    "Charlie thread pitch wrong",
    "Delta bore concentricity",
    "Echo weld porosity",
    "Foxtrot missing deburr",
    "Golf plating thickness low"
];
const created = [];

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
        companyName: "RegList Test A " + stamp,
        adminEmail: "reglist.a." + stamp + "@example.test", adminName: "RegList Admin A"
    });
    other = await provisionOrganization({
        companyName: "RegList Test B " + stamp,
        adminEmail: "reglist.b." + stamp + "@example.test", adminName: "RegList Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    for (const base of TITLES) {
        const r = await api(adminCookie, "POST", "/api/records", {
            type: "ncr", title: base + " [" + TAG + "]",
            data: { disposition: "Rework" }
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        created.push(r.body.number);
    }
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("q= isolates matching rows and total counts them all", async () => {
    const r = await api(adminCookie, "GET", "/api/records?type=ncr&q=" + TAG);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, TITLES.length, "total is the count under the filter");
    assert.equal(r.body.records.length, TITLES.length);
    assert.equal(r.body.count, r.body.records.length);
    for (const row of r.body.records) assert.match(row.title, new RegExp(TAG));
});

test("q= also matches on the record number", async () => {
    const target = created[2];
    const r = await api(adminCookie, "GET", "/api/records?type=ncr&q=" + encodeURIComponent(target));
    assert.equal(r.body.total, 1);
    assert.equal(r.body.records[0].number, target);
});

test("limit + offset page through the set without overlap", async () => {
    const page1 = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=title&dir=asc&limit=3&offset=0");
    const page2 = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=title&dir=asc&limit=3&offset=3");
    const page3 = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=title&dir=asc&limit=3&offset=6");

    assert.equal(page1.body.total, 7);
    assert.equal(page1.body.records.length, 3);
    assert.equal(page2.body.records.length, 3);
    assert.equal(page3.body.records.length, 1, "the tail page has the remainder");

    const seen = [...page1.body.records, ...page2.body.records, ...page3.body.records]
        .map((r) => r.number);
    assert.equal(new Set(seen).size, 7, "no row appears on two pages");
});

test("sort=title orders by title, and dir flips it", async () => {
    const asc = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=title&dir=asc");
    const titles = asc.body.records.map((r) => r.title);
    const sorted = [...titles].sort();
    assert.deepEqual(titles, sorted, "ascending by title");

    const desc = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=title&dir=desc");
    assert.deepEqual(desc.body.records.map((r) => r.title), [...sorted].reverse());
});

test("an unknown sort key falls back instead of erroring", async () => {
    const r = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&sort=data);drop&dir=sideways");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.records.length, 7, "still returns the set, default order");
});

test("total is the filtered count, not the page size", async () => {
    const r = await api(adminCookie, "GET",
        "/api/records?type=ncr&q=" + TAG + "&limit=2");
    assert.equal(r.body.records.length, 2);
    assert.equal(r.body.total, 7, "total ignores limit/offset");
});

test("one org's rows and count never leak into another", async () => {
    const r = await api(otherCookie, "GET", "/api/records?type=ncr&q=" + TAG);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 0);
    assert.equal(r.body.records.length, 0);
});

test("export returns an .xlsx of the filtered set", async () => {
    const { status, headers, sheet } = await exportSheet(adminCookie,
        "/api/records/export?type=ncr&q=" + TAG + "&sort=title&dir=asc");

    assert.equal(status, 200);
    assert.match(headers.get("content-type"), /spreadsheetml\.sheet/);
    assert.match(headers.get("content-disposition"), /attachment; filename="ncr-register-\d{4}-\d{2}-\d{2}\.xlsx"/);

    assert.ok(sheet, "the workbook has a Records sheet");
    assert.equal(sheet.rowCount, TITLES.length + 1, "one header row plus every filtered record");

    const header = sheet.getRow(1).values.slice(1);   // exceljs 1-indexes
    assert.ok(header.includes("Number"));
    assert.ok(header.includes("Title"));
    assert.ok(header.includes("Disposition"), "data keys become columns");

    /* sort=title asc is honoured in the sheet, too. */
    const titleCol = header.indexOf("Title") + 1;
    const titles = [];
    for (let r = 2; r <= sheet.rowCount; r++) titles.push(sheet.getRow(r).getCell(titleCol).value);
    assert.deepEqual(titles, [...titles].sort());
});

test("export respects tenant isolation", async () => {
    const { sheet } = await exportSheet(otherCookie, "/api/records/export?type=ncr&q=" + TAG);
    assert.equal(sheet.rowCount, 1, "header only - none of org A's rows");
});
