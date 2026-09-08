/* ============================================================
   First Article Inspection Report (FAIR).

   Checks the fair record type provisions with its 8.5.1 form, that
   POST/PATCH /api/records compute Pass/Fail and the conforming counts
   per characteristic from nominal + tolerance vs actual, that a FAIR
   walks its workflow (approved and rejected branches), and that it
   exports a PDF.

   Self-contained: provisions a throwaway org, runs the app on a spare
   port, cleans up after itself.
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
const PORT = 3109;
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
            body: JSON.stringify({ current_password: pw, new_password: "Fair-Test-Passphrase-1x" })
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

/* Three characteristics: one in tolerance, one out, one attribute
   (no nominal, so the inspector's own call). */
const CHARS = [
    { balloon: "1", feature: "Bore dia", char_class: "Key",
      nominal: 25.4, tol_minus: -0.05, tol_plus: 0.05, method: "CMM", actual: 25.42 },
    { balloon: "2", feature: "Overall length", char_class: "Standard",
      nominal: 120, tol_minus: -0.2, tol_plus: 0.2, method: "Caliper", actual: 120.35 },
    { balloon: "3", feature: "Surface finish", char_class: "Standard",
      method: "Visual", notes: "No burrs", result: "Pass" }
];

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
        companyName: "FAIR Test A " + stamp,
        adminEmail: "fair.a." + stamp + "@example.test", adminName: "Fair Admin A"
    });
    other = await provisionOrganization({
        companyName: "FAIR Test B " + stamp,
        adminEmail: "fair.b." + stamp + "@example.test", adminName: "Fair Admin B"
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

function newFair(cookie, extra = {}) {
    return api(cookie, "POST", "/api/records", {
        type: "fair", title: "FAI - RP-4471-A rev D",
        data: {
            part_number: "RP-4471-A", part_name: "Housing", revision: "D",
            drawing: "RP-4471-A", customer: "Voss Automotive",
            disposition: "Accepted", characteristics: CHARS, ...extra
        }
    });
}

test("the fair record type provisions with its 8.5.1 form", async () => {
    const form = await api(adminCookie, "GET", "/api/record-types/fair/form");
    assert.equal(form.status, 200, JSON.stringify(form.body));

    const fields = form.body.fields;
    assert.equal(fields.find((f) => f.key === "part_number").required, true);
    assert.equal(fields.find((f) => f.key === "revision").required, true);
    assert.equal(fields.find((f) => f.key === "disposition").required, true);

    const table = fields.find((f) => f.key === "characteristics");
    assert.equal(table.type, "table");
    const colKeys = table.columns.map((c) => c.key);
    for (const k of ["balloon", "feature", "nominal", "tol_minus", "tol_plus", "actual", "result"]) {
        assert.ok(colKeys.includes(k), "characteristics table has a \"" + k + "\" column");
    }
});

test("Pass/Fail and the conforming counts are computed, not typed", async () => {
    const created = await newFair(adminCookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.number, /^FAIR-\d{4}-\d{4}$/);

    const got = await api(adminCookie, "GET", "/api/records/" + created.body.number);
    const d = got.body.record.data;

    assert.equal(d.characteristics[0].result, "Pass", "25.42 is inside 25.35-25.45");
    assert.equal(d.characteristics[1].result, "Fail", "120.35 is outside 119.8-120.2");
    assert.equal(d.characteristics[2].result, "Pass", "an attribute check keeps the inspector's call");

    assert.equal(d.checked_count, 2, "two characteristics had a nominal to check against");
    assert.equal(d.conforming_count, 1);
    assert.equal(d.nonconforming_count, 1);
});

test("editing an actual recomputes its result", async () => {
    const created = await newFair(adminCookie);
    const number = created.body.number;

    const fixed = CHARS.map((c, i) => i === 1 ? { ...c, actual: 120.1 } : c);
    const patched = await api(adminCookie, "PATCH", "/api/records/" + number, {
        data: { characteristics: fixed }, reason: "re-measured on the CMM"
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const got = await api(adminCookie, "GET", "/api/records/" + number);
    assert.equal(got.body.record.data.characteristics[1].result, "Pass");
    assert.equal(got.body.record.data.conforming_count, 2);
    assert.equal(got.body.record.data.nonconforming_count, 0);
});

test("a FAIR walks its workflow - approved and rejected branches", async () => {
    const a = await newFair(adminCookie);
    for (const to of ["in_progress", "complete", "approved"]) {
        const moved = await api(adminCookie, "POST", "/api/records/" + a.body.number + "/transition",
            { to, reason: "advancing" });
        assert.equal(moved.status, 200, to + ": " + JSON.stringify(moved.body));
    }
    const gotA = await api(adminCookie, "GET", "/api/records/" + a.body.number);
    assert.equal(gotA.body.record.status, "approved");
    assert.equal(gotA.body.transitions.length, 0);

    const b = await newFair(adminCookie);
    await api(adminCookie, "POST", "/api/records/" + b.body.number + "/transition", { to: "in_progress" });
    await api(adminCookie, "POST", "/api/records/" + b.body.number + "/transition", { to: "complete" });
    const rej = await api(adminCookie, "POST", "/api/records/" + b.body.number + "/transition",
        { to: "rejected", reason: "customer rejected the deviation" });
    assert.equal(rej.status, 200, JSON.stringify(rej.body));
    const gotB = await api(adminCookie, "GET", "/api/records/" + b.body.number);
    assert.equal(gotB.body.record.status, "rejected");
});

test("a FAIR exports a PDF", async () => {
    const created = await newFair(adminCookie);
    const r = await fetch(BASE + "/api/records/" + created.body.number + "/pdf",
        { headers: { Cookie: adminCookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.length > 500, "the PDF has content");
    assert.equal(buf.subarray(0, 4).toString(), "%PDF");
});

test("one org's FAIRs are invisible to another", async () => {
    const mine = await newFair(adminCookie);
    const seen = await api(otherCookie, "GET", "/api/records/" + mine.body.number);
    assert.equal(seen.status, 404);
});
