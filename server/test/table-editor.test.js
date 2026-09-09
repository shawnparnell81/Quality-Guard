/* ============================================================
   The repeating-grid editor (public/js/table-editor.js), exercised
   in a real browser (audit H3).

   Extracting the old ~350-line `case "table"` from forms.js into a
   module with an explicit row model is only safe with a test that
   drives the actual behaviours: seeding, typing, computed recompute,
   paste-from-Excel growing the grid, Tab adding a trailing row,
   removing a row, the always-one-blank-row rule, and the wide-row
   drawer round-tripping through the model WITHOUT relocating the
   grid's live input nodes.

   This is the first client test. It follows doc-window-drag.test.js:
   a tiny stub server serves the real ES modules, Playwright loads
   them in headless Chromium, and the whole suite skips with a note
   if no Chromium build is present.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");
const jsDir = join(publicDir, "js");

const PAGE = `<!doctype html><meta charset="utf-8"><title>table-editor harness</title>
<body><div id="mount"></div></body>`;

let chromium;
let ok = true;
let skip = "";
let stub, base, browser, page;

before(async () => {
    try {
        ({ chromium } = await import("playwright"));
    } catch {
        ok = false; skip = "playwright is not installed"; return;
    }

    stub = createServer(async (request, response) => {
        const url = request.url;
        if (url === "/app") {
            response.writeHead(200, { "Content-Type": "text/html" });
            return response.end(PAGE);
        }
        if (url.startsWith("/js/") && url.endsWith(".js")) {
            try {
                const body = await readFile(join(jsDir, url.slice("/js/".length)));
                response.writeHead(200, { "Content-Type": "text/javascript" });
                return response.end(body);
            } catch { response.writeHead(404); return response.end(); }
        }
        response.writeHead(404); response.end();
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + stub.address().port;

    try {
        browser = await chromium.launch();
    } catch {
        ok = false; skip = "no Chromium for Playwright (run: npx playwright install chromium)"; return;
    }
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
});

after(async () => {
    if (browser) await browser.close();
    if (stub) await new Promise((r) => stub.close(r));
});

/* Mounts an editor with a given field + seed value and returns a
   handle bound to `window.__te`. */
async function mount(field, value) {
    await page.goto(base + "/app", { waitUntil: "domcontentloaded" });
    await page.evaluate(async ({ field, value }) => {
        const { createTableEditor } = await import("/js/table-editor.js");
        const te = createTableEditor({ field, value });
        document.getElementById("mount").append(te.el);
        window.__te = te;
    }, { field, value });
}

const PFMEA = {
    key: "lines", label: "Lines", type: "table", columns: [
        { key: "item", label: "Item", type: "text" },
        { key: "sev", label: "Sev", type: "number" },
        { key: "occ", label: "Occ", type: "number" },
        { key: "det", label: "Det", type: "number" },
        { key: "rpn", label: "RPN", type: "computed", compute: "product", inputs: ["sev", "occ", "det"] }
    ]
};

test("seeds rows, keeps one trailing blank, and getRows drops the blank", async (t) => {
    if (!ok) return t.skip(skip);
    await mount(PFMEA, [{ item: "Bore", sev: 8, occ: 3, det: 4 }]);

    const bodyRows = await page.$$eval("#mount tbody tr", (trs) => trs.length);
    assert.equal(bodyRows, 2, "the seeded row plus one blank");

    const rows = await page.evaluate(() => window.__te.getRows());
    assert.equal(rows.length, 1, "getRows ignores the empty trailing row");
    assert.equal(rows[0].item, "Bore");
    assert.equal(rows[0].rpn, 96, "RPN computed in the model, not typed");
});

test("typing a number recomputes the row's computed cell", async (t) => {
    if (!ok) return t.skip(skip);
    await mount(PFMEA, [{ item: "Face", sev: 2, occ: 2, det: 2 }]);

    await page.fill("#mount tbody tr:first-child td:nth-child(2) input", "10");
    await page.evaluate(() => document.querySelector("#mount tbody tr:first-child td:nth-child(2) input")
        .dispatchEvent(new Event("input", { bubbles: true })));

    const rpn = await page.$eval("#mount tbody tr:first-child td:nth-child(5) input", (i) => i.value);
    assert.equal(rpn, "40");
    const rows = await page.evaluate(() => window.__te.getRows());
    assert.equal(rows[0].rpn, 40);
});

test("pasting a TSV block grows the grid and skips the computed column", async (t) => {
    if (!ok) return t.skip(skip);
    await mount(PFMEA, []);

    /* paste into the first cell of the first (blank) row */
    await page.evaluate(() => {
        const input = document.querySelector("#mount tbody tr:first-child td:first-child input");
        input.focus();
        const dt = new DataTransfer();
        dt.setData("text/plain", "Hole\t9\t2\t5\nSlot\t3\t3\t3\nRib\t7\t1\t2");
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });

    const rows = await page.evaluate(() => window.__te.getRows());
    assert.equal(rows.length, 3, "three rows from the pasted block");
    assert.deepEqual(rows.map((r) => r.item), ["Hole", "Slot", "Rib"]);
    assert.equal(rows[0].rpn, 90, "9*2*5 computed on paste");
    assert.equal(rows[2].rpn, 14);
});

test("Tab off the last cell of the last row adds a row", async (t) => {
    if (!ok) return t.skip(skip);
    await mount(PFMEA, [{ item: "One", sev: 1, occ: 1, det: 1 }]);

    const before = await page.$$eval("#mount tbody tr", (t) => t.length);
    /* focus the last typeable cell of the last row (det, 4th column) */
    await page.focus("#mount tbody tr:last-child td:nth-child(4) input");
    await page.keyboard.press("Tab");
    const after = await page.$$eval("#mount tbody tr", (t) => t.length);
    assert.equal(after, before + 1);
});

test("the drawer edits the model and re-renders the row - no node moved", async (t) => {
    if (!ok) return t.skip(skip);
    const wide = {
        key: "chars", label: "Characteristics", type: "table",
        columns: Array.from({ length: 8 }, (_, i) => ({ key: "c" + i, label: "C" + i, type: "text" }))
    };
    await mount(wide, [{ c0: "a", c1: "b" }]);

    /* remember the identity of a live grid input before opening the drawer */
    await page.evaluate(() => {
        window.__c0 = document.querySelector("#mount tbody tr:first-child td:first-child input");
        window.__c0.dataset.mark = "original";
    });

    await page.click("#mount tbody tr:first-child .row-tools button[aria-label='Expand row']");
    await page.waitForSelector("dialog.modal[open] form .field-group:first-child input");
    await page.fill("dialog.modal form .field-group:first-child input", "changed");
    await page.evaluate(() => document.querySelector("dialog.modal form .field-group:first-child input")
        .dispatchEvent(new Event("input", { bubbles: true })));
    await page.click("dialog.modal .modal-foot button");

    await page.waitForFunction(() =>
        document.querySelector("#mount tbody tr:first-child td:first-child input")?.value === "changed");
    const cellValue = await page.$eval("#mount tbody tr:first-child td:first-child input", (i) => i.value);
    assert.equal(cellValue, "changed", "the grid cell reflects the drawer edit");

    const sameNode = await page.evaluate(() =>
        document.querySelector("#mount tbody tr:first-child td:first-child input") === window.__c0);
    assert.equal(sameNode, false, "the row was re-rendered, not the drawer's node relocated back");

    const rows = await page.evaluate(() => window.__te.getRows());
    assert.equal(rows[0].c0, "changed");
});

test("removing a row updates the model", async (t) => {
    if (!ok) return t.skip(skip);
    await mount(PFMEA, [{ item: "Keep", sev: 1, occ: 1, det: 1 }, { item: "Drop", sev: 2, occ: 2, det: 2 }]);

    await page.click("#mount tbody tr:nth-child(2) .row-tools button[aria-label='Remove row']");
    const rows = await page.evaluate(() => window.__te.getRows());
    assert.deepEqual(rows.map((r) => r.item), ["Keep"]);
});
