/* ============================================================
   Record-type definitions - one canonical source (audit P0 / H1).

   src/record-definitions/ is now the single place a built-in record
   type's key/name/prefix/clause, its workflow, and its default form
   are defined. scripts/provision-org.js builds every tenant from it.

   These tests are the parity contract the old code-comments only
   promised:
     - every canonical default form is a schema the form engine will
       actually accept (problemWith),
     - a freshly provisioned org's database rows match the modules
       exactly - types, workflow states, workflow transitions, and the
       published form schema,
     - the count lines up on all three sides, so a type cannot be
       half-wired,
     - the seeded demo org (db/seed.sql + every migration) carries
       every built-in type with a workflow that still matches the
       modules - so a future migration that quietly drifts a workflow
       from src/record-definitions/ fails here. Its forms are NOT
       checked: Ridgeline's demo forms are deliberately richer
       (master-data links, conditional rules) than the plain default.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { allDefinitions, definitionFor } from "../src/record-definitions/index.js";
import { problemWith } from "../src/routes/masterdata.js";
import { provisionOrganization } from "../scripts/provision-org.js";
import { pool, query } from "../src/db.js";

/* db/seed.sql pins Ridgeline to this id. */
const SEED_ORG = "11111111-1111-1111-1111-111111111111";

let tenant;

/* One org's workflow for one type, shaped like a module's
   `states` / `transitions` (transitions sorted the deterministic way
   the modules are compared in). */
async function workflowRows(orgId, key) {
    const states = await query(`
        select ws.key, ws.name, ws.position, ws.is_terminal
          from workflow_states ws
          join record_types rt on rt.id = ws.record_type_id
         where rt.org_id = $1 and rt.key = $2
         order by ws.position
    `, [orgId, key]);

    const transitions = await query(`
        select wt.from_state, wt.to_state, wt.required_permission
          from workflow_transitions wt
          join record_types rt on rt.id = wt.record_type_id
         where rt.org_id = $1 and rt.key = $2
         order by wt.from_state, wt.to_state
    `, [orgId, key]);

    return {
        states: states.rows.map((r) => [r.key, r.name, r.position, r.is_terminal]),
        transitions: transitions.rows.map((r) => [r.from_state, r.to_state, r.required_permission])
    };
}

function expectedTransitions(def) {
    return [...def.transitions].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

before(async () => {
    tenant = await provisionOrganization({
        companyName: "Def Parity " + Date.now(),
        adminEmail: "defparity." + Date.now() + "@example.test",
        adminName: "Def Parity"
    });
});

after(async () => {
    if (tenant) {
        await query("delete from record_audit where org_id = $1", [tenant.orgId]);
        await query("delete from organizations where id = $1", [tenant.orgId]);
    }
    await pool.end();
});

test("every canonical default form passes the form-engine validator", () => {
    for (const def of allDefinitions()) {
        const problem = problemWith(def.form.fields);
        assert.equal(problem, null, def.key + ": " + problem);
        assert.ok(Array.isArray(def.form.rules), def.key + " has a rules array");
    }
});

test("the definition set is internally consistent", () => {
    const keys = allDefinitions().map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
    for (const key of keys) assert.equal(definitionFor(key).key, key);
    assert.equal(definitionFor("does-not-exist"), undefined);

    for (const def of allDefinitions()) {
        assert.ok(def.name && def.prefix && def.clause, def.key + " has full metadata");
        assert.ok(def.states.length >= 2, def.key + " has at least two states");
        const stateKeys = new Set(def.states.map(([k]) => k));
        assert.ok(def.states.some(([, , , terminal]) => terminal === true), def.key + " has a terminal state");
        for (const [from, to, permission] of def.transitions) {
            assert.ok(stateKeys.has(from), def.key + " transition from unknown state " + from);
            assert.ok(stateKeys.has(to), def.key + " transition to unknown state " + to);
            assert.ok(permission, def.key + " transition " + from + "->" + to + " has no permission");
        }
    }
});

test("a freshly provisioned org has exactly the canonical record types", async () => {
    const rows = await query(
        "select key, name, prefix, clause from record_types where org_id = $1",
        [tenant.orgId]
    );
    const got = new Map(rows.rows.map((r) => [r.key, r]));

    assert.equal(rows.rowCount, allDefinitions().length, "one row per definition, no more");

    for (const def of allDefinitions()) {
        const row = got.get(def.key);
        assert.ok(row, "provisioned " + def.key);
        assert.equal(row.name, def.name, def.key + " name");
        assert.equal(row.prefix, def.prefix, def.key + " prefix");
        assert.equal(row.clause, def.clause, def.key + " clause");
    }
});

test("each type's workflow states and transitions match its module", async () => {
    for (const def of allDefinitions()) {
        const wf = await workflowRows(tenant.orgId, def.key);
        assert.deepEqual(wf.states, def.states, def.key + " states");
        assert.deepEqual(wf.transitions, expectedTransitions(def), def.key + " transitions");
    }
});

test("each type's published form schema matches its module", async () => {
    for (const def of allDefinitions()) {
        const form = await query(`
            select fv.schema
              from form_versions fv
              join record_types rt on rt.id = fv.record_type_id
             where rt.org_id = $1 and rt.key = $2 and fv.published_at is not null
             order by fv.version desc
             limit 1
        `, [tenant.orgId, def.key]);

        assert.equal(form.rowCount, 1, def.key + " has a published form");
        assert.deepEqual(
            form.rows[0].schema,
            { fields: def.form.fields, rules: def.form.rules },
            def.key + " form schema"
        );
    }
});

/* ---- the seeded demo org: db/seed.sql + every migration ----
   This is the third source the modules must stay ahead of. A future
   migration that changes a workflow without matching change to
   src/record-definitions/ trips these. The seed org's forms are left
   alone on purpose - Ridgeline's are the richer demo variants. */

test("the seeded demo org is present (schema + seed + migrations ran)", async () => {
    const org = await query("select id from organizations where id = $1", [SEED_ORG]);
    assert.equal(org.rowCount, 1, "db/seed.sql's Ridgeline org must exist for the rest of this suite");
});

test("the seeded demo org carries every built-in type, metadata matching the modules", async () => {
    const rows = await query(
        "select key, name, prefix, clause from record_types where org_id = $1",
        [SEED_ORG]
    );
    const got = new Map(rows.rows.map((r) => [r.key, r]));

    for (const def of allDefinitions()) {
        const row = got.get(def.key);
        assert.ok(row, "seed org is missing built-in type " + def.key);
        assert.equal(row.name, def.name, def.key + " name (seed org)");
        assert.equal(row.prefix, def.prefix, def.key + " prefix (seed org)");
        assert.equal(row.clause, def.clause, def.key + " clause (seed org)");
    }
    /* Extra rows (control_plan, pfmea, ... from installed form
       templates) are legitimate user data and deliberately ignored. */
});

test("the seeded demo org's built-in workflows still match the modules", async () => {
    for (const def of allDefinitions()) {
        const wf = await workflowRows(SEED_ORG, def.key);
        assert.deepEqual(wf.states, def.states, def.key + " states (seed org)");
        assert.deepEqual(wf.transitions, expectedTransitions(def), def.key + " transitions (seed org)");
    }
});
