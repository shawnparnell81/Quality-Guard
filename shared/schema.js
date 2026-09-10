/* ============================================================
   Form schema meta-validation.

   Structural soundness of a field list (and, on a new publish, of
   its rules). Pure: no DOM, no Node, no SQL. Master-data routes
   import this; LINK_SOURCES stay in masterdata.js because they are
   queries, not schema.
   ============================================================ */

import { identifiers as exprIdentifiers } from "./expr.js";
import { parseWhen, RULE_THENS } from "./rules.js";

export const FIELD_TYPES = new Set([
    "text", "memo", "number", "date", "select", "link", "file", "signature", "user", "table", "boolean"
]);

/* Size caps on a published schema (audit M7). problemWith already
   proves a schema is structurally sound; these stop a pathological
   one - 300 columns, 5000 options, a novel-length label - from
   becoming the form every future record of the type renders. Chosen
   well above any real quality form (a big PFMEA is ~25 columns, a
   long disposition list ~15 options) and well below what would choke
   the renderer. */
export const SCHEMA_LIMITS = {
    fields: 250,
    tableColumns: 80,
    options: 500,
    keyChars: 100,
    labelChars: 300,
    sectionChars: 200,
    exprChars: 1000
};

/* A table field's columns can only be scalars - a repeating grid of
   grids is not something any real QMS form needs and not something
   the renderer supports. "computed" is a read-only cell worked out
   from other number columns in the same row. "boolean" is a checkbox
   cell, stored as true / false. "user" is a person picker, stored as
   initials (same as a flat user field). "expr" is accepted on a
   computed column as its expression string, not as a column type. */
export const TABLE_COLUMN_TYPES = new Set([
    "text", "memo", "number", "date", "select", "computed", "boolean", "user"
]);

export const LINK_TARGETS = new Set(["parts", "gages", "lots"]);

const COMPUTE_OPS = new Set(["product", "sum"]);
const RULE_KEYS = new Set(["when", "then", "field", "role"]);

function tooLong(what, value, cap) {
    return typeof value === "string" && value.length > cap
        ? what + " is too long (" + value.length + " chars, limit " + cap + ")"
        : null;
}

/* thresholds:{warn?,crit?} paints a number amber / red once it crosses
   them. Allowed on any "number" or "computed" field or column. */
function thresholdProblem(label, t) {
    if (t === undefined) return null;
    if (!t || typeof t !== "object" || Array.isArray(t)) return "\"" + label + "\" has bad thresholds";
    for (const key of ["warn", "crit"]) {
        if (t[key] !== undefined && typeof t[key] !== "number") {
            return "\"" + label + "\" threshold \"" + key + "\" must be a number";
        }
    }
    return null;
}

function tableProblem(field) {
    if (!Array.isArray(field.columns) || field.columns.length === 0) {
        return "\"" + field.label + "\" needs at least one column";
    }
    if (field.columns.length > SCHEMA_LIMITS.tableColumns) {
        return "\"" + field.label + "\" has too many columns ("
            + field.columns.length + ", limit " + SCHEMA_LIMITS.tableColumns + ")";
    }
    if (field.rowAttachments !== undefined && typeof field.rowAttachments !== "boolean") {
        return "\"" + field.label + "\"'s rowAttachments must be true or false";
    }
    const seen = new Set();
    const byKey = new Map();
    for (const col of field.columns) {
        if (!col || typeof col !== "object") return "\"" + field.label + "\" has a bad column";
        if (!col.key || typeof col.key !== "string") return "\"" + field.label + "\" has a column with no key";
        if (!col.label || typeof col.label !== "string") return "\"" + field.label + "\" has a column with no label";
        const clk = tooLong("Column key \"" + col.key + "\"", col.key, SCHEMA_LIMITS.keyChars)
            || tooLong("Column label \"" + col.label + "\"", col.label, SCHEMA_LIMITS.labelChars);
        if (clk) return clk;
        if (!TABLE_COLUMN_TYPES.has(col.type)) {
            return "\"" + field.label + "\" column \"" + col.label + "\" has an unusable type";
        }
        if (seen.has(col.key)) return "\"" + field.label + "\" has two columns keyed \"" + col.key + "\"";
        seen.add(col.key);
        byKey.set(col.key, col);
        if (col.type === "select" && (!Array.isArray(col.options) || col.options.length === 0)) {
            return "\"" + field.label + "\" column \"" + col.label + "\" needs options";
        }
        if (Array.isArray(col.options) && col.options.length > SCHEMA_LIMITS.options) {
            return "\"" + field.label + "\" column \"" + col.label + "\" has too many options ("
                + col.options.length + ", limit " + SCHEMA_LIMITS.options + ")";
        }
        if (typeof col.expr === "string" && col.expr.length > SCHEMA_LIMITS.exprChars) {
            return "\"" + field.label + "\" column \"" + col.label + "\" has an over-long expression";
        }
        if (col.thresholds !== undefined && col.type !== "number" && col.type !== "computed") {
            return "\"" + field.label + "\" column \"" + col.label + "\" can only carry thresholds on a number or computed column";
        }
        const tp = thresholdProblem(field.label + " column \"" + col.label + "\"", col.thresholds);
        if (tp) return tp;
    }

    /* A second pass: a computed column can only be checked once every
       column it might reference is known. It is defined EITHER by a
       free expression (expr) OR by a fixed op (compute + inputs). */
    for (const col of field.columns) {
        if (col.type !== "computed") continue;

        const hasExpr = typeof col.expr === "string" && col.expr.trim() !== "";
        let refs;

        if (hasExpr) {
            try {
                refs = exprIdentifiers(col.expr);
            } catch {
                return "\"" + field.label + "\" column \"" + col.label + "\" has an expression that does not parse";
            }
        } else {
            if (!COMPUTE_OPS.has(col.compute)) {
                return "\"" + field.label + "\" column \"" + col.label + "\" needs an expression, or a compute of \"product\" or \"sum\"";
            }
            if (!Array.isArray(col.inputs) || col.inputs.length === 0) {
                return "\"" + field.label + "\" column \"" + col.label + "\" needs at least one input column";
            }
            refs = col.inputs;
        }

        for (const key of refs) {
            if (key === col.key) return "\"" + field.label + "\" column \"" + col.label + "\" cannot compute from itself";
            const src = byKey.get(key);
            if (!src) {
                return "\"" + field.label + "\" column \"" + col.label + "\" "
                    + (hasExpr ? "expression refers to" : "refers to") + " a missing column \"" + key + "\"";
            }
            if (src.type !== "number") {
                return "\"" + field.label + "\" column \"" + col.label + "\" can only compute from number columns";
            }
        }
    }
    return null;
}

function rulesProblem(rules, fieldKeys) {
    if (!Array.isArray(rules)) return "rules must be an array";

    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const where = "Rule " + (i + 1);
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            return where + " must be an object";
        }
        for (const key of Object.keys(rule)) {
            if (!RULE_KEYS.has(key)) return where + " has unknown key \"" + key + "\"";
        }
        if (typeof rule.when !== "string" || !rule.when.trim()) {
            return where + " needs a when condition";
        }
        try {
            parseWhen(rule.when);
        } catch {
            return where + " when \"" + rule.when + "\" does not parse";
        }
        if (!RULE_THENS.has(rule.then)) {
            return where + " has unknown action"
                + (rule.then !== undefined ? ": " + rule.then : "");
        }
        if (rule.then === "require_field") {
            if (typeof rule.field !== "string" || !rule.field) {
                return where + " require_field needs a field key";
            }
            if (!fieldKeys.has(rule.field)) {
                return where + " require_field names unknown field \"" + rule.field + "\"";
            }
        }
        if (rule.then === "notify" || rule.then === "require_approval") {
            if (typeof rule.role !== "string" || !rule.role.trim()) {
                return where + " " + rule.then + " needs a role";
            }
        }
    }
    return null;
}

/* Never trust the client's own validation. The in-app editor already
   checks all of this before it ever sends a request, but the field
   list is exactly the shape every screen in the app renders forms
   from, so a bad one here breaks every future record of this type,
   not just the request that sent it. Structural soundness AND size
   (SCHEMA_LIMITS, audit M7) - a schema that parses but is
   pathologically large is still rejected. */
export function problemWith(fields) {
    return problemWithSchema({ fields });
}

/* Fields always; rules only when the caller passes them. Existing
   stored form_versions are not re-validated - this runs on a new
   publish / import / template install. */
export function problemWithSchema({ fields, rules } = {}) {
    if (!Array.isArray(fields) || fields.length === 0) {
        return "At least one field is required";
    }
    if (fields.length > SCHEMA_LIMITS.fields) {
        return "Too many fields (" + fields.length + ", limit " + SCHEMA_LIMITS.fields + ")";
    }

    const seenKeys = new Set();

    for (const field of fields) {
        if (!field || typeof field !== "object") return "Every field must be an object";
        if (!field.key || typeof field.key !== "string") return "Every field needs a key";
        if (!field.label || typeof field.label !== "string") return "Every field needs a label";
        if (!FIELD_TYPES.has(field.type)) return "Unknown field type: " + field.type;
        const flk = tooLong("Field key \"" + field.key + "\"", field.key, SCHEMA_LIMITS.keyChars)
            || tooLong("Field label \"" + field.label + "\"", field.label, SCHEMA_LIMITS.labelChars)
            || tooLong("\"" + field.label + "\"'s section", field.section, SCHEMA_LIMITS.sectionChars);
        if (flk) return flk;
        if (field.section !== undefined && typeof field.section !== "string") {
            return "\"" + field.label + "\"'s section must be text";
        }

        if (seenKeys.has(field.key)) return "Two fields share the key \"" + field.key + "\"";
        seenKeys.add(field.key);

        if (field.type === "select" && (!Array.isArray(field.options) || field.options.length === 0)) {
            return "\"" + field.label + "\" needs at least one option";
        }
        if (Array.isArray(field.options) && field.options.length > SCHEMA_LIMITS.options) {
            return "\"" + field.label + "\" has too many options ("
                + field.options.length + ", limit " + SCHEMA_LIMITS.options + ")";
        }
        if (field.thresholds !== undefined && field.type !== "number") {
            return "\"" + field.label + "\" can only carry thresholds on a number field";
        }
        const ftp = thresholdProblem(field.label, field.thresholds);
        if (ftp) return ftp;
        if (field.type === "link" && field.target !== "record" && !LINK_TARGETS.has(field.target)) {
            return "\"" + field.label + "\" needs a valid link target";
        }
        if (field.type === "link" && field.target === "record"
            && field.record_type !== undefined && typeof field.record_type !== "string") {
            return "\"" + field.label + "\"'s record_type filter must be a type key";
        }
        if (field.type === "table") {
            const bad = tableProblem(field);
            if (bad) return bad;
        }
    }

    if (rules !== undefined && rules !== null) {
        const badRules = rulesProblem(rules, seenKeys);
        if (badRules) return badRules;
    }

    return null;
}
