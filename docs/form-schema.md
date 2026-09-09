# Form schema conventions

Every record type is rendered from one JSON document, stored in
`form_versions.schema` and edited by the Form Builder or produced by the
Excel importer. There is no per-form code: one renderer
(`public/js/forms.js`), one detail/PDF/Excel formatter
(`public/js/format.js`), one server write pipeline
(`server/src/routes/records.js`).

```jsonc
{
  "fields": [ /* ordered; see below */ ],
  "rules":  [ /* optional; conditional requirements */ ]
}
```

`problemWith()` in `server/src/routes/masterdata.js` is the authority on
what is accepted — this doc describes what it means.

---

## Fields

Each field is `{ key, label, type, ... }`.

| key | rule |
|---|---|
| `key` | required, unique in the form, `^[A-Za-z0-9_]+$`. The property name under `records.data`. |
| `label` | required. Shown to the user; also the Excel column / PDF row heading. |
| `type` | required, one of the types below. |
| `section` | optional string. A new heading is drawn each time the value changes down the field list — there is no `sections[]` wrapper. |
| `required` | optional bool. Enforced server-side on create (`422 Required fields missing`). A `table` requires ≥1 row; a `file`/`signature` cannot block create. |

### Flat field types

| type | stored as | notes |
|---|---|---|
| `text` | string | `pattern` (regex) and `min`/`max` are enforced client-side and, since audit C1, coerced/validated server-side (report-only for now). |
| `memo` | string | multi-line. |
| `number` | number | `min`, `max`; **`thresholds: {warn?, crit?}`** paints the value amber/red once it crosses (audit L3). |
| `date` | `"YYYY-MM-DD"` string | formatted `01 Sep 2026` everywhere via `formatDateValue` — never `toLocaleDateString` (timezone-shifts a bare date). |
| `select` | string | needs `options: [string, …]`. A value not in `options` is a validation error. |
| `boolean` | `true` / absent | a checkbox; unticked stores nothing. Renders "Yes" / "No". |
| `link` | string | points at master data or another record — see **Link targets**. |
| `user` | initials string | a people picker; the form load supplies `options.users`. Valid as a **table column type** too (audit L1). |
| `signature` | sealed object | see **Signatures**. |
| `file` | — (nothing in `data`) | a field-scoped attachment slot: uploads are record attachments tagged `row_ref = "<key>:_"` (audit L2). |

### Link targets

`{ "type": "link", "target": "<target>" }`

| target | picker source |
|---|---|
| `parts`, `gages`, `lots` | the org's master data (`LINK_SOURCES` in `masterdata.js`) |
| `record` | any record in the org; add `"record_type": "risk"` to narrow it (audit M2). Options arrive keyed `record` or `record:<type>`. |

### Signatures (audit M6)

An unsigned `signature` field renders as a "Sign as me" checkbox. On save
the server replaces it with a sealed object:

```json
{ "signer": "...", "initials": "...", "role": "...",
  "at": "<ISO>", "form_version": 4,
  "data_hash": "<sha256 of the rest of the form>" }
```

An edit never re-signs it. `GET /api/records/:number` returns
`signatures: { <key>: { intact, note } }` — the detail view and PDF show
"unchanged since signing" or "record edited after signing".

---

## Table fields

```jsonc
{
  "key": "analysis", "label": "Analysis", "type": "table",
  "rowAttachments": true,          // optional: a per-row 📎 (audit — forms finalisation)
  "columns": [ { "key", "label", "type", ... } ]
}
```

Every table is dynamic (trailing blank row, "+5 rows", paste from Excel).
Rows carry a server-assigned `_id`; a per-row attachment is tagged
`row_ref = "<fieldKey>:<_id>"`.

**Column types:** `text`, `memo`, `number`, `date`, `select` (needs
`options`), `boolean`, `user`, `computed`.

### Computed columns

A read-only cell worked out from other **number** columns in the same row.
Two forms:

```jsonc
// fixed op
{ "type": "computed", "compute": "product" | "sum", "inputs": ["sev","occ","det"] }

// free expression (audit M1) — evaluated by public/js/expr.js on both tiers
{ "type": "computed", "expr": "tol - abs(actual - nominal)" }
```

Expression grammar: `+ - * / ( )`, unary `-`, identifiers = sibling column
keys, functions `sum avg min max abs round floor ceil`. Anything it cannot
work out (unknown ref, divide-by-zero, parse error) leaves the cell blank.
The **server** recomputes on every write — a stored value can never
disagree with its inputs.

Computed columns also take `thresholds: {warn?, crit?}`.

---

## Rules (audit L4)

```jsonc
"rules": [
  { "when": "disposition == 'Use-as-is'", "then": "require_approval", "role": "quality_manager" },
  { "when": "qty_affected > 500",          "then": "notify",           "role": "quality_manager" },
  { "when": "gage_cal_expired",            "then": "block_submit" },
  { "when": "disposition == 'Scrap'",      "then": "require_field",     "field": "reason" }
]
```

`when` is a small boolean expression over `records.data`
(`public/js/rules.js`):

- a bare ref — JS-truthy test; an unknown ref is falsy
- `ref == 'string'`, `ref != 'string'`, `ref > 500`, `>= <= <` on numbers
- `a && b`, `a || b`, `!a`, `( )`

A malformed `when` is treated as "did not match" — it never throws.

| `then` | effect on save |
|---|---|
| `block_submit` | 422, `rule_violations` |
| `require_field` (flat field empty) | 422, `rule_violations` |
| `require_field` (file/table field empty) | a `warnings` entry in the success response |
| `notify` | a notification to every active user in the org holding `role` |
| `require_approval` | `approvals_needed` on the create/update response and on `GET /:number` |

Rules currently only enter via a migration or the seed — the Form Builder
does not edit them yet, and `require_approval` surfaces the condition
without yet capturing a sign-off.

---

## Excel import

`server/src/routes/form-import.js` infers a schema from an uploaded
workbook: every non-instruction sheet becomes a `section`, a bold header
run of ≥3 columns becomes a table, label rows become flat fields, column
types are sampled from the body, and a `=A2*B2*C2` column becomes
`computed`. Each inferred field carries advisory `_confidence` (0–1) and
`_reason` for the review screen; both are stripped before publish. A
mapped column whose header has since moved is flagged loudly on
round-trip rather than read into the wrong field (audit M3).

The 8 real customer templates in `server/test/fixtures/templates/` are a
regression corpus — `form-import-fixtures.test.js` snapshots the inferred
shape so a detection change that degrades one of them fails CI.

---

## What is deliberately *not* here

- No `sections[]` wrapper — `section` is a string on each field.
- No `dynamicRows` flag — every table is dynamic.
- No drawn (canvas) signatures — typed identity + hash only.
- No per-form tables, routes, or HTML.
