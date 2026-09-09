/* ============================================================
   A tiny arithmetic evaluator for computed form columns.

   Grammar - no assignment, no comparison, no side effects:

     expr    := term  (('+' | '-') term)*
     term    := unary (('*' | '/') unary)*
     unary   := '-' unary | primary
     primary := number | ref | call | '(' expr ')'
     ref     := IDENT                       (a sibling column key)
     call    := IDENT '(' [expr (',' expr)*] ')'   (a whitelisted fn)

   Anything outside that - an unknown name, an unknown function, a
   syntax error, a division by zero, a non-finite result, or a scope
   value that is not a finite number - makes evaluate() return
   undefined. The caller treats that exactly like the old
   "inputs aren't all numbers yet" case: the computed cell is left
   blank until it can be worked out.

   Pure: no eval, no Function, no DOM, no Node. Imported by both
   public/js (live recompute in the table editor) and server/src
   (the authoritative recompute in applyComputedColumns).
   ============================================================ */

const FUNCS = {
    sum:   (...a) => a.reduce((x, y) => x + y, 0),
    avg:   (...a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN),
    min:   (...a) => Math.min(...a),
    max:   (...a) => Math.max(...a),
    abs:   (x) => Math.abs(x),
    round: (x, d = 0) => { const p = 10 ** d; return Math.round(x * p) / p; },
    floor: (x) => Math.floor(x),
    ceil:  (x) => Math.ceil(x)
};

const MAX_LEN = 500;

function tokenize(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
        if ("+-*/(),".indexOf(c) !== -1) { tokens.push({ t: c }); i++; continue; }
        if ((c >= "0" && c <= "9") || c === ".") {
            let j = i + 1;
            while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
            const num = Number(src.slice(i, j));
            if (!Number.isFinite(num)) throw new Error("bad number");
            tokens.push({ t: "num", v: num });
            i = j; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let j = i + 1;
            while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
            tokens.push({ t: "id", v: src.slice(i, j) });
            i = j; continue;
        }
        throw new Error("unexpected \"" + c + "\"");
    }
    return tokens;
}

function makeAst(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (t) => { const tk = next(); if (!tk || tk.t !== t) throw new Error("expected " + t); };

    function parseExpr() {
        let left = parseTerm();
        while (peek() && (peek().t === "+" || peek().t === "-")) {
            const op = next().t;
            left = { k: "bin", op, left, right: parseTerm() };
        }
        return left;
    }
    function parseTerm() {
        let left = parseUnary();
        while (peek() && (peek().t === "*" || peek().t === "/")) {
            const op = next().t;
            left = { k: "bin", op, left, right: parseUnary() };
        }
        return left;
    }
    function parseUnary() {
        if (peek() && peek().t === "-") { next(); return { k: "neg", arg: parseUnary() }; }
        return parsePrimary();
    }
    function parsePrimary() {
        const tk = next();
        if (!tk) throw new Error("unexpected end");
        if (tk.t === "num") return { k: "num", v: tk.v };
        if (tk.t === "(") { const e = parseExpr(); expect(")"); return e; }
        if (tk.t === "id") {
            if (peek() && peek().t === "(") {
                next();
                const args = [];
                if (peek() && peek().t !== ")") {
                    args.push(parseExpr());
                    while (peek() && peek().t === ",") { next(); args.push(parseExpr()); }
                }
                expect(")");
                return { k: "call", name: tk.v, args };
            }
            return { k: "ref", name: tk.v };
        }
        throw new Error("unexpected token");
    }

    const ast = parseExpr();
    if (pos !== tokens.length) throw new Error("trailing tokens");
    return ast;
}

/* Parsing the same handful of admin-authored expressions on every row
   of every table adds up; the distinct-expression count in a process
   is tiny, so cache, with a crude cap so a pathological number of
   form versions can't grow it without bound. */
const cache = new Map();

export function parse(expr) {
    if (typeof expr !== "string" || !expr.trim() || expr.length > MAX_LEN) {
        throw new Error("bad expression");
    }
    let ast = cache.get(expr);
    if (!ast) {
        ast = makeAst(tokenize(expr));
        if (cache.size > 500) cache.clear();
        cache.set(expr, ast);
    }
    return ast;
}

/* Every column key the expression references. Used to validate a
   computed column at save time and to build its "X = A x B" caption.
   Throws on a syntax error. */
export function identifiers(expr) {
    const seen = new Set();
    (function walk(n) {
        if (!n) return;
        if (n.k === "ref") seen.add(n.name);
        else if (n.k === "call") n.args.forEach(walk);
        else if (n.k === "bin") { walk(n.left); walk(n.right); }
        else if (n.k === "neg") walk(n.arg);
    })(parse(expr));
    return [...seen];
}

function evalNode(n, scope) {
    switch (n.k) {
        case "num": return n.v;
        case "ref": {
            const v = Number(scope[n.name]);
            if (!Number.isFinite(v)) throw new Error("unbound " + n.name);
            return v;
        }
        case "neg": return -evalNode(n.arg, scope);
        case "bin": {
            const a = evalNode(n.left, scope);
            const b = evalNode(n.right, scope);
            if (n.op === "+") return a + b;
            if (n.op === "-") return a - b;
            if (n.op === "*") return a * b;
            return b === 0 ? NaN : a / b;
        }
        case "call": {
            const fn = FUNCS[n.name];
            if (!fn) throw new Error("unknown function " + n.name);
            return fn(...n.args.map((a) => evalNode(a, scope)));
        }
        default: throw new Error("bad node");
    }
}

/* A finite number, or undefined when the expression can't be worked
   out against this scope. Never throws. */
export function evaluate(expr, scope) {
    try {
        const out = evalNode(parse(expr), scope || {});
        return Number.isFinite(out) ? out : undefined;
    } catch {
        return undefined;
    }
}
