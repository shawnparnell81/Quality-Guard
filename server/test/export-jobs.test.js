/* ============================================================
   Asynchronous exports (audit M9).

   A record whose biggest table is under the threshold exports
   synchronously - a PDF / xlsx streams straight back. Over the
   threshold the route returns 202 { job_id }; the worker builds the
   file and GET /api/jobs/:id/download hands it over.

   The cross-instance case (any instance's worker can finish any
   instance's job) is in stream-cross-instance.test.js, which already
   runs two servers.
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
const PORT = 3149;
const BASE = "http://localhost:" + PORT;

let serverProcess, tenant, cookie, typeKey;

function extractCookie(r) {
    const raw = r.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}
async function waitForHealth(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("no health on " + BASE);
}
async function api(method, path, payload) {
    const r = await fetch(BASE + path, {
        method, headers: { "Content-Type": "application/json", Cookie: cookie },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not always JSON */ }
    return { status: r.status, body, headers: r.headers };
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT), EXPORT_ASYNC_ROWS: "5" }, stdio: "pipe" });
    let boot = "";
    serverProcess.stdout.on("data", (c) => { boot += c; });
    serverProcess.stderr.on("data", (c) => { boot += c; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("server exited early:\n" + boot);
    });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "Exp " + stamp,
        adminEmail: "exp." + stamp + "@example.test", adminName: "Exp Admin"
    });
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: tenant.admin.email, password: tenant.temporaryPassword })
    });
    cookie = extractCookie(login);
    const body = await login.json();
    if (body.must_change_password) {
        const ch = await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: tenant.temporaryPassword, new_password: "Exp-Passphrase-1x" })
        });
        cookie = extractCookie(ch) || cookie;
    }

    const made = await api("POST", "/api/record-types", {
        name: "Big Grid", prefix: "BG",
        fields: [
            { key: "note", label: "Note", type: "text" },
            { key: "rows", label: "Rows", type: "table",
              columns: [{ key: "item", label: "Item", type: "text" }] }
        ]
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    typeKey = made.body.key;
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

async function makeRecord(rowCount) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({ item: "row " + i }));
    const r = await api("POST", "/api/records", {
        type: typeKey, title: rowCount + "-row record", data: { note: "hi", rows }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number;
}

async function pollJob(jobId, ms = 20000) {
    const deadline = Date.now() + ms;
    let job;
    do {
        await sleep(400);
        job = (await api("GET", "/api/jobs/" + jobId)).body;
    } while (job && job.status !== "done" && job.status !== "error" && Date.now() < deadline);
    return job;
}

test("a small record still exports synchronously", async () => {
    const number = await makeRecord(2);
    const r = await fetch(BASE + "/api/records/" + number + "/excel", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /spreadsheetml/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(buf.subarray(0, 2), Buffer.from("PK"), "a real xlsx");
});

test("a big record returns 202 and the worker builds the xlsx", async () => {
    const number = await makeRecord(40);   // over EXPORT_ASYNC_ROWS=5

    const queued = await api("GET", "/api/records/" + number + "/excel");
    assert.equal(queued.status, 202, JSON.stringify(queued.body));
    const jobId = queued.body.job_id;
    assert.ok(jobId);

    const job = await pollJob(jobId);
    assert.equal(job.status, "done", JSON.stringify(job));
    assert.ok(job.ready);

    const dl = await fetch(BASE + "/api/jobs/" + jobId + "/download", { headers: { Cookie: cookie } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get("content-disposition"), new RegExp(number));
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.deepEqual(buf.subarray(0, 2), Buffer.from("PK"), "the worker produced a real xlsx");
});

test("a big record's PDF also goes async and comes back as a PDF", async () => {
    const number = await makeRecord(40);
    const queued = await api("GET", "/api/records/" + number + "/pdf");
    assert.equal(queued.status, 202);

    const job = await pollJob(queued.body.job_id);
    assert.equal(job.status, "done", JSON.stringify(job));

    const dl = await fetch(BASE + "/api/jobs/" + queued.body.job_id + "/download", { headers: { Cookie: cookie } });
    assert.equal(dl.status, 200);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.deepEqual(buf.subarray(0, 4), Buffer.from("%PDF"), "a real PDF");
});

test("an inline PDF preview is never deferred - a person is watching for it", async () => {
    const number = await makeRecord(40);
    const r = await fetch(BASE + "/api/records/" + number + "/pdf?inline=1", { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /application\/pdf/);
    assert.match(r.headers.get("content-disposition"), /inline/);
});

test("another org cannot read someone else's job", async () => {
    const number = await makeRecord(40);
    const jobId = (await api("GET", "/api/records/" + number + "/excel")).body.job_id;

    const otherStamp = Date.now();
    const other = await provisionOrganization({
        companyName: "Exp Other " + otherStamp,
        adminEmail: "exp.other." + otherStamp + "@example.test", adminName: "Other"
    });
    const login = await fetch(BASE + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: other.admin.email, password: other.temporaryPassword })
    });
    let otherCookie = extractCookie(login);
    const ob = await login.json();
    if (ob.must_change_password) {
        const ch = await fetch(BASE + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: otherCookie },
            body: JSON.stringify({ current_password: other.temporaryPassword, new_password: "Exp-Other-Passphrase-1x" })
        });
        otherCookie = extractCookie(ch) || otherCookie;
    }

    const peek = await fetch(BASE + "/api/jobs/" + jobId, { headers: { Cookie: otherCookie } });
    assert.equal(peek.status, 404);

    await query("delete from organizations where id = $1", [other.orgId]);
});
