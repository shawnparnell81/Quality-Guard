/* ============================================================
   Live change feed - GET /api/stream (Server-Sent Events, P3.1).

   A held-open connection receives a "change" frame when a record is
   created, edited or transitioned in the caller's org; another org's
   writes never appear on it; and the stream needs a session.

   Self-contained: provisions two throwaway orgs, runs the app on a
   spare port, cleans up after itself.
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
const PORT = 3115;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Stream-Test-Passphrase-1x" })
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

/* Open an SSE connection and return { events, close }. `events` fills
   with parsed "change" payloads as they arrive. */
async function openStream(cookie) {
    const controller = new AbortController();
    const response = await fetch(BASE + "/api/stream", {
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);

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
                    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
                    if (dataLine) {
                        try { events.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* keep-alive */ }
                    }
                }
            }
        } catch { /* aborted on close */ }
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
        companyName: "Stream Test A " + stamp,
        adminEmail: "stream.a." + stamp + "@example.test", adminName: "Stream Admin A"
    });
    other = await provisionOrganization({
        companyName: "Stream Test B " + stamp,
        adminEmail: "stream.b." + stamp + "@example.test", adminName: "Stream Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the stream needs a session", async () => {
    const r = await fetch(BASE + "/api/stream", { headers: { Accept: "text/event-stream" } });
    assert.equal(r.status, 401);
    if (r.body) await r.body.cancel();
});

test("creating, editing and transitioning a record each push a change frame", async () => {
    const stream = await openStream(adminCookie);
    await sleep(150);   // let the connection register its listener

    const made = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Porosity on lot 88",
        data: { part_number: "RP-1", lot_number: "88", qty_affected: 3,
            detection_point: "Internal audit", disposition: "Rework" }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const number = made.body.number;

    const createdEvt = await waitFor(() =>
        stream.events.find((e) => e.entity === "records" && e.id === number && e.action === "created"));
    assert.ok(createdEvt, "a 'created' frame arrived for " + number);
    assert.equal(createdEvt.orgId, String(tenant.orgId));

    await api(adminCookie, "PATCH", "/api/records/" + number, {
        data: { disposition: "Scrap" }, reason: "MRB"
    });
    assert.ok(await waitFor(() =>
        stream.events.find((e) => e.id === number && e.action === "updated")),
    "an 'updated' frame arrived");

    await api(adminCookie, "POST", "/api/records/" + number + "/transition",
        { to: "containment", reason: "segregated" });
    assert.ok(await waitFor(() =>
        stream.events.find((e) => e.id === number && e.action === "transitioned")),
    "a 'transitioned' frame arrived");

    stream.close();
});

test("one org's writes never appear on another org's stream", async () => {
    const mineStream = await openStream(adminCookie);
    const theirStream = await openStream(otherCookie);
    await sleep(150);

    const made = await api(adminCookie, "POST", "/api/records", {
        type: "ncr", title: "Private to org A",
        data: { part_number: "RP-9", lot_number: "1", qty_affected: 1,
            detection_point: "Internal audit", disposition: "Rework" }
    });
    assert.equal(made.status, 201);

    assert.ok(await waitFor(() =>
        mineStream.events.find((e) => e.id === made.body.number)),
    "org A sees its own change");

    await sleep(600);
    assert.equal(
        theirStream.events.filter((e) => e.id === made.body.number).length, 0,
        "org B's stream stayed quiet");

    mineStream.close();
    theirStream.close();
});
