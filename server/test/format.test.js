/* ============================================================
   The shared schema->value formatter (audit P1 / H2).

   public/js/format.js is imported by the record detail screen, the
   PDF export and the Excel export so all three agree on what a
   checkbox, a date or a linked user looks like. These pin the rules
   that had drifted between the three private copies.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatValue, formatDateValue, isEmpty } from "../../public/js/format.js";

test("isEmpty: null / undefined / empty string / empty array only", () => {
    for (const v of [null, undefined, "", []]) assert.equal(isEmpty(v), true, JSON.stringify(v));
    for (const v of [0, false, "0", " ", [0], {}]) assert.equal(isEmpty(v), false, JSON.stringify(v));
});

test("empty renders as opts.empty (default '')", () => {
    assert.equal(formatValue({ type: "text" }, null), "");
    assert.equal(formatValue({ type: "text" }, "", { empty: "-" }), "-");
    assert.equal(formatValue({ type: "boolean" }, undefined, { empty: "-" }), "-");
});

test("boolean: every spreadsheet / stale spelling of true and false", () => {
    for (const v of [true, 1, "1", "true", "TRUE", " yes ", "Y", "x", "on", "checked"]) {
        assert.equal(formatValue({ type: "boolean" }, v), "Yes", JSON.stringify(v));
    }
    for (const v of [false, 0, "0", "false", "no", "n", "anything else"]) {
        assert.equal(formatValue({ type: "boolean" }, v), "No", JSON.stringify(v));
    }
});

test("date: bare ISO formats without a timezone or locale in the path", () => {
    assert.equal(formatDateValue("2026-09-01"), "01 Sep 2026");
    assert.equal(formatDateValue("2026-01-31T14:00:00Z"), "31 Jan 2026");
    assert.equal(formatValue({ type: "date" }, "2026-12-25"), "25 Dec 2026");
    /* not a date - fall back to the raw string, never "Invalid Date" */
    assert.equal(formatValue({ type: "date" }, "soon"), "soon");
});

test("date: spreadsheet mode keeps the native value for cell typing", () => {
    assert.equal(formatValue({ type: "date" }, "2026-09-01", { spreadsheet: true }), "2026-09-01");
});

test("user: resolves against a Map or a plain object, else shows the code", () => {
    const asMap = new Map([["MO", "Morgan Ochoa"]]);
    assert.equal(formatValue({ type: "user" }, "MO", { users: asMap }), "Morgan Ochoa (MO)");
    assert.equal(formatValue({ type: "user" }, "MO", { users: { MO: "Morgan Ochoa" } }), "Morgan Ochoa (MO)");
    assert.equal(formatValue({ type: "user" }, "ZZ", { users: asMap }), "ZZ");
    assert.equal(formatValue({ type: "user" }, "ZZ"), "ZZ");
});

test("number: string by default, native in spreadsheet mode", () => {
    assert.equal(formatValue({ type: "number" }, 12.719), "12.719");
    assert.equal(formatValue({ type: "number" }, 12.719, { spreadsheet: true }), 12.719);
    /* a numeric value under any field type stays native in a sheet */
    assert.equal(formatValue({ type: "text" }, 42, { spreadsheet: true }), 42);
});

test("objects and arrays JSON-stringify rather than '[object Object]'", () => {
    assert.equal(formatValue(null, { a: 1 }), '{"a":1}');
    assert.equal(formatValue({ type: "text" }, [1, 2]), "[1,2]");
});

test("plain text passes through; a null field is tolerated", () => {
    assert.equal(formatValue({ type: "text" }, "Rework"), "Rework");
    assert.equal(formatValue(null, "legacy value"), "legacy value");
    assert.equal(formatValue({ type: "select" }, "Scrap"), "Scrap");
});
