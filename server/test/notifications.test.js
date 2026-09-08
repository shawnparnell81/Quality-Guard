/* ============================================================
   In-app notification centre (P3.4).

   Covers the four computed buckets that matter for a first cut:
   a record assigned to you, one of yours gone overdue, a record a
   step away from a sign-off you are allowed to give, and the feed
   reconciling itself (mark read, mark all, and a row disappearing
   once its record closes). Plus: you cannot read someone else's.

   Self-contained: provisions a throwaway org, runs the app on a
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
const PORT = 3117;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let mateCookie;
let mateInitials;

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
            body: JSON.stringify({ current_password: pw, new_password: "Notif-Test-Passphrase-1x" })
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

const isoDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
};

async function raiseNcr(fields) {
    const r = await api(adminCookie, "POST", "/api/records", {
        type: "ncr",
        data: { part_number: "RP-1", lot_number: "1", qty_affected: 1,
            detection_point: "Internal audit", disposition: "Rework" },
        ...fields
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number;
}

const feed = (cookie) => api(cookie, "GET", "/api/notifications");
const has = (body, dedupePrefix, number) =>
    body.items.some((n) => n.link_number === number && n.kind === dedupePrefix);

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
        companyName: "Notif Test " + stamp,
        adminEmail: "notif.admin." + stamp + "@example.test", adminName: "Notif Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    mateInitials = "NM" + (stamp % 100000);
    const made = await api(adminCookie, "POST", "/api/users", {
        full_name: "Nora Mate", email: "notif.mate." + stamp + "@example.test",
        initials: mateInitials, role: "quality_engineer"
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    mateCookie = await loginAs(made.body.email || ("notif.mate." + stamp + "@example.test"),
        made.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a record assigned to you shows up, once", async () => {
    const number = await raiseNcr({ title: "Assigned to the mate", owner: mateInitials });

    const first = await feed(mateCookie);
    assert.equal(first.status, 200);
    assert.ok(has(first.body, "assigned", number), JSON.stringify(first.body.items));
    assert.ok(first.body.unread_count >= 1);

    /* the sync is idempotent - a second read does not double it up */
    const second = await feed(mateCookie);
    assert.equal(
        second.body.items.filter((n) => n.link_number === number && n.kind === "assigned").length,
        1);

    /* and it is the mate's, not the admin's */
    const adminFeed = await feed(adminCookie);
    assert.ok(!has(adminFeed.body, "assigned", number));
});

test("one of yours past its due date also raises an overdue item", async () => {
    const number = await raiseNcr({
        title: "Late one", owner: mateInitials, due_at: isoDaysAgo(3)
    });

    const body = (await feed(mateCookie)).body;
    assert.ok(has(body, "assigned", number));
    assert.ok(has(body, "overdue", number), JSON.stringify(body.items));
});

test("a record a step away from a sign-off you can give is an approval", async () => {
    const number = await raiseNcr({ title: "Needs disposition sign-off" });
    /* draft -> containment; from containment the next step needs
       ncr.disposition, which the admin holds. */
    const moved = await api(adminCookie, "POST", "/api/records/" + number + "/transition",
        { to: "containment", reason: "segregated" });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const body = (await feed(adminCookie)).body;
    assert.ok(has(body, "approval", number), JSON.stringify(body.items));
});

test("marking read: one, then all; and you cannot touch someone else's", async () => {
    const body = (await feed(mateCookie)).body;
    const mine = body.items.find((n) => !n.read_at);
    assert.ok(mine, "the mate has something unread");

    const notMine = await api(adminCookie, "POST", "/api/notifications/" + mine.id + "/read");
    assert.equal(notMine.status, 404, "the admin cannot read the mate's notification");

    const ok = await api(mateCookie, "POST", "/api/notifications/" + mine.id + "/read");
    assert.equal(ok.status, 200);
    const again = await api(mateCookie, "POST", "/api/notifications/" + mine.id + "/read");
    assert.equal(again.status, 404, "already read");

    const afterOne = (await feed(mateCookie)).body;
    assert.equal(afterOne.items.find((n) => n.id === mine.id).read_at !== null, true);

    const cleared = await api(mateCookie, "POST", "/api/notifications/read-all");
    assert.equal(cleared.status, 200);
    assert.equal((await feed(mateCookie)).body.unread_count, 0);
});

test("a notification disappears once its record is closed", async () => {
    const number = await raiseNcr({ title: "Will be closed", owner: mateInitials });
    assert.ok(has((await feed(mateCookie)).body, "assigned", number));

    for (const to of ["containment", "mrb", "disposition", "verify", "closed"]) {
        const r = await api(adminCookie, "POST", "/api/records/" + number + "/transition",
            { to, reason: "walking to closed" });
        assert.equal(r.status, 200, to + ": " + JSON.stringify(r.body));
    }

    const body = (await feed(mateCookie)).body;
    assert.ok(!has(body, "assigned", number), "the assigned row was reconciled away");
    assert.ok(!has(body, "overdue", number));
});
