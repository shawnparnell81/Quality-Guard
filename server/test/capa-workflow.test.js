/* ============================================================
   CAPA aligned to the five-phase CAPA process (migration 046).

   Initiation & evaluation -> Investigation & root cause ->
   Action planning -> Implementation & monitoring ->
   Effectiveness verification -> Closed | Escalated.

   Checks the new workflow states/transitions, the phase-grouped
   form (action table, RCA method, effectiveness outcome), the
   escalation path, the "no CAPA needed" early close, and that
   terminal moves are gated on capa.close.
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
const PORT = 3138;
const BASE = "http://localhost:" + PORT;

let serverProcess;
let tenant;
let adminCookie;
let operatorCookie;

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
            body: JSON.stringify({ current_password: pw, new_password: "Capa-Workflow-Test-1x" })
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

const raiseCapa = async (cookie, title, data = {}) => {
    const r = await api(cookie, "POST", "/api/records", {
        type: "capa", title, data: { problem_statement: "x", ...data }
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.number;
};
const move = (cookie, number, to) =>
    api(cookie, "POST", "/api/records/" + number + "/transition", { to, reason: "test" });
const statusOf = async (number) =>
    (await api(adminCookie, "GET", "/api/records/" + number)).body.record.status;

/* Clause 10.2: a real CAPA closure needs verification evidence on file. */
async function attachEvidence(cookie, number) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("%PDF-1.4 verification\n")], { type: "application/pdf" }),
        "effectiveness.pdf");
    const r = await fetch(BASE + "/api/records/" + number + "/attachments",
        { method: "POST", headers: { Cookie: cookie }, body: form });
    assert.equal(r.status, 201, await r.text());
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
        companyName: "CAPA Workflow " + stamp,
        adminEmail: "cw.admin." + stamp + "@example.test", adminName: "CW Admin"
    });
    adminCookie = await loginAs(tenant.admin.email, tenant.temporaryPassword);

    const op = await api(adminCookie, "POST", "/api/users", {
        full_name: "CW Operator", email: "cw.op." + stamp + "@example.test",
        initials: "CW" + (stamp % 100000), role: "operator"
    });
    assert.equal(op.status, 201, JSON.stringify(op.body));
    operatorCookie = await loginAs(op.body.email || ("cw.op." + stamp + "@example.test"),
        op.body.temporary_password);
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
    if (serverProcess) serverProcess.kill();
});

test("the form is grouped by CAPA phase with an action plan table", async () => {
    const form = await api(adminCookie, "GET", "/api/record-types/capa/form");
    assert.equal(form.status, 200);
    const fields = form.body.fields;
    const sections = [...new Set(fields.map((f) => f.section))];
    assert.deepEqual(sections, [
        "Initiation & evaluation", "Investigation & root cause", "Action planning",
        "Implementation & monitoring", "Effectiveness verification"
    ]);

    const rca = fields.find((f) => f.key === "rca_method");
    assert.deepEqual(rca.options, ["5 Why", "Fishbone", "Fault Tree", "Human Factors", "FMEA", "Other"]);

    const actions = fields.find((f) => f.key === "actions");
    assert.equal(actions.type, "table");
    assert.equal(actions.rowAttachments, true);
    assert.deepEqual(actions.columns.find((c) => c.key === "type").options,
        ["Containment", "Corrective", "Preventive"]);

    const outcome = fields.find((f) => f.key === "effectiveness_outcome");
    assert.ok(outcome.options.some((o) => /escalate/i.test(o)));

    /* still only problem_statement is required at creation */
    assert.deepEqual(fields.filter((f) => f.required).map((f) => f.key), ["problem_statement"]);
});

test("a new CAPA starts in Initiation & evaluation and walks the five phases to Closed", async () => {
    const num = await raiseCapa(adminCookie, "Recurring thread gage failures", {
        source: "Trend, 4 NCRs in 60 days",
        rca_method: "5 Why",
        significance: "High",
        capa_warranted: true,
        actions: [
            { action: "Contain suspect gages", type: "Containment", owner: "SP", status: "Done" },
            { action: "Revise gage cal interval", type: "Corrective", owner: "SP", status: "Open" },
            { action: "Add cal-interval review to PM audit", type: "Preventive", owner: "DW", status: "Open" }
        ],
        implementation_complete: true,
        effectiveness_outcome: "Effective"
    });

    assert.equal(await statusOf(num), "initiation");

    for (const to of ["investigation", "planning", "implementation", "effectiveness"]) {
        const r = await move(adminCookie, num, to);
        assert.equal(r.status, 200, to + ": " + JSON.stringify(r.body));
        assert.equal(await statusOf(num), to);
    }

    /* effective -> closed needs the verification evidence (clause 10.2) */
    const blocked = await move(adminCookie, num, "closed");
    assert.equal(blocked.status, 409, "closing effective without evidence is blocked");
    await attachEvidence(adminCookie, num);
    const closed = await move(adminCookie, num, "closed");
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(await statusOf(num), "closed");

    const rec = await api(adminCookie, "GET", "/api/records/" + num);
    assert.equal(rec.body.record.data.actions.length, 3);
    assert.equal(rec.body.record.data.actions[2].type, "Preventive");
    assert.equal(rec.body.record.data.capa_warranted, true);
});

test("a CAPA found not effective can be escalated", async () => {
    const num = await raiseCapa(adminCookie, "Nordvik PPM above threshold");
    for (const to of ["investigation", "planning", "implementation", "effectiveness"]) {
        assert.equal((await move(adminCookie, num, to)).status, 200, to);
    }
    const esc = await move(adminCookie, num, "escalated");
    assert.equal(esc.status, 200, JSON.stringify(esc.body));
    assert.equal(await statusOf(num), "escalated");
});

test("necessity determination: a CAPA can close straight from initiation", async () => {
    const num = await raiseCapa(adminCookie, "Single keying error, no CAPA warranted", {
        capa_warranted: false, necessity_rationale: "One-off, contained same shift, no trend"
    });
    const closed = await move(adminCookie, num, "closed");
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(await statusOf(num), "closed");
});

test("workflow moves are permissioned", async () => {
    const num = await raiseCapa(adminCookie, "Gated move check");
    const denied = await move(operatorCookie, num, "investigation");
    assert.equal(denied.status, 403, "an operator holds only capa.read");
    assert.equal(await statusOf(num), "initiation", "and the CAPA did not move");
});
