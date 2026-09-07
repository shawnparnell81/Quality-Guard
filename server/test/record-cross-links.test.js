/* ============================================================
   Links between records (form-to-form linking).

   record_links already stores these; this covers the routes that
   let a user make and break one: POST /api/records/:number/links,
   DELETE /api/records/:number/links/:target. A link reads the same
   from both ends, self-links and duplicates are refused, and neither
   end can be a record in another org.
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
const PORT = 3106;
const BASE = "http://localhost:" + PORT;

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
            body: JSON.stringify({ current_password: pw, new_password: "Links-Test-Passphrase-1x" })
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

async function makeNcr(cookie, title) {
    const r = await api(cookie, "POST", "/api/records", {
        type: "ncr", title, data: { disposition: "Rework" }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number;
}
async function makeCapa(cookie, title) {
    const r = await api(cookie, "POST", "/api/records", {
        type: "capa", title, data: { problem_statement: "x" }
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
        companyName: "Links Test A " + stamp,
        adminEmail: "links.a." + stamp + "@example.test", adminName: "Links Admin A"
    });
    other = await provisionOrganization({
        companyName: "Links Test B " + stamp,
        adminEmail: "links.b." + stamp + "@example.test", adminName: "Links Admin B"
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

test("a link reads the same from both records", async () => {
    const ncr = await makeNcr(adminCookie, "NCR to link");
    const capa = await makeCapa(adminCookie, "CAPA to link");

    const made = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", {
        to: capa, link_type: "corrects"
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const fromNcr = await api(adminCookie, "GET", "/api/records/" + ncr);
    const linkOut = fromNcr.body.links.find((l) => l.number === capa);
    assert.ok(linkOut, "NCR shows the CAPA");
    assert.equal(linkOut.type, "capa");
    assert.equal(linkOut.link_type, "corrects");

    const fromCapa = await api(adminCookie, "GET", "/api/records/" + capa);
    assert.ok(fromCapa.body.links.some((l) => l.number === ncr), "CAPA shows the NCR");
});

test("a duplicate link, either direction, is refused", async () => {
    const ncr = await makeNcr(adminCookie, "NCR dup");
    const capa = await makeCapa(adminCookie, "CAPA dup");

    const a = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", { to: capa });
    assert.equal(a.status, 201);

    const b = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", { to: capa });
    assert.equal(b.status, 409);

    const reverse = await api(adminCookie, "POST", "/api/records/" + capa + "/links", { to: ncr });
    assert.equal(reverse.status, 409);
});

test("a record cannot link to itself, or to a number that does not exist", async () => {
    const ncr = await makeNcr(adminCookie, "NCR self");
    const self = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", { to: ncr });
    assert.equal(self.status, 400);

    const ghost = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", { to: "NCR-1999-9999" });
    assert.equal(ghost.status, 404);
});

test("an unknown link_type falls back to related", async () => {
    const ncr = await makeNcr(adminCookie, "NCR type");
    const capa = await makeCapa(adminCookie, "CAPA type");
    const made = await api(adminCookie, "POST", "/api/records/" + ncr + "/links", {
        to: capa, link_type: "nonsense"
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.link_type, "related");
});

test("unlinking removes the row from both directions", async () => {
    const ncr = await makeNcr(adminCookie, "NCR unlink");
    const capa = await makeCapa(adminCookie, "CAPA unlink");
    await api(adminCookie, "POST", "/api/records/" + ncr + "/links", { to: capa });

    const gone = await api(adminCookie, "DELETE", "/api/records/" + capa + "/links/" + ncr);
    assert.equal(gone.status, 200);

    const after = await api(adminCookie, "GET", "/api/records/" + ncr);
    assert.equal(after.body.links.some((l) => l.number === capa), false);

    const again = await api(adminCookie, "DELETE", "/api/records/" + ncr + "/links/" + capa);
    assert.equal(again.status, 404);
});

test("a link is confined to the caller's own org", async () => {
    const mine = await makeNcr(adminCookie, "NCR mine");

    /* Offset org B's numbering so its next NCR gets a number org A
       does not have. */
    for (let i = 0; i < 8; i++) await makeNcr(otherCookie, "offset " + i);
    const theirs = await makeNcr(otherCookie, "NCR theirs");

    assert.equal((await api(adminCookie, "GET", "/api/records/" + theirs)).status, 404,
        "org A cannot see org B's record");

    /* Every lookup is org-scoped, so org A cannot name org B's record
       as either end of a link. */
    const badTarget = await api(adminCookie, "POST", "/api/records/" + mine + "/links", { to: theirs });
    assert.equal(badTarget.status, 404);

    const badSource = await api(adminCookie, "POST", "/api/records/" + theirs + "/links", { to: mine });
    assert.equal(badSource.status, 404);

    /* org B's link activity never lands on org A's record. */
    await api(otherCookie, "POST", "/api/records/" + theirs + "/links",
        { to: (await makeCapa(otherCookie, "B capa")) });
    const aStill = await api(adminCookie, "GET", "/api/records/" + mine);
    assert.equal(aStill.body.links.length, 0);
});

test("linking needs a session", async () => {
    const ncr = await makeNcr(adminCookie, "NCR noauth");
    const capa = await makeCapa(adminCookie, "CAPA noauth");
    const r = await fetch(BASE + "/api/records/" + ncr + "/links", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: capa })
    });
    assert.equal(r.status, 401);
});
