/* ============================================================
   PDF export parity (P5.2).

   Every record type - built-in and custom - exports a branded PDF
   through GET /api/records/:number/pdf. This checks the bytes are a
   real PDF, that it works across a spread of built-in types, and
   that a table-heavy custom type (a PFMEA installed from the starter
   library) actually renders its table rows rather than dropping them
   or throwing.
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
const PORT = 3121;
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
            body: JSON.stringify({ current_password: pw, new_password: "Pdf-Test-Passphrase-1x" })
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

async function pdf(cookie, number) {
    const r = await fetch(BASE + "/api/records/" + number + "/pdf", { headers: { Cookie: cookie } });
    const bytes = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get("content-type"),
        disposition: r.headers.get("content-disposition"), bytes };
}

function assertIsPdf(res, label) {
    assert.equal(res.status, 200, label + ": " + res.status);
    assert.match(res.type || "", /application\/pdf/, label + " content-type");
    assert.equal(res.bytes.subarray(0, 5).toString("latin1"), "%PDF-", label + " magic");
    assert.ok(res.bytes.subarray(-1024).toString("latin1").includes("%%EOF"), label + " has EOF");
    assert.ok(res.bytes.length > 900, label + " is a non-trivial file (" + res.bytes.length + " bytes)");
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
        companyName: "PDF Test " + stamp,
        adminEmail: "pdf.admin." + stamp + "@example.test", adminName: "Pdf Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a spread of built-in types each export a valid branded PDF", async () => {
    const specs = [
        { type: "ncr", title: "Porosity on lot 88",
          data: { part_number: "RP-1", lot_number: "88", qty_affected: 3,
              detection_point: "Internal audit", disposition: "Rework",
              description: "Porosity exceeds Class 2 on 3 of 20 castings." } },
        { type: "capa", title: "Repeated deburr misses",
          data: { problem_statement: "Burrs found at final on 4 lots in a month.",
              why_1: "Deburr step skipped", why_2: "No visual check", why_3: "WI unclear" } },
        { type: "complaint", title: "Wrong parts shipped",
          data: { customer: "Acme Aero", description: "Received RP-2 instead of RP-2A." } },
        { type: "risk", title: "Single-source heat treat",
          data: { process: "Heat treat", severity: 7, occurrence: 4, detection: 6 } },
        { type: "scar", title: "Coating thickness variation",
          data: { supplier: "Halberd Motion", part_number: "RP-6612-E",
              defect_description: "Coating 8-31 microns against 20-25 spec." } }
    ];

    for (const spec of specs) {
        const made = await api(adminCookie, "POST", "/api/records", spec);
        assert.equal(made.status, 201, spec.type + ": " + JSON.stringify(made.body));
        assertIsPdf(await pdf(adminCookie, made.body.number), spec.type);
    }
});

test("a table-heavy custom type renders its rows into the PDF", async () => {
    const install = await api(adminCookie, "POST", "/api/form-templates/pfmea/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));

    const base = {
        type: "pfmea", title: "Machining line PFMEA",
        data: { process_name: "OP20 bore", process_responsibility: "Mfg Eng" }
    };

    const empty = await api(adminCookie, "POST", "/api/records", base);
    assert.equal(empty.status, 201, JSON.stringify(empty.body));
    const emptyPdf = await pdf(adminCookie, empty.body.number);
    assertIsPdf(emptyPdf, "pfmea (no rows)");

    const withRows = await api(adminCookie, "POST", "/api/records", {
        ...base,
        data: {
            ...base.data,
            analysis: [
                { process_step: "Load part", failure_mode: "Part not seated",
                  effects: "Bore off location", severity: 8, causes: "Chip on locator",
                  occurrence: 4, controls_detection: "Operator visual", detection: 6,
                  recommended_action: "Add air blow-off + poka-yoke", responsibility: "ME / wk 40" },
                { process_step: "Bore OP20", failure_mode: "Oversize bore",
                  effects: "Scrap", severity: 7, causes: "Tool wear", occurrence: 5,
                  controls_detection: "SPC every 5th", detection: 3,
                  recommended_action: "Tool-life monitor", responsibility: "ME / wk 42" }
            ]
        }
    });
    assert.equal(withRows.status, 201, JSON.stringify(withRows.body));
    const rowsPdf = await pdf(adminCookie, withRows.body.number);
    assertIsPdf(rowsPdf, "pfmea (2 rows)");

    assert.ok(rowsPdf.bytes.length > emptyPdf.bytes.length + 300,
        "the table rows add real content: " + emptyPdf.bytes.length + " -> " + rowsPdf.bytes.length);
});

test("an unknown record number is a 404", async () => {
    const r = await pdf(adminCookie, "NCR-1999-0001");
    assert.equal(r.status, 404);
});
