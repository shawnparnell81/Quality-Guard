/* ============================================================
   Excel -> form schema inference (pure unit tests).

   Exercises readGrid / inferSchema / chooseSheet directly against
   worksheets shaped like the real AIAG / PPAP templates the importer
   is fed (PFMEA, Control Plan, Process Flow, 8D, Dimensional, APQP
   Summary): a left column of labels, one blank data-entry grid, and a
   legend or rating scale below it. No server, no database.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { readGrid, inferSchema, chooseSheet } from "../src/routes/form-import.js";

/* exceljs in this version does not accept getCell(row, col) - go
   through the row. */
function put(sheet, row, col, value, bold) {
    const cell = sheet.getRow(row).getCell(col);
    cell.value = value;
    if (bold) cell.font = { bold: true };
    return cell;
}
function headerRow(sheet, row, cols, bold = true) {
    cols.forEach((t, i) => put(sheet, row, i + 1, t, bold));
}

function infer(build, sheetName = "Sheet1") {
    const wb = new ExcelJS.Workbook();
    const s = wb.addWorksheet(sheetName);
    build(s);
    return inferSchema(sheetName, readGrid(s));
}

const labels = (schema) => schema.fields.map((f) => f.label);
const table = (schema) => schema.fields.find((f) => f.type === "table");
const tables = (schema) => schema.fields.filter((f) => f.type === "table");
const field = (schema, label) => schema.fields.find((f) => f.label === label);

/* ---------- a blank template grid still becomes a table ---------- */

test("a header row with no data rows beneath is still a table", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Customer", true);
        put(s, 3, 1, "Part Name", true);
        headerRow(s, 6, ["Op. No.", "Process Description", "No.", "Out-going", "Control Method"]);
        put(s, 7, 1, "10");                       // one lonely partial row, rest blank
    });

    assert.deepEqual(labels(schema).slice(0, 2), ["Customer", "Part Name"]);
    const t = table(schema);
    assert.ok(t, "template grid inferred as a table");
    assert.equal(t.columns.length, 5);
    assert.equal(t.columns[0].label, "Op. No.");
});

test("a grid whose only filled body cell is a row number is still a table", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Control Plan Number");
        headerRow(s, 3,
            ["Part/Process Number", "Process Name", "Machine", "No.", "Product", "Process", "Char Class"],
            false);
        for (let r = 4; r < 30; r++) put(s, r, 1, String(r - 3));    // 1..26 in col A only
    });

    assert.equal(field(schema, "Control Plan Number").type, "text");
    const t = table(schema);
    assert.ok(t, "numbered-only template grid inferred as a table");
    assert.equal(t.columns.length, 7);
});

/* ---------- legends / rating scales below the grid are dropped ---------- */

test("a legend block after the main grid is not turned into fields or a table", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Customer", true);
        headerRow(s, 4,
            ["Op. No.", "Process Description", "No.", "Out-going", "Control Method", "Description", "SC"]);
        put(s, 5, 1, "10");

        put(s, 20, 1, "Legend", true);
        headerRow(s, 21, ["Operation", "Inspection", "Op/Ins", "Transport", "Delay", "Storage"]);
    });

    assert.equal(tables(schema).length, 1, "only the real grid, not the legend, is a table");
    assert.equal(labels(schema).includes("Operation"), false);
    assert.equal(labels(schema).includes("Legend"), false);
});

test("a repeated grid header (page 2) is not duplicated", () => {
    const cols = ["Op. No.", "Process Description", "No.", "Out-going", "Control Method"];
    const schema = infer((s) => {
        put(s, 1, 1, "Customer", true);
        headerRow(s, 3, cols);
        put(s, 4, 1, "10");
        headerRow(s, 20, cols);                   // identical header again further down
        put(s, 21, 1, "10");
    });

    assert.equal(tables(schema).length, 1);
});

/* ---------- 8D-style banner rows become sections, not tables ---------- */

test("a wide bold banner that leads a row is a section, and trailing labels join it", () => {
    const schema = infer((s) => {
        put(s, 1, 3, "Customer:");
        put(s, 3, 3, "Date Open:");

        s.mergeCells("C5:H5");
        put(s, 5, 3, "D3 Choose and Verify Interim Containment Action(s) (ICA):", true);
        put(s, 5, 9, "% Effective:", true);
        put(s, 5, 10, "Target Date:", true);
    });

    assert.equal(tables(schema).length, 0, "no bogus table from the banner row");
    const eff = field(schema, "% Effective");
    assert.ok(eff, "the trailing label became a field");
    assert.equal(eff.section, "D3 Choose and Verify Interim Containment Action(s) (ICA)");
    assert.equal(eff.type, "number");
    assert.equal(field(schema, "Target Date").type, "date");
});

test("a numbered bold heading with a trailing cell is a section", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Product name:", true);
        put(s, 3, 1, "1. PRELIMINARY PROCESS CAPABILITY STUDY", true);
        put(s, 3, 7, "QUANTITY", true);
        put(s, 5, 1, "Ppk-Special Characteristic");
    });

    assert.equal(labels(schema).includes("1. PRELIMINARY PROCESS CAPABILITY STUDY"), false,
        "the heading is a section, not a field");
    assert.equal(field(schema, "Ppk-Special Characteristic").section,
        "1. PRELIMINARY PROCESS CAPABILITY STUDY");
});

/* ---------- noise suppression in the label column ---------- */

test("an all-caps matrix row heading with no colon is not a field", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Customer:");
        put(s, 3, 1, "DIMENSIONAL");
        put(s, 4, 1, "VISUAL");
        put(s, 5, 1, "LABORATORY");
    });

    assert.deepEqual(labels(schema), ["Customer"]);
});

test("a second column label is only taken when it ends with a colon", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Model Years:");
        put(s, 1, 2, "model years / programs");    // example text, dropped
        put(s, 1, 5, "Key Date:");                  // real second-column label
        put(s, 1, 6, "2008-07-15");                 // example value, dropped
        put(s, 2, 1, "Organization");
        put(s, 2, 3, "Supplier");                   // example value, dropped
    });

    assert.deepEqual(labels(schema).sort(), ["Key Date", "Model Years", "Organization"].sort());
    assert.equal(field(schema, "Key Date").type, "date");
});

/* ---------- FMEA column typing ---------- */

test("FMEA rating columns type as number and repeats are disambiguated", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Process Step");
        headerRow(s, 3, ["Potential Failure Mode", "Severity", "Occurrence", "Detection", "R. P. N.",
            "Severity", "Occurrence", "Detection", "R. P. N."]);
    });

    const t = table(schema);
    assert.ok(t);
    assert.equal(t.columns.length, 9);
    assert.equal(t.columns.find((c) => c.label === "Severity").type, "number");
    assert.equal(t.columns.find((c) => c.label === "R. P. N.").type, "number");
    assert.ok(t.columns.some((c) => c.label === "Severity (revised)"), "the repeated column is relabelled");
    assert.equal(new Set(t.columns.map((c) => c.key)).size, t.columns.length, "column keys stay unique");
});

test("a wide table drops memo columns down to text (no room for a textarea)", () => {
    const schema = infer((s) => {
        put(s, 1, 1, "Item");
        headerRow(s, 3, ["Requirements", "Potential Failure Mode", "Potential Effect(s) of Failure",
            "Severity", "Class", "Potential Cause", "Occurrence"]);
    });

    const t = table(schema);
    assert.equal(t.columns.length, 7);
    assert.equal(t.columns.every((c) => c.type !== "memo"), true);
});

/* ---------- chooseSheet ---------- */

test("chooseSheet skips an instruction sheet and honours the file name", () => {
    const wb = new ExcelJS.Workbook();
    const names = ["Intructions", "Blank 8D", "Risk Analysis"];
    for (const name of names) {
        const s = wb.addWorksheet(name);
        for (let r = 1; r <= 20; r++) for (let c = 1; c <= 9; c++) put(s, r, c, "x");
    }
    assert.equal(chooseSheet(wb, "8D").name, "Blank 8D");
});

test("chooseSheet ignores empty sheets", () => {
    const wb = new ExcelJS.Workbook();
    const real = wb.addWorksheet("PFMEA");
    wb.addWorksheet("Sheet1");                    // untouched, empty
    put(real, 1, 1, "Customer");
    assert.equal(chooseSheet(wb).name, "PFMEA");
});
