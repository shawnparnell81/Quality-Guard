/* ============================================================
   Server-side write validation (audit fix C1) - ENFORCED.

   coerceCell is also a whole-payload validator: on every record POST
   and PATCH the server walks the caller's data against the published
   form version and rejects any value the schema cannot accept - a
   select that is not one of its options, a number that is not a
   number, a value outside field.min / field.max, a string that fails
   field.pattern, a bad table cell. The response is 422 with a
   schema_violations list; the mismatch is also logged.

   On PATCH the check is narrowed to the values the write introduces
   (differs from what the record already holds), so a schema that
   changed under an existing record cannot lock its owner out of
   editing the parts they never touched.
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
const PORT = 3141;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let serverOut = "";      // everything the server has written to stdout+stderr
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
            body: JSON.stringify({ current_password: pw, new_password: "Write-Val-Test-1x" })
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

/* The log line lands on the child's stdout during request handling,
   which is already over by the time fetch() resolves - so it may be
   in serverOut the instant we look, or a pipe-flush behind. Scan from
   a mark taken BEFORE the request so a previous test's line is never
   mistaken for this one. */
async function waitForLog(fromIndex, match, deadlineMs = 3000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        const fresh = serverOut.slice(fromIndex);
        if (match.test(fresh)) return fresh;
        await sleep(50);
    }
    return null;
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
    serverProcess.stdout.on("data", (c) => { serverOut += c; });
    serverProcess.stderr.on("data", (c) => { serverOut += c; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("Test server exited early:\n" + serverOut);
    });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "Write Val " + stamp,
        adminEmail: "wv.admin." + stamp + "@example.test", adminName: "WV Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Validated Form", prefix: "VF", clause: "8.5",
        fields: [
            { key: "part_no", label: "Part number", type: "text", pattern: "^P-[0-9]{4}$" },
            { key: "qty", label: "Quantity", type: "number", min: 1, max: 100 },
            { key: "grade", label: "Grade", type: "select", options: ["A", "B", "C"] },
            {
                key: "rows", label: "Rows", type: "table",
                columns: [
                    { key: "note", label: "Note", type: "text" },
                    { key: "count", label: "Count", type: "number" }
                ]
            }
        ]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

let cleanNumber;

test("a create with bad values is rejected 422, and every one is listed and logged", async () => {
    const mark = serverOut.length;
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "validated_form", title: "Bad values",
        data: {
            part_no: "nope",          // fails the pattern
            qty: 999,                 // above max
            grade: "Z",               // not an option
            rows: [{ note: "ok", count: "abc" }]   // not a number
        }
    });
    assert.equal(made.status, 422, "the write is rejected");

    const byField = Object.fromEntries(
        made.body.schema_violations.map((p) => [p.column || p.field, p]));
    assert.ok(byField.part_no, "pattern miss reported");
    assert.ok(byField.qty && /maximum/.test(byField.qty.error), "over-max reported");
    assert.ok(byField.grade && /not one of/.test(byField.grade.error), "bad select reported");
    assert.ok(byField.count, "bad table cell reported with its column key");
    assert.equal(byField.count.row, 0, "the offending row index is carried");

    const logged = await waitForLog(mark, /record_write_schema_mismatch/);
    assert.ok(logged, "the mismatch was also logged");
    const line = logged.split("\n").find((l) => l.includes("record_write_schema_mismatch"));
    assert.equal(JSON.parse(line).phase, "create");
});

test("a record with no bad values in it is never created", async () => {
    const rows = await query(
        "select count(*)::int as n from records r join record_types rt on rt.id = r.record_type_id"
        + " where r.org_id = $1 and rt.key = 'validated_form'", [tenant.orgId]);
    assert.equal(rows.rows[0].n, 0, "the rejected create left nothing behind");
});

test("a clean create is accepted and logs nothing", async () => {
    const before = serverOut.length;
    const made = await api(adminCookie, "POST", "/api/records", {
        type: "validated_form", title: "All good",
        data: { part_no: "P-1234", qty: 10, grade: "B", rows: [{ note: "fine", count: 3 }] }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    cleanNumber = made.body.number;

    await sleep(300);
    assert.ok(!serverOut.slice(before).includes("record_write_schema_mismatch"),
        "a valid payload produces no mismatch log");
});

test("a PATCH that introduces a bad value is rejected 422", async () => {
    const patched = await api(adminCookie, "PATCH", "/api/records/" + cleanNumber, {
        reason: "typo", data: { qty: 0 }   // below min - a new bad value
    });
    assert.equal(patched.status, 422, "the update is rejected");
    assert.ok(patched.body.schema_violations.some(
        (p) => p.field === "qty" && /minimum/.test(p.error)));

    /* and the record was not touched */
    const got = await api(adminCookie, "GET", "/api/records/" + cleanNumber);
    assert.equal(got.body.record.data.qty, 10);
});

test("a PATCH that only touches good fields is accepted", async () => {
    const before = serverOut.length;
    const patched = await api(adminCookie, "PATCH", "/api/records/" + cleanNumber, {
        reason: "fix it", data: { qty: 5 }
    });
    assert.equal(patched.status, 200);

    await sleep(300);
    assert.ok(!serverOut.slice(before).includes("record_write_schema_mismatch"));
});

test("a PATCH re-sending an unchanged value the schema no longer accepts still saves", async () => {
    /* The client sends the whole data object on every save. Simulate a
       record that already holds a value gone stale (its option was
       removed after it was entered) and prove that editing an
       untouched-by-this-write field is not blocked by it. */
    await query(
        "update records set data = data || '{\"grade\":\"Z\"}'::jsonb"
        + " where org_id = $1 and number = $2", [tenant.orgId, cleanNumber]);

    const patched = await api(adminCookie, "PATCH", "/api/records/" + cleanNumber, {
        reason: "bump qty, grade unchanged", data: { grade: "Z", qty: 8 }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const got = await api(adminCookie, "GET", "/api/records/" + cleanNumber);
    assert.equal(got.body.record.data.qty, 8);

    /* but the moment the write itself sets grade to something bad, it is caught */
    const bad = await api(adminCookie, "PATCH", "/api/records/" + cleanNumber, {
        reason: "now change grade", data: { grade: "still-bad" }
    });
    assert.equal(bad.status, 422);
});
