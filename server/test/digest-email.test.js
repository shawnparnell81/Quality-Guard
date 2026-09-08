/* ============================================================
   Email notifications: per-user opt-in + the daily digest (P3.5).

   The prefs endpoint validates and persists a mode; runDigestOnce()
   emails only the users on 'digest' who actually have something on
   their feed; 'off' users and empty feeds are skipped; and with no
   SMTP configured sendMail is a no-op rather than an error.

   Setup goes through the running app's HTTP API; the digest itself
   is exercised by importing runDigestOnce() and handing it a
   capturing sender.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";
import { runDigestOnce } from "../src/digest.js";
import { sendMail, isMailConfigured } from "../src/mail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..");
const PORT = 3118;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let digestCookie;
let offCookie;
let digestEmail;
let offEmail;
let digestInitials;

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
            body: JSON.stringify({ current_password: pw, new_password: "Digest-Test-Passphrase-1x" })
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

async function makeUser(name, tag, initials, role) {
    const email = tag + "@example.test";
    const made = await api(adminCookie, "POST", "/api/users", {
        full_name: name, email, initials, role
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const cookie = await loginAs(made.body.email || email, made.body.temporary_password);
    return { email, cookie, initials: made.body.initials || initials };
}

before(async () => {
    serverProcess = spawn(process.execPath, ["--env-file=.env", "src/app.js"],
        { cwd: serverRoot, env: { ...process.env, PORT: String(PORT), SMTP_HOST: "" }, stdio: "pipe" });
    let bootLog = "";
    serverProcess.stdout.on("data", (c) => { bootLog += c; });
    serverProcess.stderr.on("data", (c) => { bootLog += c; });
    serverProcess.on("exit", (code) => {
        if (code !== null && code !== 0) console.error("Test server exited early:\n" + bootLog);
    });
    await waitForHealth(15000);

    const stamp = Date.now();
    tenant = await provisionOrganization({
        companyName: "Digest Test " + stamp,
        adminEmail: "digest.admin." + stamp + "@example.test", adminName: "Digest Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const d = await makeUser("Dana Digest", "digest.dana." + stamp,
        "DG" + (stamp % 100000), "quality_engineer");
    digestCookie = d.cookie; digestEmail = d.email; digestInitials = d.initials;
    const o = await makeUser("Otto Off", "digest.otto." + stamp,
        "OF" + (stamp % 100000), "quality_engineer");
    offCookie = o.cookie; offEmail = o.email;
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the prefs endpoint validates and round-trips", async () => {
    const bad = await api(digestCookie, "PATCH", "/api/notification-prefs",
        { email_notifications: "hourly" });
    assert.equal(bad.status, 400);

    const set = await api(digestCookie, "PATCH", "/api/notification-prefs",
        { email_notifications: "digest" });
    assert.equal(set.status, 200);
    assert.equal(set.body.email_notifications, "digest");

    const get = await api(digestCookie, "GET", "/api/notification-prefs");
    assert.equal(get.body.email_notifications, "digest");

    /* a brand-new account defaults to off */
    const other = await api(offCookie, "GET", "/api/notification-prefs");
    assert.equal(other.body.email_notifications, "off");
});

test("with no SMTP set, sendMail is a logged no-op", async () => {
    assert.equal(isMailConfigured(), false);
    const result = await sendMail({ to: "someone@example.test", subject: "hi", text: "hi" });
    assert.equal(result.skipped, true);
});

test("the digest emails only opted-in users who have something waiting", async () => {
    /* Dana (digest) owns an open NCR -> she has an assigned item.
       Otto (off) owns one too but never opted in. */
    for (const owner of [digestInitials]) {
        const r = await api(adminCookie, "POST", "/api/records", {
            type: "ncr", title: "Digest me", owner,
            data: { part_number: "RP-1", lot_number: "1", qty_affected: 1,
                detection_point: "Internal audit", disposition: "Rework" }
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
    }

    const outbox = [];
    const summary = await runDigestOnce({ send: async (mail) => { outbox.push(mail); } });

    const toDana = outbox.find((m) => m.to === digestEmail);
    assert.ok(toDana, "Dana got a digest: " + JSON.stringify(outbox.map((m) => m.to)));
    assert.match(toDana.subject, /daily summary/i);
    assert.match(toDana.text, /assigned to you/i);

    assert.ok(!outbox.some((m) => m.to === offEmail), "Otto (off) was not emailed");
    assert.ok(summary.sent.some((s) => s.email === digestEmail && s.count >= 1));
});

test("a digest user with an empty feed is not emailed", async () => {
    /* Mark everything read so Dana's feed is empty. */
    await api(digestCookie, "POST", "/api/notifications/read-all");

    const outbox = [];
    await runDigestOnce({ send: async (mail) => { outbox.push(mail); } });
    assert.ok(!outbox.some((m) => m.to === digestEmail), "no mail when nothing is waiting");
});
