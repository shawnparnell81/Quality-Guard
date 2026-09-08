/* ============================================================
   SCAR - Supplier Corrective Action Request.

   SCAR has always been a real record type (workflow, permission,
   seeded records) with only a three-field form. This checks the
   expanded 8D-style form provisions, that "triggered_by" wires a new
   SCAR to the NCR or receiving record that raised it via record_links,
   and that a SCAR walks its full workflow to closed.

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
const PORT = 3108;
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
            body: JSON.stringify({ current_password: pw, new_password: "Scar-Test-Passphrase-1x" })
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
        companyName: "SCAR Test A " + stamp,
        adminEmail: "scar.a." + stamp + "@example.test", adminName: "Scar Admin A"
    });
    other = await provisionOrganization({
        companyName: "SCAR Test B " + stamp,
        adminEmail: "scar.b." + stamp + "@example.test", adminName: "Scar Admin B"
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

test("the SCAR form provisions as a supplier 8D", async () => {
    const form = await api(adminCookie, "GET", "/api/record-types/scar/form");
    assert.equal(form.status, 200, JSON.stringify(form.body));

    const fields = form.body.fields;
    const byKey = (k) => fields.find((f) => f.key === k);

    assert.equal(byKey("supplier").required, true);
    assert.equal(byKey("part_number").required, true);
    assert.equal(byKey("defect_description").required, true);
    assert.equal(byKey("defect_description").type, "memo");

    const sections = [...new Set(fields.map((f) => f.section))];
    for (const s of ["Supplier & part", "Problem (D2)", "Root cause (D4)",
        "Corrective action (D5-D6)", "Prevent recurrence (D7)", "Verification & closure"]) {
        assert.ok(sections.includes(s), "form has the \"" + s + "\" section");
    }
});

test("triggered_by wires a SCAR to the record that raised it", async () => {
    const ncr = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Casting porosity, lot rejected at receiving",
        data: { disposition: "Return to supplier" }
    });
    assert.equal(ncr.status, 201, JSON.stringify(ncr.body));

    const scar = await api(adminCookie, "POST", "/api/records", {
        type: "scar", title: "Porosity above Class 2 limit", severity: "crit",
        data: {
            supplier: "Nordvik Heat Treat", part_number: "RP-4471-A",
            defect_description: "Porosity found on 4 of 20 castings, exceeds ASTM E155 Class 2.",
            triggered_by: ncr.body.number
        }
    });
    assert.equal(scar.status, 201, JSON.stringify(scar.body));
    assert.match(scar.body.number, /^SCAR-\d{4}-\d{4}$/);

    const detail = await api(adminCookie, "GET", "/api/records/" + scar.body.number);
    const link = detail.body.links.find((l) => l.number === ncr.body.number);
    assert.ok(link, "the SCAR links to its NCR");
    assert.equal(link.link_type, "caused_by");
    assert.equal(link.direction, "outgoing");

    /* And the NCR shows the SCAR coming back the other way. */
    const ncrDetail = await api(adminCookie, "GET", "/api/records/" + ncr.body.number);
    assert.ok(ncrDetail.body.links.some((l) => l.number === scar.body.number && l.direction === "incoming"));
});

test("an unresolvable triggered_by is kept as text, not an error", async () => {
    const scar = await api(adminCookie, "POST", "/api/records", {
        type: "scar", title: "Coating thickness variation",
        data: {
            supplier: "Halberd Motion", part_number: "RP-6612-E",
            defect_description: "Coating 8-31 microns against 20-25 spec.",
            triggered_by: "RCV-20260101-9"
        }
    });
    assert.equal(scar.status, 201, JSON.stringify(scar.body));

    const detail = await api(adminCookie, "GET", "/api/records/" + scar.body.number);
    assert.equal(detail.body.record.data.triggered_by, "RCV-20260101-9");
    assert.equal(detail.body.links.length, 0);
});

test("a SCAR walks its workflow to closed", async () => {
    const scar = await api(adminCookie, "POST", "/api/records", {
        type: "scar", title: "Thread gauge fails go/no-go",
        data: { supplier: "Dunmore Industrial", part_number: "RP-8890-D",
            defect_description: "No-go enters 3 of 10 parts." }
    });
    assert.equal(scar.status, 201, JSON.stringify(scar.body));
    const number = scar.body.number;

    for (const to of ["awaiting_8d", "response_received", "closed"]) {
        const moved = await api(adminCookie, "POST", "/api/records/" + number + "/transition",
            { to, reason: "advancing" });
        assert.equal(moved.status, 200, to + ": " + JSON.stringify(moved.body));
    }

    const detail = await api(adminCookie, "GET", "/api/records/" + number);
    assert.equal(detail.body.record.status, "closed");
    assert.equal(detail.body.transitions.length, 0, "a closed SCAR has nowhere left to go");
});

test("one org's SCARs are invisible to another", async () => {
    const mine = await api(adminCookie, "POST", "/api/records", {
        type: "scar", title: "Private", data: { supplier: "X", part_number: "Y",
            defect_description: "z" }
    });
    const seen = await api(otherCookie, "GET", "/api/records/" + mine.body.number);
    assert.equal(seen.status, 404);
});
