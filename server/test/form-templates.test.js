/* ============================================================
   Starter form templates (P4.5).

   The bundled AIAG forms list with metadata, one fetches in full,
   installing one creates a custom record type with its fields (and
   the list then flags it installed), a second install is a 409, an
   unknown key is a 404, and it all needs forms.manage.
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
const PORT = 3120;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let operatorCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Tpl-Test-Passphrase-1x" })
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
        companyName: "Templates Test " + stamp,
        adminEmail: "tpl.admin." + stamp + "@example.test", adminName: "Tpl Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Tpl Operator", email: "tpl.op." + stamp + "@example.test",
        initials: "TO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("tpl.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the template list carries metadata and an installed map", async () => {
    const r = await api(adminCookie, "GET", "/api/form-templates");
    assert.equal(r.status, 200);
    assert.ok(r.body.templates.length >= 12,
        "the library has the full core-tool set: " + r.body.templates.map((t) => t.key).join(", "));

    /* the AIAG / AS9102 core tools, plus the customer-format forms */
    for (const key of ["pfmea", "dfmea", "control_plan", "process_flow",
        "fair_report", "eight_d_report", "msa_grr", "ppap_checklist",
        "calibration_log", "work_order_form", "production_log_form", "automotive_ncr"]) {
        assert.ok(r.body.templates.some((t) => t.key === key), "library has " + key);
    }

    /* the forms derived from the customer's own spreadsheets bundle
       that file + a cell map, flagged for the catalogue UI */
    for (const key of ["work_order_form", "calibration_log", "control_plan",
        "production_log_form", "eight_d_report"]) {
        assert.equal(r.body.templates.find((t) => t.key === key).has_excel_template, true,
            key + " ships its Excel layout");
    }

    const ncr = r.body.templates.find((t) => t.key === "automotive_ncr");
    assert.equal(ncr.prefix, "ANCR");
    assert.equal(ncr.standard, "IATF 16949");
    assert.ok(ncr.table_count >= 5, "the automotive NCR carries its ICA / RCA / CAP tables");

    const pfmea = r.body.templates.find((t) => t.key === "pfmea");
    assert.ok(pfmea);
    assert.equal(pfmea.prefix, "PFMEA");
    assert.equal(typeof pfmea.clause, "string");
    assert.equal(typeof pfmea.field_count, "number");
    assert.equal(typeof pfmea.description, "string");
    assert.equal(pfmea.category, "APQP");
    assert.equal(pfmea.standard, "AIAG");
    assert.ok(pfmea.table_count >= 1);

    assert.deepEqual(r.body.installed, {}, "nothing installed in a fresh org");
});

test("a template fetches in full", async () => {
    const r = await api(adminCookie, "GET", "/api/form-templates/pfmea");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.fields) && r.body.fields.length > 0);
    const table = r.body.fields.find((f) => f.type === "table");
    assert.ok(table, "PFMEA has a table field");
    assert.ok(table.columns.some((c) => c.type === "computed"), "with an RPN computed column");

    const missing = await api(adminCookie, "GET", "/api/form-templates/nope");
    assert.equal(missing.status, 404);
});

test("installing one creates a record type with its fields", async () => {
    const install = await api(adminCookie, "POST", "/api/form-templates/pfmea/install");
    assert.equal(install.status, 201, JSON.stringify(install.body));
    assert.equal(install.body.installed_key, "pfmea");
    assert.equal(install.body.prefix, "PFMEA");

    const form = await api(adminCookie, "GET", "/api/record-types/pfmea/form");
    assert.equal(form.status, 200);
    assert.ok(form.body.fields.some((f) => f.key === "analysis" && f.type === "table"));

    const list = await api(adminCookie, "GET", "/api/form-templates");
    assert.equal(list.body.installed.pfmea, true);

    const again = await api(adminCookie, "POST", "/api/form-templates/pfmea/install");
    assert.equal(again.status, 409, "already installed");

    const bogus = await api(adminCookie, "POST", "/api/form-templates/nope/install");
    assert.equal(bogus.status, 404);
});

test("anyone can browse the catalogue, only forms.manage can install", async () => {
    const list = await api(operatorCookie, "GET", "/api/form-templates");
    assert.equal(list.status, 200, "an operator can see what forms exist");
    assert.ok(list.body.templates.length >= 8);

    const one = await api(operatorCookie, "GET", "/api/form-templates/pfmea");
    assert.equal(one.status, 200);

    const install = await api(operatorCookie, "POST", "/api/form-templates/msa_grr/install");
    assert.equal(install.status, 403, "but installing needs the permission");
});

test("every template in the library is well-formed and installs", async () => {
    const { body } = await api(adminCookie, "GET", "/api/form-templates");
    for (const meta of body.templates) {
        const full = await api(adminCookie, "GET", "/api/form-templates/" + meta.key);
        assert.equal(full.status, 200, meta.key);
        assert.ok(Array.isArray(full.body.fields) && full.body.fields.length > 0, meta.key + " has fields");

        /* pfmea was installed by an earlier test - a second install is
           a 409, which is still proof the template is usable. */
        const install = await api(adminCookie, "POST", "/api/form-templates/" + meta.key + "/install");
        assert.ok([201, 409].includes(install.status),
            meta.key + " installs (or is already installed): " + JSON.stringify(install.body));

        const form = await api(adminCookie, "GET", "/api/record-types/" + meta.key + "/form");
        assert.equal(form.status, 200, meta.key + " is now a record type");
        assert.equal(form.body.fields.length, meta.field_count, meta.key + " field count round-trips");
    }
});
