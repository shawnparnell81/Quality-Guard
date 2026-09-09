/* ============================================================
   Conditional form rules.

   A form version can carry a `rules` array:

     { when: "<condition>", then: "block_submit" }
     { when: "<condition>", then: "require_field",    field: "photos" }
     { when: "<condition>", then: "require_approval", role: "quality_manager" }
     { when: "<condition>", then: "notify",           role: "quality_manager" }

   `when` is a small boolean expression over the record's data:

     gage_cal_expired                 a bare ref - JS-truthy test
     disposition == 'Use-as-is'       == != on a ref vs a 'string'
     qty_affected > 500               > >= < <= on numbers
     a && b       a || b      !a      ( )

   An unknown ref is falsy, so a rule about a field nobody filled in
   just does not fire. Nothing here throws - a `when` that will not
   parse is treated as "did not match".

   Pure: no DOM, no Node. Imported by the record editor (instant
   feedback) and the server write path (authoritative). Enforcement of
   the result lives with each caller - see checkRules() below.
   ============================================================ */

const FLAT_TYPES = new Set(["text", "memo", "number", "date", "select", "link", "user", "boolean"]);
const RULE_THENS = new Set(["block_submit", "require_field", "require_approval", "notify"]);

/* ---------- the tiny condition evaluator ---------- */

function tokenizeCond(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }

        const two = src.slice(i, i + 2);
        if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { tokens.push({ t: two }); i += 2; continue; }
        if ("()<>!".indexOf(c) !== -1) { tokens.push({ t: c }); i++; continue; }

        if (c === "'" || c === "\"") {
            let j = i + 1;
            while (j < src.length && src[j] !== c) j++;
            tokens.push({ t: "str", v: src.slice(i + 1, j) });
            i = j + 1; continue;
        }
        if ((c >= "0" && c <= "9") || c === ".") {
            let j = i + 1;
            while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
            tokens.push({ t: "num", v: Number(src.slice(i, j)) });
            i = j; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
            tokens.push({ t: "id", v: src.slice(i, j) });
            i = j; continue;
        }
        throw new Error("unexpected \"" + c + "\" in condition");
    }
    return tokens;
}

function parseCond(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (t) => { const tk = next(); if (!tk || tk.t !== t) throw new Error("expected " + t); };

    function parseOr() {
        let left = parseAnd();
        while (peek() && peek().t === "||") { next(); left = { k: "or", left, right: parseAnd() }; }
        return left;
    }
    function parseAnd() {
        let left = parseNot();
        while (peek() && peek().t === "&&") { next(); left = { k: "and", left, right: parseNot() }; }
        return left;
    }
    function parseNot() {
        if (peek() && peek().t === "!") { next(); return { k: "not", arg: parseNot() }; }
        return parseCmp();
    }
    function parseCmp() {
        const left = parseAtom();
        const op = peek() && ["==", "!=", "<", "<=", ">", ">="].includes(peek().t) ? next().t : null;
        if (!op) return left;
        return { k: "cmp", op, left, right: parseAtom() };
    }
    function parseAtom() {
        const tk = next();
        if (!tk) throw new Error("unexpected end of condition");
        if (tk.t === "(") { const e = parseOr(); expect(")"); return e; }
        if (tk.t === "num") return { k: "num", v: tk.v };
        if (tk.t === "str") return { k: "str", v: tk.v };
        if (tk.t === "id") {
            if (tk.v === "true") return { k: "num", v: 1 };
            if (tk.v === "false") return { k: "num", v: 0 };
            return { k: "ref", name: tk.v };
        }
        throw new Error("unexpected token in condition");
    }

    const ast = parseOr();
    if (pos !== tokens.length) throw new Error("trailing tokens in condition");
    return ast;
}

const condCache = new Map();
function condAst(when) {
    let ast = condCache.get(when);
    if (!ast) {
        ast = parseCond(tokenizeCond(when));
        if (condCache.size > 500) condCache.clear();
        condCache.set(when, ast);
    }
    return ast;
}

function refValue(name, data) {
    return data && Object.prototype.hasOwnProperty.call(data, name) ? data[name] : undefined;
}

function compare(op, a, b) {
    const na = Number(a), nb = Number(b);
    const numeric = a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb);
    if (op === "==") return numeric ? na === nb : String(a) === String(b);
    if (op === "!=") return numeric ? na !== nb : String(a) !== String(b);
    if (!numeric) return false;                 // <,<=,>,>= need numbers
    if (op === "<") return na < nb;
    if (op === "<=") return na <= nb;
    if (op === ">") return na > nb;
    return na >= nb;                             // >=
}

function evalNode(n, data) {
    switch (n.k) {
        case "num": return n.v;
        case "str": return n.v;
        case "ref": return refValue(n.name, data);
        case "not": return !truthy(evalNode(n.arg, data));
        case "and": return truthy(evalNode(n.left, data)) && truthy(evalNode(n.right, data));
        case "or": return truthy(evalNode(n.left, data)) || truthy(evalNode(n.right, data));
        case "cmp": return compare(n.op, evalNode(n.left, data), evalNode(n.right, data));
        default: return false;
    }
}

function truthy(v) {
    if (v === undefined || v === null || v === false) return false;
    if (v === 0 || v === "" || v === "0" || v === "false") return false;
    if (Array.isArray(v)) return v.length > 0;
    return true;
}

/* Whether a rule's `when` matches the record's data right now. */
export function evalWhen(when, data) {
    if (typeof when !== "string" || !when.trim()) return false;
    try { return truthy(evalNode(condAst(when), data || {})); }
    catch { return false; }
}

/* ---------- applying the rules ---------- */

function isEmptyValue(v) {
    return v === undefined || v === null || v === ""
        || (Array.isArray(v) && v.length === 0);
}

/* Run every rule whose `when` currently matches and sort the results:
     blocked   - messages that must stop a save (422)
     warnings  - things to finish after saving (a required file/table)
     notify    - { role, message } to push a notification for
     approvals - { role, message } this record now needs signed off
   Callers enforce these; this function only decides. */
export function checkRules(schema, data) {
    const rules = (schema && Array.isArray(schema.rules)) ? schema.rules : [];
    const fields = new Map(((schema && schema.fields) || []).map((f) => [f.key, f]));
    const out = { blocked: [], warnings: [], notify: [], approvals: [] };

    for (const rule of rules) {
        if (!rule || typeof rule !== "object" || !RULE_THENS.has(rule.then)) continue;
        if (!evalWhen(rule.when, data)) continue;

        if (rule.then === "block_submit") {
            out.blocked.push("This record cannot be saved while " + rule.when + ".");
        } else if (rule.then === "require_field") {
            const f = fields.get(rule.field);
            if (isEmptyValue(data && data[rule.field])) {
                const name = f ? (f.label || rule.field) : rule.field;
                const msg = "\"" + name + "\" is required when " + rule.when + ".";
                if (f && FLAT_TYPES.has(f.type)) out.blocked.push(msg);
                else out.warnings.push(msg + " Add it to the record after saving.");
            }
        } else if (rule.then === "notify") {
            out.notify.push({ role: rule.role || null, message: "Rule matched: " + rule.when });
        } else if (rule.then === "require_approval") {
            out.approvals.push({
                role: rule.role || null,
                message: (rule.role ? rule.role.replace(/_/g, " ") + " approval" : "Approval")
                    + " needed - " + rule.when
            });
        }
    }
    return out;
}
