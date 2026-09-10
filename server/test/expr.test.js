/* ============================================================
   The computed-column expression evaluator (audit P1 / M1).

   public/js/expr.js is the one safe evaluator the table editor
   (live recompute) and the server (authoritative recompute) share.
   No eval, no Function. These pin precedence, the function set, and
   the "can't compute -> undefined, never throw" contract.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluate, identifiers, parse } from "../../shared/expr.js";

const ev = (expr, scope) => evaluate(expr, scope);

test("arithmetic precedence and parentheses", () => {
    assert.equal(ev("2 + 3 * 4"), 14);
    assert.equal(ev("(2 + 3) * 4"), 20);
    assert.equal(ev("10 - 2 - 3"), 5);          // left associative
    assert.equal(ev("12 / 2 / 3"), 2);
    assert.equal(ev("-5 + 2"), -3);
    assert.equal(ev("-(4) * -2"), 8);
    assert.equal(ev("2.5 * 4"), 10);
});

test("column references resolve from the scope", () => {
    assert.equal(ev("sev * occ * det", { sev: 7, occ: 4, det: 3 }), 84);
    assert.equal(ev("actual - nominal", { actual: 12.7, nominal: 12.5 }), 12.7 - 12.5);
    assert.equal(ev("a + b", { a: "3", b: "4" }), 7, "numeric strings coerce");
});

test("whitelisted functions", () => {
    assert.equal(ev("sum(a, b, c)", { a: 1, b: 2, c: 3 }), 6);
    assert.equal(ev("max(a, b)", { a: 9, b: 4 }), 9);
    assert.equal(ev("min(a, b, 0)", { a: 9, b: 4 }), 0);
    assert.equal(ev("abs(x)", { x: -12 }), 12);
    assert.equal(ev("round(x, 2)", { x: 3.14159 }), 3.14);
    assert.equal(ev("round(x)", { x: 3.7 }), 4);
    assert.equal(ev("avg(a, b)", { a: 2, b: 8 }), 5);
});

test("uncomputable -> undefined, never a throw", () => {
    assert.equal(ev("a + b", { a: 1 }), undefined, "unbound reference");
    assert.equal(ev("a / 0", { a: 1 }), undefined, "division by zero");
    assert.equal(ev("bogus(1)", {}), undefined, "unknown function");
    assert.equal(ev("2 +", {}), undefined, "syntax error");
    assert.equal(ev("2 ; 3", {}), undefined, "illegal character");
    assert.equal(ev("", {}), undefined);
    assert.equal(ev("a", { a: "not a number" }), undefined);
    assert.equal(ev("a", { a: Infinity }), undefined);
    assert.equal(ev("x".repeat(600), {}), undefined, "over the length cap");
});

test("identifiers() lists every referenced column, once", () => {
    assert.deepEqual(identifiers("sev * occ * det").sort(), ["det", "occ", "sev"]);
    assert.deepEqual(identifiers("a + a + b").sort(), ["a", "b"]);
    assert.deepEqual(identifiers("sum(x, y) / 2").sort(), ["x", "y"]);
    assert.deepEqual(identifiers("42 * 2"), []);
    assert.throws(() => identifiers("1 +"), "a syntax error is a throw here, unlike evaluate()");
});

test("parse() is cached but returns an equivalent tree", () => {
    const a = parse("m * n");
    const b = parse("m * n");
    assert.equal(a, b, "same expression -> same cached AST");
    assert.equal(evaluate("m * n", { m: 6, n: 7 }), 42);
});
