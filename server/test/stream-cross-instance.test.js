/* ============================================================
   Cross-instance SSE fan-out (audit H8).

   Two app instances on two ports share one database. A change made
   through instance A must reach an SSE stream held open on instance
   B - that only works because publish() is a Postgres NOTIFY and
   each instance LISTENs. Presence rides the same bus, so an editor
   on A shows up in B's editor list too.
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
const PORT_A = 3147;
const PORT_B = 3148;
const BASE_A = "http://localhost:" + PORT_A;
const BASE_B = "http://localhost:" + PORT_B;

let procA, procB, tenant, cookie;

function extractCookie(r) {
    const raw = r.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

function spawnApp(port) {
    const p = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(port) }, stdio: "pipe" });
    p._log = "";
    p.stdout.on("data", (c) => { p._log += c; });
    p.stderr.on("data", (c) => { p._log += c; });
    return p;
}

async function waitForHealth(base, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try { if ((await fetch(base + "/api/health")).ok) return; } catch { /* not up */ }
        await sleep(250);
    }
    throw new Error("no health on " + base);
}

async function api(base, method, path, payload) {
    const r = await fetch(base + path, {
        method, headers: { "Content-Type": "application/json", Cookie: cookie },
        body: payload !== undefined ? JSON.stringify(payload) : undefined
    });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not always JSON */ }
    return { status: r.status, body };
}

async function openStream(base) {
    const controller = new AbortController();
    const response = await fetch(base + "/api/stream", {
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        signal: controller.signal
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
                    const dl = frame.split("\n").find((l) => l.startsWith("data:"));
                    if (dl) { try { events.push(JSON.parse(dl.slice(5).trim())); } catch { /* keep-alive */ } }
                }
            }
        } catch { /* aborted */ }
    })();
    return { events, close: () => controller.abort() };
}

async function waitFor(fn, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const hit = fn();
        if (hit) return hit;
        await sleep(50);
    }
    return null;
}

before(async () => {
    procA = spawnApp(PORT_A);
    procB = spawnApp(PORT_B);
    await Promise.all([waitForHealth(BASE_A, 15000), waitForHealth(BASE_B, 15000)]);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "XInst " + stamp,
        adminEmail: "xinst." + stamp + "@example.test", adminName: "XInst Admin"
    });
    const login = await fetch(BASE_A + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: tenant.admin.email, password: tenant.temporaryPassword })
    });
    cookie = extractCookie(login);
    const body = await login.json();
    if (body.must_change_password) {
        const changed = await fetch(BASE_A + "/api/auth/change-password", {
            method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ current_password: tenant.temporaryPassword, new_password: "XInst-Passphrase-1x" })
        });
        cookie = extractCookie(changed) || cookie;
    }
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (procA) procA.kill();
    if (procB) procB.kill();
});

test("a write on instance A reaches an SSE stream on instance B", async () => {
    const streamB = await openStream(BASE_B);
    await sleep(200);

    const made = await api(BASE_A, "POST", "/api/records", {
        type: "ncr", title: "cross-instance NCR",
        data: { part_number: "RP-1", disposition: "Rework" }
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const frame = await waitFor(() =>
        streamB.events.find((e) => e.entity === "records" && e.id === made.body.number));
    assert.ok(frame, "instance B's stream received the change published by instance A\n" + procB._log.slice(-600));
    assert.equal(frame.orgId, String(tenant.orgId));

    streamB.close();
});

test("a presence heartbeat on instance A pushes a frame to instance B's stream", async () => {
    const made = await api(BASE_A, "POST", "/api/records", {
        type: "ncr", title: "presence NCR", data: { part_number: "RP-2", disposition: "Rework" }
    });
    const number = made.body.number;

    const streamB = await openStream(BASE_B);
    await sleep(200);

    await api(BASE_A, "PUT", "/api/records/" + number + "/editing", { dirty: true });

    const frame = await waitFor(() => streamB.events.find(
        (e) => e.entity === "presence" && e.id === number && Array.isArray(e.editors)));
    assert.ok(frame, "instance B saw the presence frame from instance A's heartbeat");
    assert.equal(frame.editors.length, 1);
    assert.equal(frame.editors[0].dirty, true);

    streamB.close();
});
