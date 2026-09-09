/* ============================================================
   Excel inference regression corpus (audit P3 / M3, M7).

   The 8 real customer templates in test/fixtures/templates/ are run
   through inferWorkbook and compared to a committed snapshot of the
   inferred SHAPE - sheet count, flat-field count and type histogram,
   section count, and each table's column count + per-column types.
   Wording is deliberately not snapshotted, so this catches a
   detection change that degrades a real template without breaking on
   a harmless label tweak.

   When a change to the inference is intentional, regenerate:
     node -e "..." (see the generator in the commit that added this)
   review the diff, and commit the new snapshot.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

import { inferWorkbook } from "../src/routes/form-import.js";

const here = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(here, "fixtures", "templates");
const snapshot = JSON.parse(readFileSync(join(here, "fixtures", "inference-snapshot.json"), "utf8"));

async function shapeOf(file) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(templatesDir, file));
    const s = inferWorkbook(wb, file.replace(/\.xlsx$/, ""));
    const flat = s.fields.filter((x) => x.type !== "table");
    const tables = s.fields.filter((x) => x.type === "table");
    return {
        sheets: (s.sheets || []).length,
        flat_fields: flat.length,
        flat_types: flat.reduce((m, x) => { m[x.type] = (m[x.type] || 0) + 1; return m; }, {}),
        sections: [...new Set(s.fields.map((x) => x.section).filter(Boolean))].length,
        tables: tables.map((t) => ({ cols: t.columns.length, types: t.columns.map((c) => c.type) }))
    };
}

const fixtures = readdirSync(templatesDir).filter((f) => f.endsWith(".xlsx")).sort();

test("every fixture in the corpus has a snapshot (add one when you add a template)", () => {
    for (const f of fixtures) assert.ok(snapshot[f], "no snapshot entry for " + f);
    for (const f of Object.keys(snapshot)) assert.ok(fixtures.includes(f), "snapshot for a missing fixture: " + f);
});

for (const file of fixtures) {
    test("inference shape is stable: " + file, async () => {
        assert.deepEqual(await shapeOf(file), snapshot[file]);
    });
}
