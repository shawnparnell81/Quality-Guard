-- ============================================================
-- "Fill my Excel template" - keep the customer's own layout.
--
-- A form version can carry an excel_map: which cell each field
-- writes to, and where each table's grid starts, in a stored copy of
-- the spreadsheet the form was imported from. When present, the
-- record's Excel export and blank template are that file with the
-- values dropped into place, instead of the generic Field / Value
-- sheet the engine builds from scratch.
--
-- Null for every form built in the Form Builder or from a bundled
-- starter - those keep the generated grid. Shape (all keys optional
-- except template_path):
--   {
--     "template_path": "excel-templates/<uuid>.xlsx",
--     "primary_sheet": "Control Plan",
--     "fields":  { "<fieldKey>": { "sheet": "...", "cell": "C3" } },
--     "tables":  { "<fieldKey>": { "sheet": "...", "first_data_row": 9,
--                                  "row_number_col": "A",
--                                  "columns": { "<colKey>": "B" },
--                                  "capacity": 120 } }
--   }
-- Idempotent.
-- ============================================================

alter table form_versions
    add column if not exists excel_map jsonb;
