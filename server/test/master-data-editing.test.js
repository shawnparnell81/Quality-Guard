/* ============================================================
   Master data can now be created and edited through the API, not
   just listed. This proves the gage endpoints end to end against a
   real running instance: add a gage, see it in the register, edit
   it (and watch the due date recompute), record a calibration with
   a certificate PDF, read the certificate back - and that a role
   without gage.create is turned away.

   Self-contained in the style of tenant-isolation.test.js: it
   provisions its own throwaway org, runs the app as a child process
   on a spare port, and deletes everything it made afterwards. Never
   touches seed data or a real org.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");

const PORT = 3097;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let operatorCookie;

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
    assert.equal(login.status, 200, "login should succeed for " + email);
    const body = await login.json();
    const cookie = extractCookie(login);
    assert.ok(cookie, "login should set a session cookie");

    if (body.must_change_password) {
        const changed = await fetch(BASE + "/api/auth/change-password", {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: temporaryPassword, new_password: "Master-Data-Test-1x" })
        });
        assert.equal(changed.status, 200, "forced password change should succeed");
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

function makePdf() {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [200, 200] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(14).text("Calibration certificate", 20, 90);
        doc.end();
    });
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
    tenant = await provisionOrganization({
        companyName: "Master Data Test " + stamp,
        adminEmail: "masterdata." + stamp + "@example.test",
        adminName: "Master Data Admin"
    });

    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    /* An operator holds no gage.create - the negative case. */
    const operator = await api(adminCookie, "POST", "/api/users", {
        full_name: "Test Operator", email: "operator." + stamp + "@example.test",
        initials: "TO" + (stamp % 100), role: "operator"
    });
    assert.equal(operator.status, 201, "should be able to create an operator");
    operatorCookie = await loginAs(operator.body.email || ("operator." + stamp + "@example.test"),
        operator.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a gage can be added and then appears in the register", async () => {
    const created = await api(adminCookie, "POST", "/api/gages", {
        gage_id: "TEST-CMM-01",
        description: "Coordinate measuring machine",
        manufacturer: "Zeiss",
        serial_number: "SN-12345",
        interval_months: 12,
        last_cal: "2026-01-15"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.gage_id, "TEST-CMM-01");
    // next_due computed from last_cal + interval when not given
    assert.equal(String(created.body.next_due).slice(0, 10), "2027-01-15");

    const list = await api(adminCookie, "GET", "/api/gages");
    assert.equal(list.status, 200);
    const row = list.body.gages.find((g) => g.gage_id === "TEST-CMM-01");
    assert.ok(row, "the new gage should be in the register");
    assert.equal(row.manufacturer, "Zeiss");
    assert.equal(row.serial_number, "SN-12345");
});

test("a duplicate gage id is rejected", async () => {
    const dup = await api(adminCookie, "POST", "/api/gages", {
        gage_id: "TEST-CMM-01", description: "again", interval_months: 6
    });
    assert.equal(dup.status, 409);
});

test("editing the interval recomputes the due date", async () => {
    const patched = await api(adminCookie, "PATCH", "/api/gages/TEST-CMM-01", {
        interval_months: 6,
        location: "Metrology lab"
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.interval_months, 6);
    assert.equal(patched.body.location, "Metrology lab");
    // last_cal is still 2026-01-15, now + 6 months
    assert.equal(String(patched.body.next_due).slice(0, 10), "2026-07-15");
});

test("a calibration is recorded with its certificate and the certificate reads back", async () => {
    const pdf = await makePdf();
    const form = new FormData();
    form.append("result", "pass");
    form.append("performed_on", "2026-06-01");
    form.append("cal_supplier", "Acme Cal Lab");
    form.append("standard_used", "Gauge block set, NIST-traceable");
    form.append("as_found", "within tolerance");
    form.append("as_left", "within tolerance");
    form.append("certificate", new Blob([pdf], { type: "application/pdf" }), "cert.pdf");

    const recorded = await fetch(BASE + "/api/gages/TEST-CMM-01/calibrations", {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: form
    });
    const recordedBody = await recorded.json();
    assert.equal(recorded.status, 201, JSON.stringify(recordedBody));
    assert.equal(recordedBody.availability, "available");
    // pass from performed_on 2026-06-01 + 6 month interval
    assert.equal(String(recordedBody.next_due).slice(0, 10), "2026-12-01");

    const history = await api(adminCookie, "GET", "/api/gages/TEST-CMM-01/calibrations");
    assert.equal(history.status, 200);
    assert.equal(history.body.calibrations.length, 1);
    const entry = history.body.calibrations[0];
    assert.equal(entry.result, "pass");
    assert.equal(entry.cal_supplier, "Acme Cal Lab");
    assert.equal(entry.has_certificate, true);

    const cert = await fetch(BASE + "/api/gages/TEST-CMM-01/calibrations/" + entry.id + "/certificate", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(cert.status, 200);
    assert.equal(cert.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await cert.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.subarray(0, 4).toString() === "%PDF", "should stream back a PDF");
});

test("a failing calibration puts the gage on hold", async () => {
    const failForm = new FormData();
    failForm.append("result", "fail");
    failForm.append("notes", "reads 0.001 high across the range");

    const recorded = await fetch(BASE + "/api/gages/TEST-CMM-01/calibrations", {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: failForm
    });
    assert.equal(recorded.status, 201);
    const body = await recorded.json();
    assert.equal(body.availability, "hold");
});

test("a role without gage.create is refused", async () => {
    const denied = await api(operatorCookie, "POST", "/api/gages", {
        gage_id: "TEST-OP-01", description: "should not be created", interval_months: 12
    });
    assert.equal(denied.status, 403);

    const list = await api(adminCookie, "GET", "/api/gages");
    assert.ok(!list.body.gages.some((g) => g.gage_id === "TEST-OP-01"),
        "the refused gage must not exist");
});

test("retiring a gage takes it out of the pickers", async () => {
    const retired = await api(adminCookie, "POST", "/api/gages/TEST-CMM-01/retire", {});
    assert.equal(retired.status, 200);
    assert.equal(retired.body.availability, "retired");

    /* The NCR form has a gage link field; a retired gage comes back
       disabled with a reason. */
    const form = await api(adminCookie, "GET", "/api/record-types/ncr/form");
    assert.equal(form.status, 200);
    const gageOptions = (form.body.options && form.body.options.gages) || [];
    const option = gageOptions.find((o) => o.value === "TEST-CMM-01");
    if (option) {
        assert.equal(option.disabled, true);
        assert.equal(option.disabled_reason, "retired");
    }
});
