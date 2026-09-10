/* ============================================================
   Sales & Marketing: the customer master, customer onboarding, and
   each customer's document folder.

   Proves /api/customers end to end: create a customer (default
   onboarding stages appear), list it with 0-of-N progress, upload a
   quote and link a controlled spec into a numbered folder, attach a
   document to a stage, download it back, complete stages in order
   (out-of-order is refused, the last one flips the customer to
   active), and the permission + tenant-isolation gates.

   The onboarding automation that fires on create has its own file
   (customer-automation.test.js); here we only need its folders to
   exist so a document can be filed into one.
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

const PORT = 3125;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let deniedCookie;
let customerId;

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
    const cookie = extractCookie(login);
    if (body.must_change_password) {
        await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: pw, new_password: "Customer-Test-1x" })
        });
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

function makePdf() {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [200, 200] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(12).text("Quotation Q-4471", 20, 90);
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
        companyName: "Customer Test A " + stamp,
        adminEmail: "cust.a." + stamp + "@example.test", adminName: "Customer Admin A"
    });
    other = await provisionOrganization({
        companyName: "Customer Test B " + stamp,
        adminEmail: "cust.b." + stamp + "@example.test", adminName: "Customer Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    /* A controlled document to link as a spec. */
    await query(`
        insert into documents (org_id, doc_number, title, current_revision, status)
        values ($1, 'SPEC-88', 'Customer part spec', 'C', 'released')
    `, [tenant.orgId]);

    /* A role that carries customer.read but neither customer.manage nor
       customer.onboard - so it may view a folder but not change one. */
    const noPerm = await query(`
        select r.key from roles r
         where r.org_id = $1
           and exists (
               select 1 from role_permissions rp
                where rp.org_id = r.org_id and rp.role_key = r.key
                  and rp.permission_key = 'customer.read')
           and not exists (
               select 1 from role_permissions rp
                where rp.org_id = r.org_id and rp.role_key = r.key
                  and rp.permission_key in ('customer.manage', 'customer.onboard'))
         order by r.key
         limit 1
    `, [tenant.orgId]);
    const denied = await api(adminCookie, "POST", "/api/users", {
        full_name: "No Customer Perm", email: "nocust." + stamp + "@example.test",
        initials: "NC" + (stamp % 100000), role: noPerm.rows[0].key
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    deniedCookie = await loginAs("nocust." + stamp + "@example.test", denied.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("creating a customer seeds the default onboarding stages", async () => {
    const created = await api(adminCookie, "POST", "/api/customers", {
        name: "Beacon Fabrication", code: "BFB",
        primary_contact_name: "R. Aldridge", primary_contact_email: "r@beacon.example"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    customerId = created.body.id;

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.equal(folder.status, 200);
    assert.equal(folder.body.customer.name, "Beacon Fabrication");
    assert.equal(folder.body.customer.status, "prospect");
    assert.equal(folder.body.stages.length, 6);
    assert.equal(folder.body.stages[0].stage_key, "nda_terms");
    assert.ok(folder.body.stages.every((s) => s.status === "pending"));
    /* the automation built the seven numbered folders on create */
    assert.equal(folder.body.folders.length, 7);
    assert.ok(folder.body.folders.some((f) => f.folder_key === "quality"));
});

test("the list shows the customer with 0-of-6 progress", async () => {
    const list = await api(adminCookie, "GET", "/api/customers");
    assert.equal(list.status, 200);
    const row = list.body.customers.find((c) => c.id === customerId);
    assert.ok(row, "the new customer is listed");
    assert.equal(row.stages, 6);
    assert.equal(row.complete, 0);
});

test("a name collision is refused", async () => {
    const dup = await api(adminCookie, "POST", "/api/customers", { name: "Beacon Fabrication" });
    assert.equal(dup.status, 409);
});

test("a quote uploads into a numbered folder and downloads back", async () => {
    const pdf = await makePdf();
    const form = new FormData();
    form.append("folder_key", "orders");
    form.append("note", "Q-4471, valid 60 days");
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "quote-4471.pdf");

    const added = await fetch(BASE + "/api/customers/" + customerId + "/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const addedBody = await added.json();
    assert.equal(added.status, 201, JSON.stringify(addedBody));
    assert.equal(addedBody.kind, "upload");

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const orders = folder.body.folders.find((f) => f.folder_key === "orders");
    assert.equal(orders.documents.length, 1);
    const doc = orders.documents[0];
    assert.equal(doc.original_filename, "quote-4471.pdf");
    assert.equal(doc.note, "Q-4471, valid 60 days");

    const dl = await fetch(BASE + "/api/customers/" + customerId + "/documents/" + doc.id + "/download",
        { headers: { Cookie: adminCookie } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.length > 100 && bytes.subarray(0, 4).toString() === "%PDF");
});

test("a controlled document links into a numbered folder", async () => {
    const form = new FormData();
    form.append("folder_key", "engineering");
    form.append("document", "SPEC-88");

    const added = await fetch(BASE + "/api/customers/" + customerId + "/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(added.status, 201);

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const eng = folder.body.folders.find((f) => f.folder_key === "engineering");
    assert.equal(eng.documents.length, 1);
    assert.equal(eng.documents[0].kind, "link");
    assert.equal(eng.documents[0].doc_number, "SPEC-88");
});

test("a document attaches to an onboarding stage", async () => {
    const form = new FormData();
    form.append("stage_key", "requirements");
    form.append("document", "SPEC-88");

    const added = await fetch(BASE + "/api/customers/" + customerId + "/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(added.status, 201);

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const stage = folder.body.stages.find((s) => s.stage_key === "requirements");
    assert.equal(stage.documents.length, 1);
});

test("giving both a stage and a folder is refused", async () => {
    const form = new FormData();
    form.append("stage_key", "requirements");
    form.append("folder_key", "engineering");
    form.append("document", "SPEC-88");
    const bad = await fetch(BASE + "/api/customers/" + customerId + "/documents", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    assert.equal(bad.status, 400);
});

test("stages complete only in order, and the last one activates the customer", async () => {
    const outOfOrder = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/stages/quotation/complete", {});
    assert.equal(outOfOrder.status, 409);

    const keys = ["nda_terms", "requirements", "quotation", "sample_fai", "ppap", "account_setup"];
    for (const key of keys) {
        const done = await api(adminCookie, "POST",
            "/api/customers/" + customerId + "/stages/" + key + "/complete", {});
        assert.equal(done.status, 200, key + ": " + JSON.stringify(done.body));
    }

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.equal(folder.body.customer.status, "active");
    assert.ok(folder.body.stages.every((s) => s.status === "complete"));

    /* it drops off the onboarding-only view's underlying data */
    const list = await api(adminCookie, "GET", "/api/customers");
    assert.equal(list.body.customers.find((c) => c.id === customerId).complete, 6);
});

test("customer.read may view but not create or complete", async () => {
    const view = await api(deniedCookie, "GET", "/api/customers/" + customerId);
    assert.equal(view.status, 200);

    const create = await api(deniedCookie, "POST", "/api/customers", { name: "Denied Co" });
    assert.equal(create.status, 403);

    const complete = await api(deniedCookie, "POST",
        "/api/customers/" + customerId + "/stages/nda_terms/complete", {});
    assert.equal(complete.status, 403);
});

test("another tenant cannot see or touch the customer", async () => {
    const view = await api(otherCookie, "GET", "/api/customers/" + customerId);
    assert.equal(view.status, 404);

    const list = await api(otherCookie, "GET", "/api/customers");
    assert.ok(!list.body.customers.some((c) => c.id === customerId));
});
