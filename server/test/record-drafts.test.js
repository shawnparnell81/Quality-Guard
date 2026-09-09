/* ============================================================
   Server-side record drafts + "unsaved changes" awareness
   (audit P3 / M15).

   PUT/GET/DELETE /api/records/drafts/<type>:<number|new> keep one
   draft per user, so an in-progress entry survives a device change;
   the presence heartbeat now carries a `dirty` flag so another editor
   is told when someone has unsaved changes, not just that they have
   the record open.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3144;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let aCookie;
let bCookie;
let ncrNumber;

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
            body: JSON.stringify({ current_password: pw, new_password: "Drafts-Test-Passphrase-1" })
        });
        assert.equal(changed.status, 200);
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
        companyName: "Drafts " + stamp,
        adminEmail: "drafts.a." + stamp + "@example.test", adminName: "Drafts A"
    });
    aCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const b = await api(aCookie, "POST", "/api/users", {
        full_name: "Drafts B", email: "drafts.b." + stamp + "@example.test",
        initials: "DB" + (stamp % 100000), role: "quality_manager"
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    bCookie = await loginAs(b.body.email || ("drafts.b." + stamp + "@example.test"), b.body.temporary_password);

    const ncr = await api(aCookie, "POST", "/api/records", {
        type: "ncr", title: "Drafts anchor NCR", data: { disposition: "Rework" }
    });
    assert.equal(ncr.status, 201, JSON.stringify(ncr.body));
    ncrNumber = ncr.body.number;
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

const snap = { at: Date.now(), snap: { title: "half-typed", severity: "warn", due_at: null, data: { disposition: "Scrap" } } };

test("a draft round-trips and is per-user", async () => {
    const put = await api(aCookie, "PUT", "/api/records/drafts/ncr:new", { snapshot: snap });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const got = await api(aCookie, "GET", "/api/records/drafts/ncr:new");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.snapshot, snap);

    /* B has their own namespace */
    assert.equal((await api(bCookie, "GET", "/api/records/drafts/ncr:new")).status, 404);

    const del = await api(aCookie, "DELETE", "/api/records/drafts/ncr:new");
    assert.equal(del.status, 200);
    assert.equal((await api(aCookie, "GET", "/api/records/drafts/ncr:new")).status, 404);
});

test("PUT upserts, and a bad key or empty body is rejected", async () => {
    await api(aCookie, "PUT", "/api/records/drafts/ncr:" + ncrNumber, { snapshot: { v: 1 } });
    await api(aCookie, "PUT", "/api/records/drafts/ncr:" + ncrNumber, { snapshot: { v: 2 } });
    const got = await api(aCookie, "GET", "/api/records/drafts/ncr:" + ncrNumber);
    assert.deepEqual(got.body.snapshot, { v: 2 }, "second PUT replaced the first");

    assert.equal((await api(aCookie, "PUT", "/api/records/drafts/has spaces", { snapshot: {} })).status, 400);
    assert.equal((await api(aCookie, "PUT", "/api/records/drafts/ncr:new", {})).status, 400);
});

test("the editing heartbeat carries an unsaved-changes flag between editors", async () => {
    /* A opens the record, clean */
    await api(aCookie, "PUT", "/api/records/" + ncrNumber + "/editing", { dirty: false });
    /* B opens it and reports unsaved changes */
    await api(bCookie, "PUT", "/api/records/" + ncrNumber + "/editing", { dirty: true });

    /* A's next heartbeat now sees B as dirty */
    const aSees = await api(aCookie, "PUT", "/api/records/" + ncrNumber + "/editing", { dirty: false });
    assert.equal(aSees.status, 200);
    assert.equal(aSees.body.editors.length, 1);
    assert.equal(aSees.body.editors[0].dirty, true, "B is flagged as having unsaved changes");

    /* B saves / cleans up -> flag clears */
    await api(bCookie, "PUT", "/api/records/" + ncrNumber + "/editing", { dirty: false });
    const cleared = await api(aCookie, "PUT", "/api/records/" + ncrNumber + "/editing", { dirty: false });
    assert.equal(cleared.body.editors[0].dirty, false);
});
