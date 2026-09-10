/* ============================================================
   Record payload vs form schema.

   One function the write path, Floor Report, the record editor and
   live-form all call, so a select / min / pattern / rule check cannot
   drift between tiers. Pure: no DOM, no Node.

   phase "create" enforces required fields. phase "update" does not
   newly require emptied fields - matching PATCH /api/records/:number,
   which never ran a required-field scan. phase "stub" skips the lot
   so automation-raised incomplete rows stay unvalidated.
   ============================================================ */

import { checkRules } from "./rules.js";

export const FLAT_FIELD_TYPES = new Set([
    "text", "memo", "number", "date", "select", "link", "user", "boolean"
]);

/* Spreadsheet spellings of a ticked / unticked box. Everything else
   in a boolean cell is an error the importer surfaces for review. */
const BOOL_TRUE = new Set(["true", "yes", "y", "1", "x", "✓", "checked", "on"]);
const BOOL_FALSE = new Set(["false", "no", "n", "0", "-", "unchecked", "off"]);

const normalizeHeader = (s) => String(s || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");

/* Turn one spreadsheet cell (or a JSON write) into the value a form
   field expects. exceljs hands back Date / rich-text / formula
   objects; those branches stay here so import and live writes share
   one coercer. */
export function coerceCell(field, raw) {
    if (raw === null || raw === undefined || raw === "") return undefined;
    if (typeof raw === "object") {
        if (raw instanceof Date) raw = raw.toISOString();
        else if (raw.text !== undefined) raw = raw.text;
        else if (raw.result !== undefined) raw = raw.result;
        else raw = String(raw);
    }
    if (field.type === "boolean") {
        if (typeof raw === "boolean") return raw;
        const t = String(raw).trim().toLowerCase();
        if (BOOL_TRUE.has(t)) return true;
        if (BOOL_FALSE.has(t)) return false;
        return { __error: "not yes/no" };
    }
    if (field.type === "number") {
        const n = Number(raw);
        return Number.isFinite(n) ? n : { __error: "not a number" };
    }
    if (field.type === "date") {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? { __error: "not a date" } : d.toISOString().slice(0, 10);
    }
    const text = String(raw).trim();
    if (field.type === "select" && Array.isArray(field.options) && field.options.length) {
        const hit = field.options.find((o) => normalizeHeader(o) === normalizeHeader(text));
        return hit !== undefined ? hit : { __error: "not one of: " + field.options.join(", ") };
    }
    return text;
}

/* An admin authors a field's "pattern"; it is not arbitrary input.
   But a malformed one must not throw on every write - a bad pattern
   means "cannot judge this", so it passes. */
function safeRegexTest(pattern, value) {
    try { return new RegExp(pattern).test(value); }
    catch { return true; }
}

/* Walk a whole record payload against its published form version and
   collect every value the schema cannot accept, as
   { field, row?, column?, value, error }. Computed columns are skipped
   - they are server-derived, not sent by the caller. */
export function validateAgainstSchema(schema, data) {
    const fields = schema && Array.isArray(schema.fields) ? schema.fields : [];
    if (!data || typeof data !== "object" || fields.length === 0) return [];

    const problems = [];

    for (const field of fields) {
        if (field.type === "table") {
            if (!Array.isArray(field.columns)) continue;
            const rows = Array.isArray(data[field.key]) ? data[field.key] : null;
            if (!rows) continue;
            const cols = field.columns.filter((c) => c && c.type && c.type !== "computed");
            rows.forEach((row, index) => {
                if (!row || typeof row !== "object" || Array.isArray(row)) return;
                for (const col of cols) {
                    const result = coerceCell(col, row[col.key]);
                    if (result && typeof result === "object" && result.__error) {
                        problems.push({
                            field: field.key, row: index, column: col.key,
                            value: row[col.key], error: result.__error
                        });
                    }
                }
            });
            continue;
        }

        if (!FLAT_FIELD_TYPES.has(field.type)) continue;

        const raw = data[field.key];
        const result = coerceCell(field, raw);
        if (result && typeof result === "object" && result.__error) {
            problems.push({ field: field.key, value: raw, error: result.__error });
            continue;
        }
        if (result === undefined) continue;

        if (field.pattern && !safeRegexTest(field.pattern, String(result))) {
            problems.push({ field: field.key, value: raw, error: "does not match " + field.pattern });
        }
        if (field.min !== undefined && Number(result) < field.min) {
            problems.push({ field: field.key, value: raw, error: "below minimum " + field.min });
        }
        if (field.max !== undefined && Number(result) > field.max) {
            problems.push({ field: field.key, value: raw, error: "above maximum " + field.max });
        }
    }

    return problems;
}

/* Keep only the problems a PATCH actually introduces - where the
   incoming value for that field differs from what the record already
   holds. A bad value already living in the record (options changed,
   an old import) is left alone so its owner can still edit the rest.
   For a table, any change to the array re-validates the whole thing;
   an untouched table is skipped wholesale. */
export function introducedProblems(problems, incoming, prior) {
    const changedTable = new Map();
    const isChangedTable = (key) => {
        if (!changedTable.has(key)) {
            changedTable.set(key,
                JSON.stringify(incoming?.[key]) !== JSON.stringify(prior?.[key]));
        }
        return changedTable.get(key);
    };
    return problems.filter((p) => {
        if (p.column !== undefined) return isChangedTable(p.field);
        return JSON.stringify(incoming?.[p.field]) !== JSON.stringify(prior?.[p.field]);
    });
}

function requiredMissing(schema, data) {
    return (schema && Array.isArray(schema.fields) ? schema.fields : [])
        .filter((field) => {
            if (!field.required) return false;
            const value = data ? data[field.key] : undefined;
            if (field.type === "table") return !Array.isArray(value) || value.length === 0;
            return value === undefined;
        })
        .map((field) => field.key);
}

export function validateRecord(schema, data, { phase = "create", prior = null } = {}) {
    if (phase === "stub") {
        return {
            ok: true,
            problems: [],
            missing: [],
            rule_violations: [],
            warnings: [],
            notify: [],
            approvals: []
        };
    }

    const rawProblems = validateAgainstSchema(schema, data);
    const problems = phase === "update" && prior
        ? introducedProblems(rawProblems, data, prior)
        : rawProblems;

    const missing = phase === "create" ? requiredMissing(schema, data) : [];
    const rules = checkRules(schema, data);

    return {
        ok: problems.length === 0 && missing.length === 0 && rules.blocked.length === 0,
        problems,
        missing,
        rule_violations: rules.blocked,
        warnings: rules.warnings,
        notify: rules.notify,
        approvals: rules.approvals
    };
}
