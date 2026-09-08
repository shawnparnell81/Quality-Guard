/* ============================================================
   GET /api/metrics - the dashboard's data-urgency metric cards.

   Three numbers counted live from the registers they summarise:
   open NCs, pending CAPAs, and released documents whose current
   revision took effect more than 12 months ago (an overdue review).
   Auth only, org-scoped, no permission gate - the same as
   GET /api/dashboard.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const PORT = 3137;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
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
            body: JSON.stringify({ current_password: pw, new_password: "Dash-Metrics-Test-1x" })
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

const metrics = (cookie) => api(cookie, "GET", "/api/metrics");

const RAISE_DEFAULTS = {
    ncr: { disposition: "Rework" },
    capa: { problem_statement: "x", why_1: "a", why_2: "b", why_3: "c" }
};

async function raise(cookie, type, title) {
    const r = await api(cookie, "POST", "/api/records", {
        type, title, data: RAISE_DEFAULTS[type] || {}
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
        companyName: "Dash Metrics A " + stamp,
        adminEmail: "dm.a." + stamp + "@example.test", adminName: "DM Admin A"
    });
    other = await provisionOrganization({
        companyName: "Dash Metrics B " + stamp,
        adminEmail: "dm.b." + stamp + "@example.test", adminName: "DM Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
});

after(async () => {
    if (tenant) await query("delete from record_audit where org_id = $1", [tenant.orgId]);
    if (other) await query("delete from record_audit where org_id = $1", [other.orgId]);
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a fresh org reports three zeroes with the right shape", async () => {
    const r = await metrics(adminCookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.generated_at, "string");
    assert.deepEqual(
        { a: r.body.open_ncs, b: r.body.pending_capas, c: r.body.overdue_doc_reviews },
        { a: 0, b: 0, c: 0 }
    );
});

test("open NCs and pending CAPAs are counted, closed ones drop off", async () => {
    const n1 = await raise(adminCookie, "ncr", "Porosity A");
    await raise(adminCookie, "ncr", "Porosity B");
    await raise(adminCookie, "capa", "Systemic fix");

    let r = await metrics(adminCookie);
    assert.equal(r.body.open_ncs, 2);
    assert.equal(r.body.pending_capas, 1);

    /* close one NCR the way a terminal transition would */
    await query("update records set closed_at = now() where org_id = $1 and number = $2",
        [tenant.orgId, n1]);

    r = await metrics(adminCookie);
    assert.equal(r.body.open_ncs, 1, "a closed NC is no longer open");
    assert.equal(r.body.pending_capas, 1);
});

test("a released document whose review lapsed 12 months ago is overdue", async () => {
    const made = await api(adminCookie, "POST", "/api/documents", {
        doc_number: "DM-WI-1", title: "Deburr WI", versioning: "numeric",
        body: "Break sharp edges."
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await api(adminCookie, "POST", "/api/documents/DM-WI-1/revisions/1.0/release");

    /* freshly released -> not overdue yet */
    assert.equal((await metrics(adminCookie)).body.overdue_doc_reviews, 0);

    /* backdate its effective date past the annual review window */
    await query(`
        update document_revisions set effective_date = current_date - interval '13 months'
         where revision = '1.0'
           and document_id = (select id from documents where org_id = $1 and doc_number = 'DM-WI-1')
    `, [tenant.orgId]);

    assert.equal((await metrics(adminCookie)).body.overdue_doc_reviews, 1);
});

test("another org's records and documents do not count", async () => {
    const otherAdmin = await loginAs(other.admin.email, other.temporaryPassword);
    const r = await metrics(otherAdmin);
    assert.deepEqual(
        { a: r.body.open_ncs, b: r.body.pending_capas, c: r.body.overdue_doc_reviews },
        { a: 0, b: 0, c: 0 }
    );
});
