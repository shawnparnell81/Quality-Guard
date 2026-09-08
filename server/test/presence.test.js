/* ============================================================
   Concurrent-edit presence - PUT/DELETE /api/records/:number/editing
   plus the { entity: "presence" } frame on the SSE stream (P3.3).

   Two people in one org open the same record: each PUT reply names
   the other, a DELETE clears it, the change is pushed live, and one
   org can never see (or heartbeat) another org's record.
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
const PORT = 3116;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;      // org A admin
let mateCookie;       // org A, a second person
let otherCookie;      // org B admin
let mateName;

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
            body: JSON.stringify({ current_password: pw, new_password: "Presence-Test-Passphrase-1x" })
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

async function openStream(cookie) {
    const controller = new AbortController();
    const response = await fetch(BASE + "/api/stream", {
        headers: { Cookie: cookie, Accept: "text/event-stream" }, signal: controller.signal
    });
    assert.equal(response.status, 200);
    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    (async () => {
        let buffer = "";
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let sep;
                while ((sep = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, sep);
                    buffer = buffer.slice(sep + 2);
                    const line = frame.split("\n").find((l) => l.startsWith("data:"));
                    if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive */ } }
                }
            }
        } catch { /* aborted */ }
    })();
    return { events, close: () => controller.abort() };
}

async function waitFor(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const hit = predicate();
        if (hit) return hit;
        await sleep(50);
    }
    return null;
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(BASE + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("Test server never became healthy on " + BASE);
}

let ncrNumber;

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
        companyName: "Presence Test A " + stamp,
        adminEmail: "presence.a." + stamp + "@example.test", adminName: "Presence Admin A"
    });
    other = await provisionOrganization({
        companyName: "Presence Test B " + stamp,
        adminEmail: "presence.b." + stamp + "@example.test", adminName: "Presence Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    mateName = "Jordan Mate";
    const made = await api(adminCookie, "POST", "/api/users", {
        full_name: mateName, email: "presence.mate." + stamp + "@example.test",
        initials: "JM" + (stamp % 100000), role: "operator"
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    mateCookie = await loginAs(made.body.email || ("presence.mate." + stamp + "@example.test"),
        made.body.temporary_password);

    const ncr = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Shared record",
        data: { part_number: "RP-1", lot_number: "1", qty_affected: 1,
            detection_point: "Internal audit", disposition: "Rework" }
    });
    assert.equal(ncr.status, 201, JSON.stringify(ncr.body));
    ncrNumber = ncr.body.number;
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("editing an unknown record is a 404", async () => {
    const r = await api(adminCookie, "PUT", "/api/records/NCR-1999-0001/editing");
    assert.equal(r.status, 404);
});

test("each editor's heartbeat names the other, and DELETE clears it", async () => {
    const first = await api(adminCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.editors, [], "nobody else yet");

    const mate = await api(mateCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    assert.equal(mate.status, 200);
    assert.ok(mate.body.editors.some((e) => e.name === "Presence Admin A"),
        "the mate sees the admin: " + JSON.stringify(mate.body.editors));

    const again = await api(adminCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    assert.ok(again.body.editors.some((e) => e.name === mateName),
        "the admin now sees the mate: " + JSON.stringify(again.body.editors));

    const gone = await api(mateCookie, "DELETE", "/api/records/" + ncrNumber + "/editing");
    assert.equal(gone.status, 200);

    const afterLeave = await api(adminCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    assert.deepEqual(afterLeave.body.editors, [], "the mate is gone again");

    await api(adminCookie, "DELETE", "/api/records/" + ncrNumber + "/editing");
});

test("a presence change is pushed to the other editor's stream", async () => {
    const stream = await openStream(adminCookie);
    await sleep(150);

    await api(adminCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    await api(mateCookie, "PUT", "/api/records/" + ncrNumber + "/editing");

    const frame = await waitFor(() => stream.events.find((e) =>
        e.entity === "presence" && e.id === ncrNumber
        && (e.editors || []).some((x) => x.name === mateName)));
    assert.ok(frame, "a presence frame naming the mate arrived");

    stream.close();
    await api(adminCookie, "DELETE", "/api/records/" + ncrNumber + "/editing");
    await api(mateCookie, "DELETE", "/api/records/" + ncrNumber + "/editing");
});

test("one org cannot heartbeat another org's record", async () => {
    const r = await api(otherCookie, "PUT", "/api/records/" + ncrNumber + "/editing");
    assert.equal(r.status, 404);
});
