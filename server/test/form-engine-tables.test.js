/* ============================================================
   Form engine: repeating-table fields and creating a record type
   in-app.

   Proves a `table` field survives publish + validation, that a
   record can carry table rows in its data and read them back, that a
   required table wants at least one row, and that POST
   /api/record-types stands up a brand-new, usable type (with its
   Open -> Closed workflow) gated by forms.manage and isolated per
   org.
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
const PORT = 3104;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;      // general_manager: holds forms.manage
let otherCookie;
let noManageCookie;   // operator: no forms.manage

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
            body: JSON.stringify({ current_password: pw, new_password: "Forms-Test-Passphrase-1x" })
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

const TABLE_FIELD = {
    key: "line_items", label: "Line items", type: "table", section: "Lines",
    columns: [
        { key: "part", label: "Part", type: "text" },
        { key: "qty", label: "Qty", type: "number" },
        { key: "disp", label: "Disposition", type: "select", options: ["use", "scrap"] }
    ]
};

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
        companyName: "Forms Test A " + stamp,
        adminEmail: "forms.a." + stamp + "@example.test", adminName: "Forms Admin A"
    });
    other = await provisionOrganization({
        companyName: "Forms Test B " + stamp,
        adminEmail: "forms.b." + stamp + "@example.test", adminName: "Forms Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Forms Operator", email: "forms.op." + stamp + "@example.test",
        initials: "FO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noManageCookie = await loginAs(op.body.email || ("forms.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

/* ---------- table field type ---------- */

test("a table field publishes and comes back in the schema", async () => {
    const form = await api(adminCookie, "GET", "/api/record-types/ncr/form");
    const fields = [...form.body.fields, TABLE_FIELD];

    const put = await api(adminCookie, "PUT", "/api/record-types/ncr/form", { fields });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const after = await api(adminCookie, "GET", "/api/record-types/ncr/form");
    const table = after.body.fields.find((f) => f.key === "line_items");
    assert.ok(table);
    assert.equal(table.type, "table");
    assert.equal(table.columns.length, 3);
    assert.equal(table.section, "Lines");
});

test("a table field with no columns, or a bad column type, is refused", async () => {
    const base = (await api(adminCookie, "GET", "/api/record-types/ncr/form")).body.fields
        .filter((f) => f.key !== "line_items");

    const noCols = await api(adminCookie, "PUT", "/api/record-types/ncr/form", {
        fields: [...base, { key: "t1", label: "T1", type: "table", columns: [] }]
    });
    assert.equal(noCols.status, 422);

    const badCol = await api(adminCookie, "PUT", "/api/record-types/ncr/form", {
        fields: [...base, { key: "t2", label: "T2", type: "table",
            columns: [{ key: "c", label: "C", type: "file" }] }]
    });
    assert.equal(badCol.status, 422);
});

test("a record carries table rows in its data and reads them back", async () => {
    /* ncr's form now has the line_items table from the first test. */
    const created = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "NCR with a table",
        data: {
            disposition: "Rework",
            line_items: [
                { part: "RP-1", qty: 4, disp: "scrap" },
                { part: "RP-2", qty: 1, disp: "use" }
            ]
        }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const got = await api(adminCookie, "GET", "/api/records/" + created.body.number);
    assert.equal(got.body.record.data.line_items.length, 2);
    assert.equal(got.body.record.data.line_items[0].part, "RP-1");
    assert.equal(got.body.record.data.line_items[0].qty, 4);
});

test("a required table wants at least one row", async () => {
    const base = (await api(adminCookie, "GET", "/api/record-types/ncr/form")).body.fields
        .filter((f) => f.key !== "line_items");
    await api(adminCookie, "PUT", "/api/record-types/ncr/form", {
        fields: [...base, { ...TABLE_FIELD, required: true }]
    });

    const empty = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "no rows", data: { disposition: "Rework", line_items: [] }
    });
    assert.equal(empty.status, 422);
    assert.ok(empty.body.fields.includes("line_items"));
});

/* ---------- create a record type in-app ---------- */

test("POST /api/record-types stands up a usable type", async () => {
    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Control Plan", prefix: "CP", clause: "8.5.1",
        fields: [
            { key: "process", label: "Process step", type: "text", section: "Header" },
            { key: "characteristic", label: "Characteristic", type: "text", section: "Header" },
            { key: "checks", label: "Checks", type: "table",
              columns: [{ key: "method", label: "Method", type: "text" },
                        { key: "freq", label: "Frequency", type: "text" }] }
        ]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.key, "control_plan");

    const list = await api(adminCookie, "GET", "/api/record-types");
    assert.ok(list.body.record_types.some((t) => t.key === "control_plan" && t.version === 1));

    const form = await api(adminCookie, "GET", "/api/record-types/control_plan/form");
    assert.equal(form.status, 200);
    assert.equal(form.body.fields.length, 3);

    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "control_plan", title: "Op 30 control plan",
        data: { process: "Finish bore", checks: [{ method: "CMM", freq: "1/lot" }] }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    assert.match(rec.body.number, /^CP-\d{4}-\d{4}$/);
    assert.equal(rec.body.status, "open");

    const move = await api(adminCookie, "POST", "/api/records/" + rec.body.number + "/transition", {
        to: "closed", reason: "done"
    });
    assert.equal(move.status, 200, JSON.stringify(move.body));
});

test("a duplicate key or prefix is refused", async () => {
    const dupKey = await api(adminCookie, "POST", "/api/record-types", {
        name: "Control Plan", prefix: "CP2", fields: [{ key: "x", label: "X", type: "text" }]
    });
    assert.equal(dupKey.status, 409);

    const dupPrefix = await api(adminCookie, "POST", "/api/record-types", {
        name: "Something Else", prefix: "CP", fields: [{ key: "x", label: "X", type: "text" }]
    });
    assert.equal(dupPrefix.status, 409);
});

test("a bad prefix is refused", async () => {
    const bad = await api(adminCookie, "POST", "/api/record-types", {
        name: "Lowercase Prefix", prefix: "cp lower",
        fields: [{ key: "x", label: "X", type: "text" }]
    });
    assert.equal(bad.status, 422);
});

test("creating a record type needs forms.manage", async () => {
    const denied = await api(noManageCookie, "POST", "/api/record-types", {
        name: "Sneaky", prefix: "SNK", fields: [{ key: "x", label: "X", type: "text" }]
    });
    assert.equal(denied.status, 403);
});

test("one org's custom type is invisible to another", async () => {
    const list = await api(otherCookie, "GET", "/api/record-types");
    assert.equal(list.body.record_types.some((t) => t.key === "control_plan"), false);

    const form = await api(otherCookie, "GET", "/api/record-types/control_plan/form");
    assert.equal(form.status, 404);
});

/* ---------- computed table columns (RPN = S x O x D) ---------- */

const FMEA_COLUMNS = [
    { key: "mode", label: "Failure mode", type: "text" },
    { key: "severity", label: "Severity", type: "number" },
    { key: "occurrence", label: "Occurrence", type: "number" },
    { key: "detection", label: "Detection", type: "number" },
    { key: "rpn", label: "RPN", type: "computed", compute: "product",
      inputs: ["severity", "occurrence", "detection"], thresholds: { warn: 100, crit: 150 } }
];

test("a computed column publishes and round-trips", async () => {
    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Process FMEA", prefix: "PFM", clause: "8.5.1",
        fields: [{ key: "analysis", label: "Analysis", type: "table", columns: FMEA_COLUMNS }]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const form = await api(adminCookie, "GET", "/api/record-types/process_fmea/form");
    const rpn = form.body.fields[0].columns.find((c) => c.key === "rpn");
    assert.equal(rpn.type, "computed");
    assert.equal(rpn.compute, "product");
    assert.deepEqual(rpn.inputs, ["severity", "occurrence", "detection"]);
    assert.deepEqual(rpn.thresholds, { warn: 100, crit: 150 });
});

test("a broken computed column is refused", async () => {
    const withCols = (cols) => ({
        name: "Bad " + Math.random().toString(36).slice(2, 7), prefix: "BAD",
        fields: [{ key: "t", label: "T", type: "table", columns: cols }]
    });

    const badOp = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "s", label: "S", type: "number" },
        { key: "r", label: "R", type: "computed", compute: "divide", inputs: ["s"] }
    ]));
    assert.equal(badOp.status, 422);

    const noInputs = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "s", label: "S", type: "number" },
        { key: "r", label: "R", type: "computed", compute: "product", inputs: [] }
    ]));
    assert.equal(noInputs.status, 422);

    const missingRef = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "s", label: "S", type: "number" },
        { key: "r", label: "R", type: "computed", compute: "product", inputs: ["ghost"] }
    ]));
    assert.equal(missingRef.status, 422);

    const nonNumber = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "note", label: "Note", type: "text" },
        { key: "r", label: "R", type: "computed", compute: "product", inputs: ["note"] }
    ]));
    assert.equal(nonNumber.status, 422);
});

test("the server computes RPN on create, ignoring whatever the client sent", async () => {
    /* process_fmea exists from the round-trip test above. */
    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "process_fmea", title: "Bore op FMEA",
        data: { analysis: [
            { mode: "Chatter", severity: 7, occurrence: 4, detection: 3, rpn: 999 },
            { mode: "Undersize", severity: 8, occurrence: 5, detection: 5 },
            { mode: "Note only", severity: 2 }
        ] }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));

    const got = await api(adminCookie, "GET", "/api/records/" + rec.body.number);
    const rows = got.body.record.data.analysis;
    assert.equal(rows[0].rpn, 84, "7 x 4 x 3, not the 999 the client sent");
    assert.equal(rows[1].rpn, 200, "8 x 5 x 5");
    assert.equal(rows[2].rpn, undefined, "a row missing an input carries no RPN");
});

test("the server recomputes RPN on edit", async () => {
    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "process_fmea", title: "Edit me",
        data: { analysis: [{ mode: "Burr", severity: 3, occurrence: 3, detection: 2 }] }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const before = await api(adminCookie, "GET", "/api/records/" + rec.body.number);
    assert.equal(before.body.record.data.analysis[0].rpn, 18);

    const patched = await api(adminCookie, "PATCH", "/api/records/" + rec.body.number, {
        data: { analysis: [{ mode: "Burr", severity: 9, occurrence: 3, detection: 2, rpn: 1 }] },
        reason: "severity reassessed"
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    const after = await api(adminCookie, "GET", "/api/records/" + rec.body.number);
    assert.equal(after.body.record.data.analysis[0].rpn, 54, "9 x 3 x 2");
});

/* ---------- expression-based computed columns (audit P1 / M1) ---------- */

const DEV_COLUMNS = [
    { key: "nominal", label: "Nominal", type: "number" },
    { key: "actual", label: "Actual", type: "number" },
    { key: "tol", label: "Tol", type: "number" },
    { key: "deviation", label: "Deviation", type: "computed", expr: "actual - nominal" },
    { key: "margin", label: "Margin", type: "computed",
      expr: "tol - abs(actual - nominal)", thresholds: { warn: 0.5, crit: 0 } }
];

test("an expr computed column publishes and round-trips", async () => {
    const made = await api(adminCookie, "POST", "/api/record-types", {
        name: "Deviation Study", prefix: "DEV", clause: "8.5.1",
        fields: [{ key: "checks", label: "Checks", type: "table", columns: DEV_COLUMNS }]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const form = await api(adminCookie, "GET", "/api/record-types/deviation_study/form");
    const margin = form.body.fields[0].columns.find((c) => c.key === "margin");
    assert.equal(margin.type, "computed");
    assert.equal(margin.expr, "tol - abs(actual - nominal)");
    assert.deepEqual(margin.thresholds, { warn: 0.5, crit: 0 });
});

test("the server evaluates expr columns on create and ignores the client's value", async () => {
    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "deviation_study", title: "Op 30 bore",
        data: { checks: [
            { nominal: 12.50, actual: 12.71, tol: 0.30, deviation: 999, margin: -999 },
            { nominal: 8.00, actual: 8.00, tol: 0.10 },
            { nominal: 5.00, tol: 0.10 }                       // no actual -> not computable
        ] }
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));

    const rows = (await api(adminCookie, "GET", "/api/records/" + rec.body.number)).body.record.data.checks;
    assert.ok(Math.abs(rows[0].deviation - 0.21) < 1e-9, "12.71 - 12.50");
    assert.ok(Math.abs(rows[0].margin - 0.09) < 1e-9, "0.30 - |0.21|");
    assert.equal(rows[1].deviation, 0);
    assert.equal(rows[1].margin, 0.10);
    assert.equal(rows[2].deviation, undefined, "a missing input leaves the cell blank");
    assert.equal(rows[2].margin, undefined);
});

test("the server re-evaluates expr columns on edit", async () => {
    const rec = await api(adminCookie, "POST", "/api/records", {
        type: "deviation_study", title: "edit me",
        data: { checks: [{ nominal: 10, actual: 10.4, tol: 0.5 }] }
    });
    const before = (await api(adminCookie, "GET", "/api/records/" + rec.body.number)).body.record.data.checks;
    assert.ok(Math.abs(before[0].deviation - 0.4) < 1e-9);

    await api(adminCookie, "PATCH", "/api/records/" + rec.body.number, {
        reason: "remeasured", data: { checks: [{ nominal: 10, actual: 9.2, tol: 0.5, deviation: 0 }] }
    });
    const after = (await api(adminCookie, "GET", "/api/records/" + rec.body.number)).body.record.data.checks;
    assert.ok(Math.abs(after[0].deviation - -0.8) < 1e-9, "9.2 - 10");
    assert.ok(Math.abs(after[0].margin - -0.3) < 1e-9, "0.5 - |−0.8|");
});

test("a broken expr computed column is refused at publish", async () => {
    const withCols = (cols) => ({
        name: "BadExpr " + Math.random().toString(36).slice(2, 7), prefix: "BEX",
        fields: [{ key: "t", label: "T", type: "table", columns: cols }]
    });

    const syntax = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "a", label: "A", type: "number" },
        { key: "r", label: "R", type: "computed", expr: "a * " }
    ]));
    assert.equal(syntax.status, 422);

    const missingRef = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "a", label: "A", type: "number" },
        { key: "r", label: "R", type: "computed", expr: "a * ghost" }
    ]));
    assert.equal(missingRef.status, 422);

    const selfRef = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "a", label: "A", type: "number" },
        { key: "r", label: "R", type: "computed", expr: "r + a" }
    ]));
    assert.equal(selfRef.status, 422);

    const nonNumberRef = await api(adminCookie, "POST", "/api/record-types", withCols([
        { key: "note", label: "Note", type: "text" },
        { key: "r", label: "R", type: "computed", expr: "note * 2" }
    ]));
    assert.equal(nonNumberRef.status, 422);
});
