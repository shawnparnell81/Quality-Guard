# Fill from Excel

_How a form fills a record from the customer's own spreadsheet, and how
a starter template ships that spreadsheet._

## The round trip

"Fill from Excel" on the Custom Forms screen posts an `.xlsx` to
`POST /api/records/excel?type=<key>`. The route (`server/src/routes/records.js`)
resolves a **cell map** for the form's published version and reads the
uploaded file through it:

```
loadTemplateFill(recordTypeId)          // records.js
  -> form_versions.excel_map.template_path set?
       yes -> readTemplate(buffer, map, schema)   // excel-fill.js
       no  -> readFormWorkbook(buffer, schema)    // the generic Field/Value grid
```

`readTemplate` returns `{ title, data, errors }`. The route rejects a
file that matched nothing (422, "needs the Excel template download for
…"), turns a still-empty required field into a warning, attaches the
uploaded file to the new record, and returns `{ number, warnings,
source_attached }`.

`GET /api/records/excel-template?type=<key>` serves the **blank**
template: the mapped customer file byte-for-byte when `excel_map` is set,
otherwise the generated grid.

## The cell map

`excel_map` is free-form jsonb on `form_versions`, shaped like the output
of `buildDefaultMap(workbook, schema)` (`server/src/excel-fill.js`) plus
three assigned fields:

```jsonc
{
  "template_path":  "excel-templates/…",   // in file storage
  "template_name":  "work_order_form.xlsx",
  "built_for_version": 1,                   // the schema version the map was made against
  "primary_sheet":  "Work Order Template",
  "sheets":         ["Work Order Template"],
  "fields": { "<fieldKey>": { "sheet": "…", "cell": "B5" } },
  "tables": {
    "<tableFieldKey>": {
      "sheet": "…",
      "first_data_row": 16,
      "columns": { "<colKey>": "A", … },
      "row_number_col": "A",          // optional: a column that just numbers rows
      "stop_on_blank_col": "A",       // optional: stop reading rows when this column is blank
      "capacity": 25
    }
  }
}
```

`mapProblem(map)` validates the structure; `reconcileMap(map, schema)`
reports fields the schema dropped and fields nothing maps to.

### buildDefaultMap heuristics worth knowing

- Flat fields: find a cell whose text matches the field label (`norm()`d),
  take the cell after its horizontal merge, else the next cell right.
- Tables: score a **two-row band** (row R and R+1 together) for column-label
  matches, so an AIAG split header — a merged "Characteristics" / "Methods"
  row above the real labels, with vertically-merged cells left only in the
  top row — resolves every column and anchors `first_data_row` correctly.
- `readTemplate` reads a formula cell's cached `result`; an unresolved
  formula (dead `'[1]OtherBook'!` link, `#REF!`) reads as blank, not the
  literal error text.
- `stop_on_blank_col` stops the row read at a blank key column, so a
  "Totals" line below the data — or a run of rows still carrying stale
  per-row formula results — is not read as a record row.

## Bundling a spreadsheet with a starter template

A starter template in `server/src/form-templates/<key>.json` MAY ship the
real spreadsheet it was derived from, as a pair:

```
server/src/form-templates/excel/<key>.xlsx        the customer's layout
server/src/form-templates/excel/<key>.map.json    the cell map (no template_path/name)
```

`form-templates/index.js` detects the pair, flags `has_excel_template` in
`listTemplates()`, and exposes `getTemplateExcel(key)`.

- **On install** (`POST /api/form-templates/:key/install`,
  `routes/form-templates.js`): after the record type + form v1 are
  committed, `attachBundledExcel` writes the xlsx to file storage and
  stamps `form_versions.excel_map` (guarded by `mapProblem`, best-effort —
  the form still works without a layout). Response gains `excel_template`.
- **After the fact** (`POST /api/record-types/:key/excel-template/from-starter`,
  `routes/masterdata.js`): a form installed *before* its starter shipped a
  spreadsheet adopts the bundled layout in one call. The Excel-layout
  dialog surfaces this as "Use the bundled layout" when
  `GET …/excel-map` returns `starter_available: true`.

### Building a `<key>.map.json`

1. Derive a draft schema with `inferWorkbook` (`routes/form-import.js`) and
   hand-correct labels / column names / select options so they match the
   sheet's own header text.
2. `buildDefaultMap(workbook, schema)` for a draft map; hand-fix
   column-name near-misses and any label collisions (e.g. a PFMEA with two
   "Severity" columns — pin the action-result one to its letter).
3. Clear the template's sample data / dead formulas so the download is a
   true blank form and freshly-filled rows read clean.
4. Round-trip a filled copy through `readTemplate` and confirm the
   extracted `data` matches, with no `errors`.
