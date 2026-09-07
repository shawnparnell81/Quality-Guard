/* ============================================================
   Charts for the management review, clause 9.3.

   Proves /api/reviews/:ref/charts end to end: a review starts with no
   charts, one can be added with its points in order, edited (type and
   data replaced wholesale), and deleted; a seed endpoint hands back a
   ready-to-edit draft without saving it; a role without review.manage
   is refused every write; and one tenant's charts never leak to
   another - a review reference from another org simply 404s.
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
const PORT = 3093;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let other;
let adminCookie;
let otherCookie;
let deniedCookie;

const REF = "MR-CHART-TEST";

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
            body: JSON.stringify({ current_password: pw, new_password: "Review-Chart-1x" })
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
        companyName: "Review Chart A " + stamp,
        adminEmail: "rc.a." + stamp + "@example.test", adminName: "RC Admin A"
    });
    other = await provisionOrganization({
        companyName: "Review Chart B " + stamp,
        adminEmail: "rc.b." + stamp + "@example.test", adminName: "RC Admin B"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);
    otherCookie = await loginAs(other.admin.email, other.temporaryPassword);

    /* Each org gets a review to hang charts on. */
    for (const orgId of [tenant.orgId, other.orgId]) {
        await query(
            "insert into management_reviews (org_id, reference, period, status) values ($1, $2, $3, 'planned')",
            [orgId, REF, "Q-test"]
        );
    }

    const noPerm = await query(`
        select r.key from roles r
         where r.org_id = $1 and not exists (
             select 1 from role_permissions rp
              where rp.org_id = r.org_id and rp.role_key = r.key and rp.permission_key = 'review.manage')
         limit 1
    `, [tenant.orgId]);
    const denied = await api(adminCookie, "POST", "/api/users", {
        full_name: "No Charts", email: "nocharts." + stamp + "@example.test",
        initials: "NC" + (stamp % 100000), role: noPerm.rows[0].key
    });
    assert.equal(denied.status, 201, JSON.stringify(denied.body));
    deniedCookie = await loginAs(denied.body.email || ("nocharts." + stamp + "@example.test"),
        denied.body.temporary_password);
});

after(async () => {
    if (tenant) await query("delete from organizations where id = $1", [tenant.orgId]);
    if (other) await query("delete from organizations where id = $1", [other.orgId]);
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("a review starts with no charts", async () => {
    const got = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts");
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body.charts, []);
});

test("a chart is added with its points in order", async () => {
    const created = await api(adminCookie, "POST", "/api/reviews/" + REF + "/charts", {
        title: "NCRs by cause",
        chart_type: "pareto",
        x_label: "Cause", y_label: "Count",
        points: [
            { label: "Operator error", value: 12 },
            { label: "Material", value: 7 },
            { label: "Tooling", value: 4 },
            { label: "", value: 99 }
        ]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.charts.length, 1);

    const chart = created.body.charts[0];
    assert.equal(chart.title, "NCRs by cause");
    assert.equal(chart.chart_type, "pareto");
    assert.deepEqual(chart.points.map((p) => p.label), ["Operator error", "Material", "Tooling"],
        "blank-label rows are dropped, order preserved");
    assert.deepEqual(chart.points.map((p) => p.value), [12, 7, 4]);
});

test("a chart with no usable points is rejected", async () => {
    const bad = await api(adminCookie, "POST", "/api/reviews/" + REF + "/charts", {
        title: "Empty", chart_type: "bar", points: [{ label: "", value: 1 }]
    });
    assert.equal(bad.status, 400);

    const badType = await api(adminCookie, "POST", "/api/reviews/" + REF + "/charts", {
        title: "Weird", chart_type: "radar", points: [{ label: "a", value: 1 }]
    });
    assert.equal(badType.status, 400);
});

test("editing replaces the chart's type and data wholesale", async () => {
    const list = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts");
    const id = list.body.charts[0].id;

    const updated = await api(adminCookie, "PUT", "/api/reviews/" + REF + "/charts/" + id, {
        title: "On-time delivery",
        chart_type: "line",
        y_label: "%",
        points: [
            { label: "Apr", value: 94.2 },
            { label: "May", value: 96 },
            { label: "Jun", value: 97.5 }
        ]
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const chart = updated.body.charts[0];
    assert.equal(chart.chart_type, "line");
    assert.equal(chart.title, "On-time delivery");
    assert.deepEqual(chart.points.map((p) => p.label), ["Apr", "May", "Jun"]);
    assert.equal(chart.points[0].value, 94.2);
});

test("a seed draft comes back ready to edit and is not saved", async () => {
    const seeded = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts/seed/capa_by_status");
    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    assert.equal(seeded.body.draft.chart_type, "bar");
    assert.ok(Array.isArray(seeded.body.draft.points), "draft carries a points array");

    const unknown = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts/seed/nope");
    assert.equal(unknown.status, 404);

    const still = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts");
    assert.equal(still.body.charts.length, 1, "seeding did not persist anything");
});

test("a chart can be deleted", async () => {
    const list = await api(adminCookie, "GET", "/api/reviews/" + REF + "/charts");
    const id = list.body.charts[0].id;

    const removed = await api(adminCookie, "DELETE", "/api/reviews/" + REF + "/charts/" + id);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.charts, []);

    const gone = await api(adminCookie, "DELETE", "/api/reviews/" + REF + "/charts/" + id);
    assert.equal(gone.status, 404);
});

test("a role without review.manage cannot write, but can read", async () => {
    const read = await api(deniedCookie, "GET", "/api/reviews/" + REF + "/charts");
    assert.equal(read.status, 200, "reading is open to any signed-in user");

    const write = await api(deniedCookie, "POST", "/api/reviews/" + REF + "/charts", {
        title: "Nope", chart_type: "bar", points: [{ label: "a", value: 1 }]
    });
    assert.equal(write.status, 403);

    const seed = await api(deniedCookie, "GET", "/api/reviews/" + REF + "/charts/seed/capa_by_status");
    assert.equal(seed.status, 403);
});

test("another tenant's review reference is not found", async () => {
    /* Tenant A puts a chart on its own review... */
    await api(adminCookie, "POST", "/api/reviews/" + REF + "/charts", {
        title: "A's chart", chart_type: "bar", points: [{ label: "x", value: 1 }]
    });

    /* ...tenant B has a review with the same reference, but sees only its own (none). */
    const bSees = await api(otherCookie, "GET", "/api/reviews/" + REF + "/charts");
    assert.equal(bSees.status, 200);
    assert.deepEqual(bSees.body.charts, [], "B's identically-referenced review has no charts");

    /* A reference that exists in neither org is a flat 404. */
    const missing = await api(adminCookie, "GET", "/api/reviews/MR-DOES-NOT-EXIST/charts");
    assert.equal(missing.status, 404);
});
