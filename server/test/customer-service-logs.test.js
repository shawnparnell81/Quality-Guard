/* ============================================================
   Customer Service logs - purchase orders, work orders, purchase
   requests.

   Registers, not workflows. Proves each log end to end: create with
   an auto number and with an explicit one, list, read, edit the
   status; an AVL vendor links, a free-text one is kept as text; the
   required fields are enforced; purchasing.log / wo.log gate the
   writes while any signed-in user can read; and one tenant's log is
   invisible to another.
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
const PORT = 3102;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let noLogCookie;  // operator: no purchasing.log, no wo.log

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
            body: JSON.stringify({ current_password: pw, new_password: "Logs-Test-Passphrase-1x" })
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
        companyName: "Logs Test A " + stamp,
        adminEmail: "logs.a." + stamp + "@example.test", adminName: "Logs Admin A"
    });
    other = await provisionOrganization({
        companyName: "Logs Test B " + stamp,
        adminEmail: "logs.b." + stamp + "@example.test", adminName: "Logs Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    await query(
        "insert into vendors (org_id, name, scope, grade) values ($1, 'Halstead Steel', 'Bar stock', 'B')",
        [tenant.orgId]
    );

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Logs Operator", email: "logs.op." + stamp + "@example.test",
        initials: "LO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noLogCookie = await loginAs(op.body.email || ("logs.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

/* ---------- purchase orders ---------- */

test("a purchase order is logged, auto-numbered, listed and editable", async () => {
    const created = await api(adminCookie, "POST", "/api/purchase-orders", {
        vendor: "Halstead Steel", order_date: "2026-09-01", need_by_date: "2026-09-20",
        total_amount: 4200.5
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.po_number, /^PO-\d{4}-\d{4}$/);
    assert.equal(created.body.status, "open");

    const number = created.body.po_number;

    /* the AVL name resolved to the vendor row */
    const got = await api(adminCookie, "GET", "/api/purchase-orders/" + number);
    assert.equal(got.status, 200);
    assert.equal(got.body.purchase_order.vendor, "Halstead Steel");
    assert.equal(got.body.purchase_order.vendor_on_avl, true);
    assert.equal(got.body.can_edit, true);

    const list = await api(adminCookie, "GET", "/api/purchase-orders");
    assert.ok(list.body.purchase_orders.some((r) => r.po_number === number));

    const patched = await api(adminCookie, "PATCH", "/api/purchase-orders/" + number, {
        status: "partially_received"
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, "partially_received");
});

test("a supplier not on the AVL is kept as free text", async () => {
    const created = await api(adminCookie, "POST", "/api/purchase-orders", {
        vendor: "Bob's One-Off Machining", po_number: "PO-SPECIAL-1"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const got = await api(adminCookie, "GET", "/api/purchase-orders/PO-SPECIAL-1");
    assert.equal(got.body.purchase_order.vendor, "Bob's One-Off Machining");
    assert.equal(got.body.purchase_order.vendor_on_avl, false);
});

test("a purchase order needs a vendor", async () => {
    const bad = await api(adminCookie, "POST", "/api/purchase-orders", { total_amount: 10 });
    assert.equal(bad.status, 422);
});

test("logging a purchase order needs purchasing.log; reading does not", async () => {
    const denied = await api(noLogCookie, "POST", "/api/purchase-orders", { vendor: "X" });
    assert.equal(denied.status, 403);

    const list = await api(noLogCookie, "GET", "/api/purchase-orders");
    assert.equal(list.status, 200);
});

/* ---------- purchase requests ---------- */

test("a purchase request is logged with the raiser and is editable", async () => {
    const created = await api(adminCookie, "POST", "/api/purchase-requests", {
        description: "Replacement carbide inserts for Cell 3", department: "Production",
        estimated_cost: 320, needed_by_date: "2026-09-15"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.pr_number, /^PR-\d{4}-\d{4}$/);
    assert.equal(created.body.status, "submitted");

    const got = await api(adminCookie, "GET", "/api/purchase-requests/" + created.body.pr_number);
    assert.equal(got.body.purchase_request.requested_by, "Logs Admin A");

    const patched = await api(adminCookie, "PATCH", "/api/purchase-requests/" + created.body.pr_number, {
        status: "approved", po_number: "PO-2026-0001"
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, "approved");
    assert.equal(patched.body.po_number, "PO-2026-0001");
});

test("a purchase request needs a description", async () => {
    const bad = await api(adminCookie, "POST", "/api/purchase-requests", { department: "Production" });
    assert.equal(bad.status, 422);
});

/* ---------- work orders ---------- */

test("a work order is logged by hand and shows in the register", async () => {
    const created = await api(adminCookie, "POST", "/api/work-orders", {
        qty: 500, cell: "Cell 5", current_op: "10", total_ops: "60"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.wo_number, /^WO-\d+$/);
    assert.equal(created.body.qty, 500);

    const list = await api(adminCookie, "GET", "/api/work-orders");
    assert.ok(list.body.work_orders.some((r) => r.wo_number === created.body.wo_number));
});

test("a work order needs a positive whole-number qty", async () => {
    const bad = await api(adminCookie, "POST", "/api/work-orders", { qty: 0 });
    assert.equal(bad.status, 422);
    const bad2 = await api(adminCookie, "POST", "/api/work-orders", { qty: 1.5 });
    assert.equal(bad2.status, 422);
});

test("logging a work order needs wo.log", async () => {
    const denied = await api(noLogCookie, "POST", "/api/work-orders", { qty: 10 });
    assert.equal(denied.status, 403);
});

/* ---------- detail view + edit (PR 1) ---------- */

test("a purchase order carries data fields through PATCH and is read back", async () => {
    const po = await api(adminCookie, "POST", "/api/purchase-orders", { vendor: "Detail Supplier" });
    const number = po.body.po_number;

    const patched = await api(adminCookie, "PATCH", "/api/purchase-orders/" + number, {
        total_amount: 990, currency: "USD",
        data: { ship_to: "Dock 4", payment_terms: "Net 30" }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.data.ship_to, "Dock 4");

    const got = await api(adminCookie, "GET", "/api/purchase-orders/" + number);
    assert.equal(got.body.purchase_order.total_amount, "990.00");
    assert.equal(got.body.purchase_order.data.payment_terms, "Net 30");
});

test("a closed purchase order cannot be edited beyond its status", async () => {
    const po = await api(adminCookie, "POST", "/api/purchase-orders", { vendor: "Closing Supplier" });
    const number = po.body.po_number;

    await api(adminCookie, "PATCH", "/api/purchase-orders/" + number, { status: "closed" });

    const edit = await api(adminCookie, "PATCH", "/api/purchase-orders/" + number, { total_amount: 1 });
    assert.equal(edit.status, 409);

    /* but reopening is allowed */
    const reopen = await api(adminCookie, "PATCH", "/api/purchase-orders/" + number, { status: "open" });
    assert.equal(reopen.status, 200);
    assert.equal(reopen.body.status, "open");
});

test("a work order is edited through PATCH, data merges, and it links to the same row", async () => {
    const wo = await api(adminCookie, "POST", "/api/work-orders", {
        qty: 250, cell: "Cell 1", data: { customer: "Acme", priority: "high" }
    });
    const number = wo.body.wo_number;
    assert.equal(wo.body.data.customer, "Acme");

    const got = await api(adminCookie, "GET", "/api/work-orders/" + number);
    assert.equal(got.body.work_order.data.customer, "Acme");
    assert.equal(got.body.can_edit, true);
    assert.ok(Array.isArray(got.body.traveller));

    const patched = await api(adminCookie, "PATCH", "/api/work-orders/" + number, {
        cell: "Cell 7", data: { customer_po: "PO-88" }
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.cell, "Cell 7");
    assert.equal(patched.body.data.customer, "Acme");      // merged, not replaced
    assert.equal(patched.body.data.customer_po, "PO-88");
});

test("editing a work order needs wo.log", async () => {
    const wo = await api(adminCookie, "POST", "/api/work-orders", { qty: 10 });
    const denied = await api(noLogCookie, "PATCH", "/api/work-orders/" + wo.body.wo_number, { cell: "x" });
    assert.equal(denied.status, 403);
});

test("a completed work order cannot be edited beyond its status", async () => {
    const wo = await api(adminCookie, "POST", "/api/work-orders", { qty: 10 });
    await api(adminCookie, "PATCH", "/api/work-orders/" + wo.body.wo_number, { status: "complete" });
    const edit = await api(adminCookie, "PATCH", "/api/work-orders/" + wo.body.wo_number, { cell: "x" });
    assert.equal(edit.status, 409);
});

/* ---------- isolation ---------- */

test("one tenant's logs are invisible to another", async () => {
    const po = await api(adminCookie, "POST", "/api/purchase-orders", { vendor: "Private Supplier" });
    assert.equal(po.status, 201);

    const get = await api(otherCookie, "GET", "/api/purchase-orders/" + po.body.po_number);
    assert.equal(get.status, 404);

    const patch = await api(otherCookie, "PATCH", "/api/purchase-orders/" + po.body.po_number, {
        status: "closed"
    });
    assert.equal(patch.status, 404);

    const list = await api(otherCookie, "GET", "/api/purchase-orders");
    assert.equal(list.body.purchase_orders.some((r) => r.po_number === po.body.po_number), false);
});
