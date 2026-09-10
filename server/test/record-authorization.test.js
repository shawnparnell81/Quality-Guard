/* ============================================================
   Authorization on the record side doors, and numbering under load.

   Four P0 findings, proven through the HTTP API:

     1. requirePermission(createPermissionFor) read the type out of
        request.body only. Four of the six create routes carry it in
        ?type= (and the two multipart ones have no parsed body at all
        when the guard runs), so the resolver returned null and the
        guard waved the request through.

     2. The PDF, Excel, attachment-list, attachment-file and clone
        routes returned a record's contents with no read-permission
        check. The register hid such a record; a direct URL did not.

     3. Record numbers were max(seq)+1 with no lock, so concurrent
        creates of the same type collided on
        records_org_id_number_key and the loser got a 500.

     4. Both PATCH routes are guarded by editPermissionFor, which
        names no permission for an ordinary field correction, and a
        null key means "no permission needed". Anyone signed in could
        therefore write - and read back - a record of a type they hold
        no read permission for.

   Roles used: operator holds ncr.read / ncr.create and no capa
   permission at all; quality_inspector holds capa.read but NOT
   capa.create, which is what separates "may not read this record"
   from "may not raise one of these" on the clone route.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3150;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;      // general_manager - holds everything in the catalogue
let operatorCookie;   // no capa.read, no capa.create
let inspectorCookie;  // capa.read, but no capa.create

let capaNumber;
let ncrNumber;
let capaAttachmentId;

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
            body: JSON.stringify({ current_password: pw, new_password: "Record-Authz-Test-2x" })
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
    return { status: r.status, body, text, contentType: r.headers.get("content-type") || "" };
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

async function addUser(stamp, suffix, role, name) {
    const email = "ra." + suffix + "." + stamp + "@example.test";
    const made = await api(adminCookie, "POST", "/api/users", {
        full_name: name, email,
        initials: suffix.toUpperCase().slice(0, 2) + (stamp % 10000), role
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return loginAs(email, made.body.temporary_password);
}

/* A denied side door must answer with the error envelope, never with
   the file it was asked for - a 403 whose body is still the PDF would
   pass a status-only assertion. */
function assertRefused(result, requiredKey) {
    assert.equal(result.status, 403, "expected 403, got " + result.status + ": " + result.text.slice(0, 200));
    assert.equal(result.body?.required, requiredKey);
    assert.equal(result.body?.error, "Your role does not permit this");
    assert.ok(result.contentType.includes("application/json"),
        "a refusal must not carry the export it refused: " + result.contentType);
}

/* Nor may it carry the record. The ZEBRA markers are unique to the
   fixtures, so a body holding one has leaked the very thing the
   permission exists to withhold. */
function assertNeverLeaked(result) {
    assert.ok(!result.text.includes("ZEBRACAPA"), "the refusal leaked the record's title");
    assert.ok(!result.text.includes("press force out of window"),
        "the refusal leaked a data field value");
    assert.ok(!result.text.includes("ZEBRAROW"), "the refusal leaked a table row");
    assert.equal(result.body?.data, undefined);
    assert.equal(result.body?.title, undefined);
    assert.equal(result.body?.rows, undefined);
    assert.equal(result.body?.row_count, undefined);
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
        companyName: "Record Authz " + stamp,
        adminEmail: "ra.admin." + stamp + "@example.test", adminName: "RA Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    operatorCookie = await addUser(stamp, "op", "operator", "RA Operator");
    inspectorCookie = await addUser(stamp, "insp", "quality_inspector", "RA Inspector");

    const capa = await api(adminCookie, "POST", "/api/records", {
        type: "capa", title: "Bearing press force drift ZEBRACAPA",
        data: { problem_statement: "press force out of window on line 3" }
    });
    assert.equal(capa.status, 201, JSON.stringify(capa.body));
    capaNumber = capa.body.number;

    /* A row in the action plan, so a table-field refusal that leaked
       its rows would be visible rather than an empty array. */
    const seeded = await api(adminCookie, "PATCH", "/api/records/" + capaNumber + "/table/actions", {
        upsert: [{ action: "Re-validate press force ZEBRAROW", type: "Corrective" }]
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));

    const ncr = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Bore oversize ZEBRANCR", data: { disposition: "Rework" }
    });
    assert.equal(ncr.status, 201, JSON.stringify(ncr.body));
    ncrNumber = ncr.body.number;

    const form = new FormData();
    form.append("file", new Blob([Buffer.from("evidence bytes")], { type: "text/plain" }), "evidence.txt");
    const uploaded = await fetch(BASE + "/api/records/" + capaNumber + "/attachments", {
        method: "POST", headers: { Cookie: adminCookie }, body: form
    });
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 201, uploadedText);
    capaAttachmentId = JSON.parse(uploadedText).id;
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

/* ---------- fix 1: the create guard actually reads the type ---------- */

test("importing a type the caller may not raise is refused", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("not even a real sheet")]), "rows.xlsx");
    const r = await fetch(BASE + "/api/records/import?type=capa", {
        method: "POST", headers: { Cookie: operatorCookie }, body: form
    });
    const text = await r.text();
    assert.equal(r.status, 403, text);
    assert.equal(JSON.parse(text).required, "capa.create");

    /* Nothing was created, and the failure is not merely the sheet
       being unreadable - the guard has to run before multer. */
    const list = await api(adminCookie, "GET", "/api/records?type=capa&limit=500");
    assert.equal(list.body.records.length, 1, "the refused import must not have created anything");
});

test("the excel upload of a type the caller may not raise is refused", async () => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("not even a real sheet")]), "form.xlsx");
    const r = await fetch(BASE + "/api/records/excel?type=capa", {
        method: "POST", headers: { Cookie: operatorCookie }, body: form
    });
    assert.equal(r.status, 403, await r.text());
});

test("the template downloads are gated by the same create permission", async () => {
    assertRefused(
        await api(operatorCookie, "GET", "/api/records/import-template?type=capa"),
        "capa.create");
    assertRefused(
        await api(operatorCookie, "GET", "/api/records/excel-template?type=capa"),
        "capa.create");

    /* and are not broken for someone who does hold it */
    const allowed = await fetch(BASE + "/api/records/import-template?type=capa",
        { headers: { Cookie: adminCookie } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get("content-type") || "", /spreadsheetml/);
});

test("a create that names no type, or two, is refused rather than waved through", async () => {
    /* Naming no type is a malformed request, so it is answered as one
       - but still by the guard, before any handler runs. */
    const none = await api(adminCookie, "POST", "/api/records", { title: "No type at all" });
    assert.equal(none.status, 400, none.text.slice(0, 200));
    assert.equal(none.body?.error, "type is required");
    assert.equal(none.body?.required, undefined, "must not name an ungrantable permission");
    assert.equal(none.body?.number, undefined, "the refused create must not have made a record");

    /* ?type= must not be able to buy a permission check for a type
       the body does not actually create. */
    const mismatch = await api(operatorCookie, "POST", "/api/records?type=ncr",
        { type: "capa", title: "Guard says ncr, handler makes capa" });
    assertRefused(mismatch, "records.create_unlisted");
});

test("cloning needs the authority to raise the source record's type", async () => {
    /* The inspector may read this CAPA - so the refusal is about
       raising one, not about seeing it. */
    assert.equal((await api(inspectorCookie, "GET", "/api/records/" + capaNumber)).status, 200);

    assertRefused(
        await api(inspectorCookie, "POST", "/api/records/" + capaNumber + "/clone", {}),
        "capa.create");

    /* and a type they may raise still clones */
    const allowed = await api(inspectorCookie, "POST", "/api/records/" + ncrNumber + "/clone", {});
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    assert.equal(allowed.body.cloned_from, ncrNumber);
});

/* ---------- fix 2: the side doors honour the read permission ---------- */

test("the PDF of a record the caller may not read is refused, not rendered", async () => {
    const denied = await api(operatorCookie, "GET", "/api/records/" + capaNumber + "/pdf");
    assertRefused(denied, "capa.read");
    assert.ok(!denied.text.startsWith("%PDF"), "the PDF was rendered anyway");
    assert.ok(!denied.text.includes("ZEBRACAPA"), "the refusal leaked the record's title");

    const allowed = await fetch(BASE + "/api/records/" + ncrNumber + "/pdf",
        { headers: { Cookie: operatorCookie } });
    assert.equal(allowed.status, 200, "a readable type still renders");
    assert.equal(allowed.headers.get("content-type"), "application/pdf");
});

test("the Excel export of an unreadable record is refused", async () => {
    const denied = await api(operatorCookie, "GET", "/api/records/" + capaNumber + "/excel");
    assertRefused(denied, "capa.read");
    assert.ok(!denied.text.includes("ZEBRACAPA"));
});

test("attachments of an unreadable record are neither listed nor streamed", async () => {
    const list = await api(operatorCookie, "GET", "/api/records/" + capaNumber + "/attachments");
    assertRefused(list, "capa.read");
    assert.ok(!list.text.includes("evidence.txt"), "the attachment list leaked through the refusal");

    const file = await api(operatorCookie, "GET",
        "/api/records/" + capaNumber + "/attachments/" + capaAttachmentId + "/file");
    assertRefused(file, "capa.read");
    assert.ok(!file.text.includes("evidence bytes"), "the file was served anyway");

    /* the person who may read it is unaffected */
    const ok = await api(inspectorCookie, "GET", "/api/records/" + capaNumber + "/attachments");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.count, 1);
});

/* ---------- fix 4: an edit is also a read ----------

   editPermissionFor names no permission for a body that sets no
   disposition, and requirePermission treats a null key as "no
   permission needed", so both PATCH routes ran for anyone signed in
   and answered with the record they had just written. */

test("PATCH of a record the caller may not read is refused and leaks nothing", async () => {
    const denied = await api(operatorCookie, "PATCH", "/api/records/" + capaNumber, {});
    assertRefused(denied, "capa.read");
    assertNeverLeaked(denied);

    /* And it is a write path, not only a leak: an empty body was a
       no-op rewrite, but a title is not. */
    const renamed = await api(operatorCookie, "PATCH", "/api/records/" + capaNumber,
        { title: "Renamed by someone who cannot read it" });
    assertRefused(renamed, "capa.read");

    const still = await api(inspectorCookie, "GET", "/api/records/" + capaNumber);
    assert.equal(still.body.record.title, "Bearing press force drift ZEBRACAPA");
});

test("PATCH of a table field on an unreadable record leaks no rows", async () => {
    const denied = await api(operatorCookie, "PATCH",
        "/api/records/" + capaNumber + "/table/actions", { remove: ["not-a-real-row-id"] });
    assertRefused(denied, "capa.read");
    assertNeverLeaked(denied);
});

test("someone who may read the type still edits it", async () => {
    /* The inspector holds capa.read and no capa write permission at
       all, which is exactly the case editPermissionFor waves through.
       The read check has to be additive, not a new gate on every
       ordinary field correction. */
    const edited = await api(inspectorCookie, "PATCH", "/api/records/" + capaNumber, {
        data: { root_cause: "press regulator drift" },
        reason: "investigation closed out"
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.root_cause, "press regulator drift");
    assert.equal(edited.body.title, "Bearing press force drift ZEBRACAPA");

    const rows = await api(inspectorCookie, "PATCH",
        "/api/records/" + capaNumber + "/table/actions",
        { upsert: [{ action: "Verify at 30 days" }] });
    assert.equal(rows.status, 200, JSON.stringify(rows.body));
    assert.equal(rows.body.row_count, 2);
});

/* ---------- fix 3: numbering under concurrency ---------- */

test("ten simultaneous creates of one type get ten distinct numbers and no 500", async () => {
    const attempts = await Promise.all(
        Array.from({ length: 10 }, (unused, i) => api(adminCookie, "POST", "/api/records", {
            type: "ncr", title: "Concurrent raise " + i, data: { disposition: "Rework" }
        }))
    );

    const failed = attempts.filter((a) => a.status !== 201);
    assert.equal(failed.length, 0,
        "every concurrent create should succeed: " + JSON.stringify(failed.map((f) => [f.status, f.body])));

    const numbers = attempts.map((a) => a.body.number);
    assert.equal(new Set(numbers).size, 10, "duplicate record numbers were handed out: " + numbers.join(", "));
});
