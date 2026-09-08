/* ============================================================
   Excel template fill (pure unit tests).

   buildDefaultMap / fillTemplate / readTemplate run directly against
   the customer's real uploaded templates in test/fixtures/templates.
   No server, no database.

   The point of the feature: a record's Excel export is the customer's
   own spreadsheet with values dropped into place - headers, merges,
   column widths and internal formulas untouched.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

import { buildDefaultMap, fillTemplate, readTemplate } from "../src/excel-fill.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "templates");
const load = (name) => readFileSync(join(FIX, name));

async function open(name) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(load(name));
    return wb;
}

/* Schemas shaped the way the importer would infer them from these
   same files - labels match the sheet text so the mapper can anchor. */
const LAYOUT_SCHEMA = {
    fields: [
        { key: "part_number", label: "Part number:", type: "text" },
        { key: "lot_serial", label: "Lot / serial:", type: "text" },
        { key: "inspection_date", label: "Inspection date:", type: "date" },
        { key: "inspector", label: "Inspector:", type: "text" },
        { key: "disposition", label: "Disposition:", type: "text" },
        {
            key: "checks", label: "Layout Inspection rows", type: "table",
            columns: [
                { key: "balloon", label: "Balloon #", type: "text" },
                { key: "characteristic", label: "Characteristic", type: "text" },
                { key: "nominal", label: "Nominal", type: "number" },
                { key: "tol_minus", label: "Tol -", type: "number" },
                { key: "tol_plus", label: "Tol +", type: "number" },
                { key: "actual", label: "Actual", type: "number" },
                { key: "result", label: "Result", type: "text" }
            ]
        }
    ]
};

test("buildDefaultMap anchors the header fields and the grid of a clean template", async () => {
    const map = buildDefaultMap(await open("Layout Inspection.xlsx"), LAYOUT_SCHEMA);

    assert.equal(map.primary_sheet, "Layout Inspection");
    assert.equal(map.fields.part_number.cell, "B1");
    assert.equal(map.fields.disposition.cell, "B5");

    const t = map.tables.checks;
    assert.equal(t.sheet, "Layout Inspection");
    assert.equal(t.first_data_row, 8);
    assert.equal(t.columns.balloon, "A");
    assert.equal(t.columns.result, "G");
    assert.equal(t.row_number_col, "A");
});

test("fillTemplate writes values into the mapped cells and leaves the rest alone", async () => {
    const map = buildDefaultMap(await open("Layout Inspection.xlsx"), LAYOUT_SCHEMA);
    const rows = Array.from({ length: 6 }, (_, i) => ({
        balloon: String(i + 1), characteristic: "Char " + (i + 1),
        nominal: 1 + i / 10, tol_minus: -0.05, tol_plus: 0.05, actual: 1 + i / 10, result: "Pass"
    }));

    const { buffer } = await fillTemplate(load("Layout Inspection.xlsx"), map, LAYOUT_SCHEMA, {
        data: {
            part_number: "RP-1", lot_serial: "L-88213", inspection_date: "2026-09-08",
            inspector: "MO", disposition: "Accept", checks: rows
        }
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("Layout Inspection");

    assert.equal(ws.getCell("A1").value, "Part number:", "the label is untouched");
    assert.equal(ws.getCell("B1").value, "RP-1");
    assert.equal(ws.getCell("B5").value, "Accept");
    assert.equal(ws.getCell("A7").value, "Balloon #", "the grid header is untouched");
    assert.equal(ws.getCell("A8").value, "1");
    assert.equal(ws.getCell("B8").value, "Char 1");
    assert.equal(ws.getCell("F13").value, 1.5, "row 6 actual");
    assert.equal(wb.worksheets.length, 1, "no spill sheet - a clean grid just grows");
});

test("a fill round-trips back through readTemplate", async () => {
    const map = buildDefaultMap(await open("Layout Inspection.xlsx"), LAYOUT_SCHEMA);
    const checks = Array.from({ length: 40 }, (_, i) => ({
        balloon: String(i + 1), characteristic: "C" + (i + 1), nominal: i, actual: i, result: "Pass"
    }));

    const { buffer } = await fillTemplate(load("Layout Inspection.xlsx"), map, LAYOUT_SCHEMA, {
        data: { part_number: "RP-9", inspection_date: "2026-01-02", checks }
    });
    const back = await readTemplate(buffer, map, LAYOUT_SCHEMA);

    assert.equal(back.data.part_number, "RP-9");
    assert.equal(back.data.inspection_date, "2026-01-02");
    assert.equal(back.data.checks.length, 40, "all rows survive even past the template's blank rows");
    assert.deepEqual(back.data.checks[39], { balloon: "40", characteristic: "C40", nominal: 39, actual: 39, result: "Pass" });
});

test("overwrite_cols forces a value over an internal formula", async () => {
    const schema = {
        fields: [{
            key: "analysis", label: "Analysis", type: "table",
            columns: [
                { key: "sev", label: "Severity", type: "number" },
                { key: "occ", label: "Occurrence", type: "number" },
                { key: "det", label: "Detection", type: "number" },
                { key: "rpn", label: "R. P. N.", type: "number" }
            ]
        }]
    };
    const map = buildDefaultMap(await open("FMEA.xlsx"), schema);
    map.tables.analysis.overwrite_cols = ["rpn"];

    const { buffer } = await fillTemplate(load("FMEA.xlsx"), map, schema, {
        data: { analysis: [{ sev: 8, occ: 4, det: 3, rpn: 96 }] }
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("PFMEA");
    const t = map.tables.analysis;
    const rpn = ws.getCell(t.columns.rpn + String(t.first_data_row));
    assert.equal(rpn.value, 96, "the RPN cell now holds the literal, not the formula");
    assert.equal(rpn.formula, undefined);
});

test("readTemplate reports a cell that will not coerce to its field type", async () => {
    const map = buildDefaultMap(await open("Layout Inspection.xlsx"), LAYOUT_SCHEMA);
    const { buffer } = await fillTemplate(load("Layout Inspection.xlsx"), map, LAYOUT_SCHEMA, {
        data: { checks: [{ balloon: "1", characteristic: "Bore", nominal: "not-a-number", actual: 1 }] }
    });

    const back = await readTemplate(buffer, map, LAYOUT_SCHEMA);
    assert.ok(back.errors.some((e) => /Nominal: not a number/.test(e)),
        "the bad cell is flagged: " + JSON.stringify(back.errors));
});

test("an internal formula in a mapped cell is never overwritten", async () => {
    /* FMEA's RPN columns K and R hold =D*G*J style formulas. */
    const schema = {
        fields: [{
            key: "analysis", label: "Analysis", type: "table",
            columns: [
                { key: "sev", label: "Severity", type: "number" },
                { key: "occ", label: "Occurrence", type: "number" },
                { key: "det", label: "Detection", type: "number" },
                { key: "rpn", label: "R. P. N.", type: "number" }
            ]
        }]
    };
    const map = buildDefaultMap(await open("FMEA.xlsx"), schema);
    const t = map.tables.analysis;
    assert.ok(t, "the 18-column PFMEA grid was found");

    const { buffer } = await fillTemplate(load("FMEA.xlsx"), map, schema, {
        data: { analysis: [{ sev: 8, occ: 4, det: 3, rpn: 999 }] }
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet("PFMEA");
    const rpnCell = ws.getCell(t.columns.rpn + String(t.first_data_row));
    assert.ok(rpnCell.formula, "the RPN cell is still a formula, not the literal 999");
});

test("a grid with a regular per-row merge grows in place, replicating the merge", async () => {
    /* Process Flow Diagram: the "Description" column is merged F:G on
       every body row - a regular pattern, so the grid grows past the
       template's rows and the F:G merge is re-applied on each new one. */
    const schema = {
        fields: [{
            key: "steps", label: "Process Flow rows", type: "table",
            columns: [
                { key: "op", label: "Op. No.", type: "text" },
                { key: "no", label: "No.", type: "number" },
                { key: "description", label: "Description", type: "text" }
            ]
        }]
    };
    const map = buildDefaultMap(await open("Process Flow Diagram.xlsx"), schema);
    const t = map.tables.steps;
    assert.ok(t);
    const descCol = t.columns.description;                 // "F"

    const many = Array.from({ length: t.capacity + 8 }, (_, i) => ({ op: "OP" + i, no: i, description: "Step " + i }));
    const { buffer } = await fillTemplate(load("Process Flow Diagram.xlsx"), map, schema, { data: { steps: many } });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    assert.equal(wb.worksheets.length, 1, "no spill sheet - the grid grew");

    const ws = wb.getWorksheet("Process Flow Diagram");
    const lastRow = t.first_data_row + many.length - 1;
    assert.equal(String(ws.getCell(descCol + lastRow).value), "Step " + (many.length - 1), "last row written in place");
    const gWasMerged = (wb2) => wb2.getWorksheet("Process Flow Diagram").model.merges
        .some((r) => r === descCol + lastRow + ":G" + lastRow);
    assert.ok(gWasMerged(wb), "the F:G merge was replicated on the grown row: "
        + JSON.stringify(ws.model.merges.slice(-4)));
});

test("an irregular merge pattern still caps and spills", async () => {
    /* multi-row merges in the grid -> the fill will not risk mangling
       the layout, it caps at capacity and puts the rest on a sheet. */
    const wb0 = new ExcelJS.Workbook();
    const s = wb0.addWorksheet("Sheet1");
    s.getCell("A1").value = "Item"; s.getCell("B1").value = "Detail"; s.getCell("C1").value = "Note";
    for (let r = 2; r <= 6; r++) { s.getCell("A" + r).value = r - 1; }
    s.mergeCells("B2:C4");                 // a multi-row merge inside the grid
    s.mergeCells("B5:C6");
    const buf0 = Buffer.from(await wb0.xlsx.writeBuffer());

    const schema = {
        fields: [{
            key: "rows", label: "Rows", type: "table",
            columns: [
                { key: "item", label: "Item", type: "number" },
                { key: "detail", label: "Detail", type: "text" },
                { key: "note", label: "Note", type: "text" }
            ]
        }]
    };
    const map = {
        template_path: "x", primary_sheet: "Sheet1", fields: {},
        tables: { rows: { sheet: "Sheet1", first_data_row: 2, capacity: 4, row_number_col: "A",
            columns: { item: "A", detail: "B", note: "C" } } }
    };
    const many = Array.from({ length: 10 }, (_, i) => ({ item: i, detail: "d" + i, note: "n" + i }));
    const { buffer } = await fillTemplate(buf0, map, schema, { data: { rows: many } });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const extra = wb.worksheets.find((w) => /\+extra/i.test(w.name));
    assert.ok(extra, "rows past capacity spilled");
    assert.equal(extra.rowCount, 7, "header + 6 overflow rows");
});
