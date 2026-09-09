/* ============================================================
   Conditional form rules (audit P3 / L4).

   public/js/rules.js evaluates a form version's `rules` array on
   save. These pin the condition evaluator and how each `then` is
   sorted into block / warn / notify / approval.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evalWhen, checkRules } from "../../public/js/rules.js";

test("evalWhen: a bare ref is a truthiness test", () => {
    assert.equal(evalWhen("gage_cal_expired", { gage_cal_expired: true }), true);
    assert.equal(evalWhen("gage_cal_expired", { gage_cal_expired: false }), false);
    assert.equal(evalWhen("gage_cal_expired", {}), false, "unknown ref is falsy");
});

test("evalWhen: == and != against a string", () => {
    assert.equal(evalWhen("disposition == 'Use-as-is'", { disposition: "Use-as-is" }), true);
    assert.equal(evalWhen("disposition == 'Use-as-is'", { disposition: "Rework" }), false);
    assert.equal(evalWhen("disposition != 'Scrap'", { disposition: "Rework" }), true);
});

test("evalWhen: numeric comparisons", () => {
    assert.equal(evalWhen("qty_affected > 500", { qty_affected: 600 }), true);
    assert.equal(evalWhen("qty_affected > 500", { qty_affected: 500 }), false);
    assert.equal(evalWhen("qty_affected >= 500", { qty_affected: 500 }), true);
    assert.equal(evalWhen("n <= 3", { n: "2" }), true, "numeric strings coerce");
});

test("evalWhen: && || ! and parens", () => {
    const d = { a: 1, b: 0, s: "x" };
    assert.equal(evalWhen("a && !b", d), true);
    assert.equal(evalWhen("b || s == 'x'", d), true);
    assert.equal(evalWhen("(a && b) || s == 'x'", d), true);
    assert.equal(evalWhen("a && b", d), false);
});

test("evalWhen: a malformed condition is 'did not match', never a throw", () => {
    assert.equal(evalWhen("disposition ==", { disposition: "x" }), false);
    assert.equal(evalWhen("&& a", {}), false);
    assert.equal(evalWhen("", {}), false);
    assert.equal(evalWhen(null, {}), false);
});

const SCHEMA = {
    fields: [
        { key: "disposition", label: "Disposition", type: "select", options: ["Rework", "Scrap", "Use-as-is"] },
        { key: "qty_affected", label: "Quantity affected", type: "number" },
        { key: "reason", label: "Reason", type: "memo" },
        { key: "photos", label: "Photo evidence", type: "file" }
    ],
    rules: [
        { when: "disposition == 'Use-as-is'", then: "require_approval", role: "quality_manager" },
        { when: "qty_affected > 500", then: "notify", role: "quality_manager" },
        { when: "gage_cal_expired", then: "block_submit" },
        { when: "disposition == 'Scrap'", then: "require_field", field: "reason" },
        { when: "disposition == 'Scrap'", then: "require_field", field: "photos" }
    ]
};

test("checkRules: block_submit fires only when its condition holds", () => {
    assert.deepEqual(checkRules(SCHEMA, { disposition: "Rework" }).blocked, []);
    assert.deepEqual(checkRules(SCHEMA, { gage_cal_expired: true }).blocked,
        ["This record cannot be saved while gage_cal_expired."]);
});

test("checkRules: require_field blocks on a flat field, warns on a file field", () => {
    const r = checkRules(SCHEMA, { disposition: "Scrap" });
    assert.ok(r.blocked.some((m) => /"Reason" is required/.test(m)), "flat field -> blocked");
    assert.ok(r.warnings.some((m) => /"Photo evidence" is required/.test(m)), "file field -> warning");

    const ok = checkRules(SCHEMA, { disposition: "Scrap", reason: "MRB decision" });
    assert.deepEqual(ok.blocked, [], "filled -> no block");
});

test("checkRules: notify and require_approval are collected with their role", () => {
    const r = checkRules(SCHEMA, { disposition: "Use-as-is", qty_affected: 900 });
    assert.deepEqual(r.notify, [{ role: "quality_manager", message: "Rule matched: qty_affected > 500" }]);
    assert.equal(r.approvals.length, 1);
    assert.equal(r.approvals[0].role, "quality_manager");
    assert.match(r.approvals[0].message, /quality manager approval/);
});

test("checkRules: no rules array -> everything empty", () => {
    const r = checkRules({ fields: [] }, { anything: 1 });
    assert.deepEqual(r, { blocked: [], warnings: [], notify: [], approvals: [] });
});
