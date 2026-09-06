/* ============================================================
   Tenant isolation, proven end to end.

   QualityGuard's multi-tenancy is application-level, not Postgres
   Row-Level Security: every query that touches the records table
   filters by org_id, taken from the signed-in user's session, never
   from anything the client sends. This suite spins up two throwaway
   organizations against a real running instance of the app and
   proves, through the actual HTTP API, that one can never read,
   list, search, alter, or transition the other's records - and that
   the specific cross-tenant leak fixed earlier this project (workflow
   transitions matched on a type *key*, which collides across tenants,
   instead of the type's real per-org id) cannot recur silently.

   Self-contained: provisions its own two orgs, runs the app as a
   child process on a throwaway port, and deletes everything it made
   afterward. Never touches seed data or a real customer's org.
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

const PORT = 3099;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenantA, tenantB;
let cookieA, cookieB;
let recordA, recordB;

/* ---------- tiny HTTP helpers - no supertest, no cookie jar library.
   fetch() does not manage cookies across calls on its own, so the
   session cookie is captured once at login and threaded through
   every call by hand, same as a real client would carry it. ---------- */

function extractCookie(response) {
    const raw = response.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

async function loginAs(email, temporaryPassword) {
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: temporaryPassword })
    });
    assert.equal(login.status, 200, "login should succeed for a freshly provisioned admin");

    const body = await login.json();
    const cookie = extractCookie(login);
    assert.ok(cookie, "login should set a session cookie");

    if (body.must_change_password) {
        const changed = await fetch(BASE + "/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: temporaryPassword, new_password: "Isolation-Test-999x" })
        });
        assert.equal(changed.status, 200, "forced password change should succeed");
        // The endpoint ends every *other* session, not this one - the
        // cookie already in hand keeps working.
    }

    return cookie;
}

async function api(cookie, method, path, payload) {
    const response = await fetch(BASE + path, {
        method,
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not every response is JSON */ }
    return { status: response.status, body };
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(BASE + "/api/health");
            if (response.ok) return;
        } catch { /* not listening yet */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

/* ---------- fixtures ---------- */

before(async () => {
    serverProcess = spawn(
        process.execPath,
        ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" }
    );

    let bootLog = "";
    serverProcess.stdout.on("data", (chunk) => { bootLog += chunk; });
    serverProcess.stderr.on("data", (chunk) => { bootLog += chunk; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("Test server exited early:\n" + bootLog);
    });

    await waitForHealth(15000);

    const stamp = Date.now();
    tenantA = await provisionOrganization({
        companyName: "Isolation Test A " + stamp,
        adminEmail: "isolation.a." + stamp + "@example.test",
        adminName: "Tenant A Admin"
    });
    tenantB = await provisionOrganization({
        companyName: "Isolation Test B " + stamp,
        adminEmail: "isolation.b." + stamp + "@example.test",
        adminName: "Tenant B Admin"
    });

    cookieA = await loginAs(tenantA.admin.email, tenantA.temporaryPassword);
    cookieB = await loginAs(tenantB.admin.email, tenantB.temporaryPassword);

    const created = await api(cookieA, "POST", "/api/records", {
        type: "ncr", title: "Tenant A's own nonconformance",
        data: { disposition: "Rework" }
    });
    assert.equal(created.status, 201, "Tenant A should be able to raise its own NCR");
    recordA = created.body;

    /* Record numbers are only unique per tenant, not globally - a
       fresh org always starts its own count at 0001, so two brand-new
       orgs' first records land on the identical number by design.
       Raising one throwaway record in Tenant B first guarantees
       recordA.number and recordB.number actually differ, which is
       what makes "fetch the other tenant's number" a real test of the
       org_id boundary rather than an accidental same-tenant hit. */
    await api(cookieB, "POST", "/api/records", {
        type: "ncr", title: "Tenant B throwaway, only to offset numbering",
        data: { disposition: "Scrap" }
    });

    const createdB = await api(cookieB, "POST", "/api/records", {
        type: "ncr", title: "Tenant B's own nonconformance - never Tenant A's business",
        data: { disposition: "Scrap" }
    });
    assert.equal(createdB.status, 201, "Tenant B should be able to raise its own NCR");
    recordB = createdB.body;

    assert.notEqual(recordA.number, recordB.number,
        "fixture bug: the two tenants' test records must have different numbers");
});

after(async () => {
    await query("delete from organizations where id = $1", [tenantA.orgId]);
    await query("delete from organizations where id = $1", [tenantB.orgId]);
    await pool.end();
    serverProcess.kill();
});

/* ---------- sanity: the boundary does not block legitimate access ---------- */

test("a tenant can read its own record", async () => {
    const result = await api(cookieA, "GET", "/api/records/" + recordA.number);
    assert.equal(result.status, 200);
    assert.equal(result.body.record.number, recordA.number);
});

/* ---------- the boundary: read ----------

   Record numbers reset per tenant ("NCR-2026-0001" is not a global
   identity, just the first NCR *this org* ever raised), so a
   cross-tenant fetch has two safe outcomes, not one: genuinely
   nothing there (404), or a coincidental hit on the fetching
   tenant's *own* record that happens to share the number. Either is
   fine. The only failure is ever receiving the other tenant's actual
   data - which is what these assert directly, rather than assuming
   404 is the only acceptable status. */

function assertNeverLeaked(result, otherTenantsRecord) {
    if (result.status === 404) return;
    assert.equal(result.status, 200, "expected either 404 or a safe 200, got " + result.status);
    assert.notEqual(result.body.record.title, otherTenantsRecord.title,
        "received the other tenant's actual record under a coincidentally shared number");
}

test("Tenant A cannot fetch Tenant B's record by number", async () => {
    const result = await api(cookieA, "GET", "/api/records/" + recordB.number);
    assertNeverLeaked(result, recordB);
});

test("Tenant B cannot fetch Tenant A's record by number", async () => {
    const result = await api(cookieB, "GET", "/api/records/" + recordA.number);
    assertNeverLeaked(result, recordA);
});

/* ---------- the boundary: list and search ---------- */

test("Tenant A's register never lists Tenant B's record", async () => {
    const result = await api(cookieA, "GET", "/api/records?type=ncr");
    assert.equal(result.status, 200);
    const numbers = result.body.records.map((r) => r.number);
    assert.ok(!numbers.includes(recordB.number), "Tenant B's record leaked into Tenant A's register");
});

test("Tenant A's search never surfaces Tenant B's record, even by exact title", async () => {
    const result = await api(cookieA, "GET", "/api/records/search?q=" + encodeURIComponent("Tenant B's own"));
    assert.equal(result.status, 200);
    assert.equal(result.body.records.length, 0, "search leaked another tenant's record");
});

/* ---------- the boundary: write ---------- */

test("Tenant A cannot alter Tenant B's record", async () => {
    // The number Tenant A is attacking might, by coincidence, also be
    // one of Tenant A's own record numbers (see the note above) - so
    // the attempt itself succeeding proves nothing either way. What
    // matters, and is checked here directly, is whether Tenant B's
    // real record was ever touched.
    const before = await api(cookieB, "GET", "/api/records/" + recordB.number);
    const beforeContainment = before.body.record.data.containment;

    await api(cookieA, "PATCH", "/api/records/" + recordB.number, {
        data: { containment: "Tenant A should never be able to write this" }
    });

    const after = await api(cookieB, "GET", "/api/records/" + recordB.number);
    assert.equal(after.body.record.data.containment, beforeContainment,
        "Tenant B's record changed after Tenant A's cross-tenant write attempt");
});

test("Tenant A cannot transition Tenant B's record's workflow state", async () => {
    const before = await api(cookieB, "GET", "/api/records/" + recordB.number);
    const firstMove = before.body.transitions[0];
    assert.ok(firstMove, "fixture record should have at least one legal move to attempt");

    await api(cookieA, "POST", "/api/records/" + recordB.number + "/transition", { to: firstMove.to });

    const after = await api(cookieB, "GET", "/api/records/" + recordB.number);
    assert.equal(after.body.record.status, before.body.record.status,
        "Tenant B's record moved state after Tenant A's cross-tenant transition attempt");
});

/* ---------- regression: the specific bug this project already fixed once.
   workflow_transitions used to be matched by the record type's *key*
   ("ncr"), which every tenant shares, instead of its per-org
   record_type_id. Both tenants here really do have a type keyed
   "ncr" with an overlapping workflow shape - exactly the condition
   that produced duplicated, cross-tenant transitions before. ---------- */

test("a record's legal moves are never duplicated by another tenant's identically-keyed workflow", async () => {
    const detail = await api(cookieA, "GET", "/api/records/" + recordA.number);
    assert.equal(detail.status, 200);

    const toStates = detail.body.transitions.map((t) => t.to);
    const unique = new Set(toStates);
    assert.equal(toStates.length, unique.size, "duplicate transitions - another tenant's rows leaked in");
});

/* ---------- the boundary: the people directory ---------- */

test("Tenant A cannot see Tenant B's people", async () => {
    const result = await api(cookieA, "GET", "/api/users");
    assert.equal(result.status, 200);
    const emails = result.body.users.map((u) => u.email);
    assert.ok(!emails.includes(tenantB.admin.email), "Tenant B's admin leaked into Tenant A's directory");
});
