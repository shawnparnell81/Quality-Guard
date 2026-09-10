/* ============================================================
   Shared form-engine modules: publish-time schema (including rules)
   and the unified record validator. No HTTP server.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { problemWith, problemWithSchema } from "../../shared/schema.js";
import { validateRecord } from "../../shared/validate.js";

const FIELDS = [
    { key: "part_no", label: "Part number", type: "text", required: true, pattern: "^P-[0-9]{4}$" },
    { key: "qty", label: "Quantity", type: "number", min: 1, max: 100 },
    { key: "grade", label: "Grade", type: "select", options: ["A", "B", "C"] }
];

test("problemWith still validates fields alone", () => {
    assert.equal(problemWith(FIELDS), null);
    assert.ok(problemWith([]));
    assert.ok(problemWith([{ key: "x", label: "X", type: "nope" }]));
});

test("problemWithSchema rejects a when that will not parse", () => {
    const problem = problemWithSchema({
        fields: FIELDS,
        rules: [{ when: "qty > (", then: "block_submit" }]
    });
    assert.ok(problem && /does not parse/.test(problem), problem);
});

test("problemWithSchema rejects an unknown then and a missing require_field", () => {
    assert.ok(problemWithSchema({
        fields: FIELDS,
        rules: [{ when: "qty > 1", then: "explode" }]
    }));
    assert.ok(problemWithSchema({
        fields: FIELDS,
        rules: [{ when: "qty > 1", then: "require_field", field: "nope" }]
    }));
});

test("problemWithSchema accepts a known rule set", () => {
    assert.equal(problemWithSchema({
        fields: FIELDS,
        rules: [
            { when: "qty > 50", then: "block_submit" },
            { when: "grade == 'C'", then: "require_field", field: "part_no" },
            { when: "qty > 80", then: "notify", role: "quality_manager" }
        ]
    }), null);
});

test("problemWithSchema skips rules when they are omitted (stored versions)", () => {
    assert.equal(problemWithSchema({ fields: FIELDS }), null);
});

test("validateRecord create: pattern / min / required / rules", () => {
    const schema = {
        fields: FIELDS,
        rules: [{ when: "qty > 50", then: "block_submit" }]
    };
    const bad = validateRecord(schema, { part_no: "nope", qty: 999, grade: "Z" }, { phase: "create" });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((p) => p.field === "part_no"));
    assert.ok(bad.problems.some((p) => p.field === "qty"));
    assert.ok(bad.problems.some((p) => p.field === "grade"));

    const missing = validateRecord(schema, { qty: 2, grade: "A" }, { phase: "create" });
    assert.deepEqual(missing.missing, ["part_no"]);

    const blocked = validateRecord(schema, { part_no: "P-1234", qty: 90, grade: "A" }, { phase: "create" });
    assert.ok(blocked.rule_violations.length > 0);

    const ok = validateRecord(schema, { part_no: "P-1234", qty: 10, grade: "B" }, { phase: "create" });
    assert.equal(ok.ok, true);
});

test("validateRecord update does not newly require emptied fields", () => {
    const schema = { fields: FIELDS, rules: [] };
    const prior = { part_no: "P-1234", qty: 10, grade: "B" };
    const patch = { qty: 8 };
    const result = validateRecord(schema, patch, { phase: "update", prior });
    assert.deepEqual(result.missing, []);
    assert.equal(result.ok, true);
});

test("validateRecord stub skips the lot", () => {
    const schema = { fields: FIELDS, rules: [{ when: "true", then: "block_submit" }] };
    const result = validateRecord(schema, {}, { phase: "stub" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.rule_violations, []);
});
