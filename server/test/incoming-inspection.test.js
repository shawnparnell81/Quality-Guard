/* ============================================================
   Incoming Material Inspection - the receiving form behind clause
   8.4.2.

   Proves the whole receiving path on the extended receipts row: a
   receipt is logged with its shipment-identification section already
   filled (from an AVL vendor or a free-text supplier); the rest of
   the form is saved section by section with PATCH while the receipt
   is still pending; a disposition ends it - accepted, accepted with
   notes, or rejected - and a rejection with requires_ncr raises a
   linked NCR record prefilled from the receipt and stamps its number
   back onto the receipt; requires_quarantine sets the flag the
   register filters on; photos upload and stream back without their
   storage path ever leaving the server; receiving.log is enforced;
   and one tenant's receipt is invisible to another.
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
const PORT = 3098;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;      // provisioned admin = general_manager: holds every authority
let otherCookie;
let noLogCookie;      // operator: no receiving.log, no ncr.disposition

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
            body: JSON.stringify({ current_password: pw, new_password: "Recv-Test-Passphrase-1x" })
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

function makePdf(caption) {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [180, 180] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text(caption, 20, 80);
        doc.end();
    });
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

/* Log a receipt with a free-text (not-on-AVL) supplier - the common
   case for a small shop, and the one the old vendor-only route could
   not represent. Returns the receipt number. */
async function logReceipt(cookie, overrides = {}) {
    const r = await api(cookie, "POST", "/api/receipts", {
        qty_received: 250,
        po_number: "PO-9001",
        part_number: "RP-9001-A",
        data: {
            supplier_name: "Halstead Steel (spot buy)",
            packing_slip_number: "PS-55123",
            carrier: "Old Dominion",
            received_date: "2026-09-05",
            part_description: "1018 CRS bar, 1.25 in",
            lot_number: "L-77213"
        },
        ...overrides
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.receipt_number, /^RCV-\d{8}-\d+$/);
    return r.body.receipt_number;
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
        companyName: "Recv Test A " + stamp,
        adminEmail: "recv.a." + stamp + "@example.test", adminName: "Recv Admin A"
    });
    other = await provisionOrganization({
        companyName: "Recv Test B " + stamp,
        adminEmail: "recv.b." + stamp + "@example.test", adminName: "Recv Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "Recv Operator", email: "recv.op." + stamp + "@example.test",
        initials: "RO" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    noLogCookie = await loginAs(op.body.email || ("recv.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a receipt is logged with its shipment-identification section", async () => {
    const number = await logReceipt(adminCookie);

    const got = await api(adminCookie, "GET", "/api/receipts/" + number);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.receipt.status, "pending");
    assert.equal(got.body.receipt.on_avl, false);
    assert.equal(got.body.receipt.vendor, "Halstead Steel (spot buy)");
    assert.equal(got.body.receipt.data.carrier, "Old Dominion");
    assert.equal(got.body.receipt.data.packing_slip_number, "PS-55123");
    assert.equal(got.body.receipt.qty_received, 250);
    assert.equal(got.body.can_edit, true);
    assert.deepEqual(got.body.photos, []);

    /* It shows in the register with the free-text supplier. */
    const list = await api(adminCookie, "GET", "/api/receipts");
    const row = list.body.receipts.find((x) => x.receipt_number === number);
    assert.ok(row, "receipt is in the register");
    assert.equal(row.vendor, "Halstead Steel (spot buy)");
});

test("a supplier is required", async () => {
    const r = await api(adminCookie, "POST", "/api/receipts", { qty_received: 10 });
    assert.equal(r.status, 400);
});

test("PATCH merges the inspection form section by section", async () => {
    const number = await logReceipt(adminCookie);

    const patch = await api(adminCookie, "PATCH", "/api/receipts/" + number, {
        data: {
            packaging_condition: "good",
            labelling_correct: "yes",
            visual_defects: true,
            visual_notes: "Two bars with light surface rust",
            dimension_check_required: true,
            dimensions: [
                { characteristic: "OD", nominal: "1.250", actual: "1.249", result: "pass" }
            ],
            cert_of_conformance_received: true
        }
    });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const got = await api(adminCookie, "GET", "/api/receipts/" + number);
    /* section 1 survives the merge */
    assert.equal(got.body.receipt.data.carrier, "Old Dominion");
    /* section 3-5 were added */
    assert.equal(got.body.receipt.data.packaging_condition, "good");
    assert.equal(got.body.receipt.data.visual_defects, true);
    assert.equal(got.body.receipt.data.dimensions[0].actual, "1.249");
    assert.equal(got.body.receipt.data.cert_of_conformance_received, true);

    /* the change is in the audit log */
    const log = await query(
        `select new_value from audit_log
          where org_id = $1 and entity = 'receipts' and field = 'inspection'
            and new_value like '%packaging_condition%'`,
        [tenant.orgId]
    );
    assert.ok(log.rowCount >= 1, "PATCH writes an audit_log row naming the changed keys");
});

test("PATCH needs receiving.log and rejects an unknown tenant", async () => {
    const number = await logReceipt(adminCookie);

    const denied = await api(noLogCookie, "PATCH", "/api/receipts/" + number, {
        data: { carrier: "nope" }
    });
    assert.equal(denied.status, 403);

    const crossTenant = await api(otherCookie, "PATCH", "/api/receipts/" + number, {
        data: { carrier: "nope" }
    });
    assert.equal(crossTenant.status, 404);
});

test("disposition: accepted closes the receipt with no NCR", async () => {
    const number = await logReceipt(adminCookie);

    const disp = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "accepted"
    });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    assert.equal(disp.body.status, "accept");
    assert.equal(disp.body.ncr_created, false);
    assert.equal(disp.body.quarantined, false);

    /* and it can no longer be edited */
    const patch = await api(adminCookie, "PATCH", "/api/receipts/" + number, {
        data: { carrier: "too late" }
    });
    assert.equal(patch.status, 409);

    const got = await api(adminCookie, "GET", "/api/receipts/" + number);
    assert.equal(got.body.can_edit, false);
    assert.equal(got.body.receipt.data.inspection_result, "accepted");
});

test("disposition: accepted_with_notes is still an acceptance", async () => {
    const number = await logReceipt(adminCookie);
    const disp = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "accepted_with_notes", notes: "Minor packaging damage, material fine"
    });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    assert.equal(disp.body.status, "accept");
    assert.equal(disp.body.ncr_created, false);
});

test("disposition: a rejection needs a reason", async () => {
    const number = await logReceipt(adminCookie);
    const disp = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "rejected"
    });
    assert.equal(disp.status, 422);
});

test("disposition: rejected + requires_ncr raises a linked NCR and quarantines", async () => {
    const number = await logReceipt(adminCookie);

    const disp = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "rejected",
        rejection_reason: "OD undersize on 6 of 8 sampled bars",
        requires_ncr: true,
        requires_quarantine: true
    });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    assert.equal(disp.body.status, "reject");
    assert.equal(disp.body.quarantined, true);
    assert.equal(disp.body.ncr_created, true);
    assert.match(disp.body.ncr_number, /^NCR-\d{4}-\d{4}$/);

    /* the NCR record exists, in its first state, prefilled from the receipt */
    const ncr = await api(adminCookie, "GET", "/api/records/" + disp.body.ncr_number);
    assert.equal(ncr.status, 200, JSON.stringify(ncr.body));
    assert.equal(ncr.body.record.status, "draft");
    assert.equal(ncr.body.record.severity, "crit");
    assert.equal(ncr.body.record.data.source, number);
    assert.equal(ncr.body.record.data.part_number, "RP-9001-A");
    assert.equal(ncr.body.record.data.detection_point, "receiving");
    assert.match(ncr.body.record.data.description, /undersize/);

    /* and the receipt carries the NCR number both on detail and in the register */
    const got = await api(adminCookie, "GET", "/api/receipts/" + number);
    assert.equal(got.body.receipt.ncr_number, disp.body.ncr_number);
    assert.equal(got.body.receipt.quarantined, true);

    const list = await api(adminCookie, "GET", "/api/receipts");
    const row = list.body.receipts.find((x) => x.receipt_number === number);
    assert.equal(row.ncr_number, disp.body.ncr_number);
    assert.equal(row.quarantined, true);
});

test("disposition: rejected without requires_ncr raises no NCR", async () => {
    const number = await logReceipt(adminCookie);
    const disp = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "rejected",
        rejection_reason: "Wrong material grade shipped",
        requires_ncr: false
    });
    assert.equal(disp.status, 200, JSON.stringify(disp.body));
    assert.equal(disp.body.status, "reject");
    assert.equal(disp.body.ncr_created, false);
    assert.equal(disp.body.ncr_number, null);
});

test("disposition is one-shot", async () => {
    const number = await logReceipt(adminCookie);
    const first = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "accepted"
    });
    assert.equal(first.status, 200);
    const second = await api(adminCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "rejected", rejection_reason: "changed my mind"
    });
    assert.equal(second.status, 409);
});

test("photos upload and stream back; the storage path never leaves the server", async () => {
    const number = await logReceipt(adminCookie);
    const pdf = await makePdf("packing slip");

    const form = new FormData();
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "packing-slip.pdf");
    const up = await fetch(BASE + "/api/receipts/" + number + "/photos", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const upText = await up.text();
    assert.equal(up.status, 201, upText);
    const upBody = JSON.parse(upText);
    assert.equal(upBody.photos.length, 1);
    assert.equal(upBody.photos[0].filename, "packing-slip.pdf");
    assert.equal(upBody.photos[0].index, 0);
    assert.equal(upBody.photos[0].storage_path, undefined);

    /* GET the detail: photos listed, but data.photos is not exposed */
    const got = await api(adminCookie, "GET", "/api/receipts/" + number);
    assert.equal(got.body.photos.length, 1);
    assert.equal(got.body.photos[0].filename, "packing-slip.pdf");
    assert.equal(got.body.receipt.data.photos, undefined);

    /* the file streams back */
    const file = await fetch(BASE + "/api/receipts/" + number + "/photos/0", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, pdf.length);

    /* an out-of-range index is a 404, not a 500 */
    const missing = await fetch(BASE + "/api/receipts/" + number + "/photos/9", {
        headers: { Cookie: adminCookie }
    });
    assert.equal(missing.status, 404);
});

test("logging a receipt needs receiving.log", async () => {
    const denied = await api(noLogCookie, "POST", "/api/receipts", {
        qty_received: 10, data: { supplier_name: "X" }
    });
    assert.equal(denied.status, 403);
});

test("one tenant's receipt is invisible to another", async () => {
    const number = await logReceipt(adminCookie);

    const get = await api(otherCookie, "GET", "/api/receipts/" + number);
    assert.equal(get.status, 404);

    const disp = await api(otherCookie, "POST", "/api/receipts/" + number + "/disposition", {
        result: "accepted"
    });
    assert.equal(disp.status, 404);

    const photo = await fetch(BASE + "/api/receipts/" + number + "/photos/0", {
        headers: { Cookie: otherCookie }
    });
    assert.equal(photo.status, 404);
});
