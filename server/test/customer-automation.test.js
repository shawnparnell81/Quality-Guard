/* ============================================================
   Customer onboarding automation.

   Proves the engine end to end: creating a customer fires the full
   run (five steps done, seven folders on disk, four branded starter
   PDFs, a metadata row with both default profiles); re-running is
   idempotent; ?force rewrites the profiles without duplicating docs;
   the single-step endpoints work standalone; and the permission +
   tenant gates hold.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";
import { STORAGE_ROOT } from "../src/file-storage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");

const PORT = 3126;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let readerCookie;
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
            body: JSON.stringify({ current_password: pw, new_password: "Automation-Test-1x" })
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

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
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
        companyName: "Automation Test A " + stamp,
        adminEmail: "auto.a." + stamp + "@example.test", adminName: "Automation Admin A"
    });
    other = await provisionOrganization({
        companyName: "Automation Test B " + stamp,
        adminEmail: "auto.b." + stamp + "@example.test", adminName: "Automation Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    /* customer.read but neither customer.manage nor customer.onboard. */
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
        full_name: "Automation Reader", email: "autoread." + stamp + "@example.test",
        initials: "AR" + (stamp % 100000), role: noPerm.rows[0].key
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    readerCookie = await loginAs("autoread." + stamp + "@example.test", denied.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("creating a customer runs the full automation", async () => {
    const created = await api(adminCookie, "POST", "/api/customers", {
        name: "Halyard Aerospace", code: "HAL",
        primary_contact_name: "P. Otieno", primary_contact_email: "p@halyard.example",
        address: "17 Kiln Road, Coventry"
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    customerId = created.body.id;

    assert.ok(created.body.automation, "the 201 body carries an automation summary");
    const steps = created.body.automation.steps;
    assert.equal(steps.length, 5);
    assert.deepEqual(
        steps.map((s) => s.step),
        ["folders", "metadata", "quality", "engineering", "starter_docs"]
    );
    assert.ok(steps.every((s) => s.status === "done"),
        "every step done: " + JSON.stringify(steps));
});

test("the folder page shows seven ready folders and the starter docs", async () => {
    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.equal(folder.status, 200);

    assert.equal(folder.body.folders.length, 7);
    assert.ok(folder.body.folders.every((f) => f.status === "created"));
    assert.deepEqual(
        folder.body.folders.map((f) => f.folder_key),
        ["admin", "quality", "engineering", "production", "supply_chain", "orders", "projects"]
    );

    const admin = folder.body.folders.find((f) => f.folder_key === "admin");
    const quality = folder.body.folders.find((f) => f.folder_key === "quality");
    assert.equal(admin.documents.length, 3, "NDA + Terms + Setup Sheet in 01_Admin");
    assert.equal(quality.documents.length, 1, "Quality Profile in 02_Quality");
    assert.ok(admin.documents.every((d) => d.kind === "upload"
        && d.original_filename.endsWith(".pdf")));

    assert.ok(folder.body.metadata, "a metadata row exists");
    assert.ok(Object.keys(folder.body.metadata.quality_requirements).length > 0);
    assert.ok(Object.keys(folder.body.metadata.engineering_requirements).length > 0);
    assert.equal(folder.body.metadata.contacts[0].email, "p@halyard.example");

    assert.equal(folder.body.automation.steps.filter((s) => s.status === "done").length, 5);
});

test("a starter PDF downloads as a real branded PDF", async () => {
    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const admin = folder.body.folders.find((f) => f.folder_key === "admin");
    const nda = admin.documents.find((d) => d.original_filename === "NDA.pdf");
    assert.ok(nda, "NDA.pdf is present");

    const dl = await fetch(
        BASE + "/api/customers/" + customerId + "/documents/" + nda.id + "/download",
        { headers: { Cookie: adminCookie } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.length > 500 && bytes.subarray(0, 4).toString() === "%PDF");
});

test("the automation log records every step with run_source=auto", async () => {
    const logs = await api(adminCookie, "GET", "/api/customers/" + customerId + "/automation-logs");
    assert.equal(logs.status, 200);
    const auto = logs.body.logs.filter((l) => l.run_source === "auto");
    assert.equal(auto.length, 5);
    assert.ok(auto.every((l) => l.status === "done"));
});

test("the folders exist on disk", async () => {
    for (const name of ["01_Admin", "02_Quality", "07_Projects"]) {
        assert.ok(
            await exists(join(STORAGE_ROOT, "customer-folders", customerId, name)),
            name + " should be a real directory"
        );
    }
});

test("re-running is idempotent - no duplicate folders or docs", async () => {
    const rerun = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/run-full-automation", {});
    assert.equal(rerun.status, 200);
    /* folders and starter_docs find their work done */
    const byStep = Object.fromEntries(rerun.body.steps.map((s) => [s.step, s.status]));
    assert.equal(byStep.folders, "done");        // upsert, still reports done
    assert.equal(byStep.starter_docs, "done");   // all four already present, 0 made
    assert.ok(["skipped", "done"].includes(byStep.quality));

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.equal(folder.body.folders.length, 7);
    const total = folder.body.folders.reduce((n, f) => n + f.documents.length, 0);
    assert.equal(total, 4, "still exactly the four starter docs");
});

test("?force rewrites the profiles but does not duplicate docs", async () => {
    /* edit a profile, then force a re-run and confirm it is reset */
    await query(
        "update customer_metadata set quality_requirements = '{\"edited\":true}'::jsonb where customer_id = $1",
        [customerId]);

    const forced = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/run-full-automation", { force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.steps.find((s) => s.step === "quality").status, "done");

    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.ok(!folder.body.metadata.quality_requirements.edited, "profile was reset");
    assert.ok(Object.keys(folder.body.metadata.quality_requirements).length > 1);
    const total = folder.body.folders.reduce((n, f) => n + f.documents.length, 0);
    assert.equal(total, 4);
});

test("sync-metadata runs standalone and bumps synced_at", async () => {
    const before = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const t0 = before.body.metadata.synced_at;

    await sleep(15);
    const sync = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/sync-metadata", {});
    assert.equal(sync.status, 200);
    assert.deepEqual(sync.body.steps.map((s) => s.step), ["metadata", "quality", "engineering"]);

    const after = await api(adminCookie, "GET", "/api/customers/" + customerId);
    assert.notEqual(after.body.metadata.synced_at, t0);
});

test("create-folders and generate-starter-docs run standalone", async () => {
    const cf = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/create-folders", {});
    assert.equal(cf.status, 200);
    assert.equal(cf.body.steps[0].step, "folders");
    assert.equal(cf.body.steps[0].status, "done");

    /* delete one starter doc, regenerate, confirm it comes back once */
    const folder = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const quality = folder.body.folders.find((f) => f.folder_key === "quality");
    await api(adminCookie, "DELETE",
        "/api/customers/" + customerId + "/documents/" + quality.documents[0].id);

    const gen = await api(adminCookie, "POST",
        "/api/customers/" + customerId + "/generate-starter-docs", {});
    assert.equal(gen.status, 200);
    assert.equal(gen.body.steps[0].status, "done");

    const after = await api(adminCookie, "GET", "/api/customers/" + customerId);
    const total = after.body.folders.reduce((n, f) => n + f.documents.length, 0);
    assert.equal(total, 4, "the deleted Quality Profile was regenerated, once");
});

test("customer.read may read the logs but not run automation", async () => {
    const logs = await api(readerCookie, "GET",
        "/api/customers/" + customerId + "/automation-logs");
    assert.equal(logs.status, 200);

    for (const path of ["run-full-automation", "create-folders", "sync-metadata", "generate-starter-docs"]) {
        const denied = await api(readerCookie, "POST",
            "/api/customers/" + customerId + "/" + path, {});
        assert.equal(denied.status, 403, path + " should be forbidden");
    }
});

test("another tenant gets 404 on every automation route", async () => {
    const paths = [
        ["GET", "automation-logs"],
        ["POST", "run-full-automation"],
        ["POST", "create-folders"],
        ["POST", "sync-metadata"],
        ["POST", "generate-starter-docs"]
    ];
    for (const [method, path] of paths) {
        const r = await api(otherCookie, method, "/api/customers/" + customerId + "/" + path,
            method === "POST" ? {} : undefined);
        assert.equal(r.status, 404, method + " " + path + " should be 404 cross-tenant");
    }
});
