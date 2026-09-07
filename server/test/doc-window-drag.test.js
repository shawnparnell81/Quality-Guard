/* ============================================================
   Document-viewer window dragging, exercised in a real browser.

   The drag in public/js/doc-windows.js used to run from mousemove /
   mouseup listeners on window. Every document window's body is an
   <iframe>, and while the pointer is over an iframe its events go to
   that iframe's document rather than the page - so dragging one window
   across another froze the move, and the swallowed mouseup left the
   window chasing the cursor afterwards. The fix drives the drag with
   pointer capture on the header instead, makes iframes inert for the
   duration, and guarantees cleanup through lostpointercapture.

   This suite loads the real module in headless Chromium behind a tiny
   stub server (no app, no database, no login), opens two windows, and
   checks: a dragged window tracks the full distance while the pointer
   is over another window and its rendered PDF; the other window does
   not move; nothing follows the cursor once the button is up; a window
   cannot be dragged off-screen; and repeated open/close leaves nothing
   behind.

   Scope note: Playwright's synthetic pointer input is delivered to the
   top frame's handlers even over an out-of-process PDF iframe, so it
   does NOT reproduce the original real-cursor freeze on its own - both
   the old and new code "track" under synthetic input. What this suite
   actually locks in is the new pointer-capture drag behaving correctly
   end to end, plus the off-screen clamp, which the old code failed.
   The real-cursor iframe case still wants a manual check in a browser.

   Needs a Chromium build for Playwright. If one is not installed the
   whole suite skips with a note rather than failing - run
   `npx playwright install chromium` to enable it.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "public");
const jsDir = join(publicDir, "js");

/* A real one-page PDF so Chromium loads its PDF viewer into the iframe.
   That viewer is an out-of-process frame that eats pointer events over
   its area - which is exactly the hazard the fix has to survive, so the
   iframe has to contain something the browser will genuinely render,
   not a stub that fails to parse and leaves an inert blank frame. */
function makePdf() {
    return new Promise((resolve) => {
        const doc = new PDFDocument({ size: [300, 300] });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.fontSize(20).text("Sample document", 40, 140);
        doc.end();
    });
}

let samplePdf;

/* The real stylesheet matters: .doc-window only obeys inline left/top
   because style.css positions it, and #doc-windows only lines up with
   the viewport because style.css pins it. A bare page would let the
   drag "pass" while nothing actually moved. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>drag harness</title>
<link rel="stylesheet" href="/style.css">
<body style="margin:0"><div id="doc-windows"></div></body>`;

let chromium;
let browserAvailable = true;
let skipReason = "";

let stub;          // http.Server
let base;          // http://127.0.0.1:<port>
let browser;
let page;

before(async () => {
    samplePdf = await makePdf();

    try {
        ({ chromium } = await import("playwright"));
    } catch {
        browserAvailable = false;
        skipReason = "playwright is not installed";
        return;
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
            } catch {
                response.writeHead(404);
                return response.end();
            }
        }

        if (url === "/style.css") {
            try {
                const body = await readFile(join(publicDir, "style.css"));
                response.writeHead(200, { "Content-Type": "text/css" });
                return response.end(body);
            } catch {
                response.writeHead(404);
                return response.end();
            }
        }

        if (url.includes("/revisions/") && url.includes("/download")) {
            response.writeHead(200, { "Content-Type": "application/pdf" });
            return response.end(samplePdf);
        }

        if (url.endsWith("/revisions")) {
            response.writeHead(200, { "Content-Type": "application/json" });
            return response.end(JSON.stringify({
                revisions: [{
                    revision: "A",
                    has_file: true,
                    mime_type: "application/pdf",
                    original_filename: "sample.pdf"
                }]
            }));
        }

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
    });

    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + stub.address().port;

    try {
        browser = await chromium.launch();
    } catch {
        browserAvailable = false;
        skipReason = "no Chromium build for Playwright (run: npx playwright install chromium)";
        return;
    }

    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
});

after(async () => {
    if (browser) await browser.close();
    if (stub) await new Promise((resolve) => stub.close(resolve));
});

/* Opens two windows through the real module and puts A at the top-left
   and B squarely in the drag path, so any drag of A to the lower-right
   must pass over B and its iframe. Returns a small helper bound to the
   page for reading window geometry. */
async function twoWindows() {
    await page.goto(base + "/app", { waitUntil: "domcontentloaded" });

    await page.evaluate(async () => {
        const m = await import("/js/doc-windows.js");
        await m.openDocumentWindow("DOC-A", "A", "Window A");
        await m.openDocumentWindow("DOC-B", "A", "Window B");
    });

    await page.waitForFunction(
        () => document.querySelectorAll(".doc-window").length === 2
    );
    await page.evaluate(() => {
        const [a, b] = document.querySelectorAll(".doc-window");
        a.style.left = "40px";  a.style.top = "40px";
        b.style.left = "360px"; b.style.top = "150px";
    });

    return (index, selector) => page.evaluate(([i, sel]) => {
        const wrap = document.querySelectorAll(".doc-window")[i];
        const target = sel ? wrap.querySelector(sel) : wrap;
        const r = target.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }, [index, selector]);
}

async function dragBy(headBox, dx, dy) {
    const x = headBox.left + 40;
    const y = headBox.top + 12;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(x + (dx * step) / 12, y + (dy * step) / 12);
    }
    await page.mouse.up();
}

const near = (got, want, tol = 6) => Math.abs(got - want) <= tol;

test("a window follows the pointer across another window and its iframe", async (t) => {
    if (!browserAvailable) return t.skip(skipReason);
    const box = await twoWindows();

    const aBefore = await box(0);
    const bBefore = await box(1);

    await dragBy(await box(0, ".doc-window-head"), 520, 260);

    const aAfter = await box(0);
    const bAfter = await box(1);

    assert.ok(
        near(aAfter.left - aBefore.left, 520) && near(aAfter.top - aBefore.top, 260),
        `dragged window moved (${Math.round(aAfter.left - aBefore.left)}, `
        + `${Math.round(aAfter.top - aBefore.top)}), expected about (520, 260)`
    );
    assert.ok(
        near(bAfter.left, bBefore.left, 1) && near(bAfter.top, bBefore.top, 1),
        "the window it was dragged over must not move"
    );
});

test("nothing chases the cursor after the button is released", async (t) => {
    if (!browserAvailable) return t.skip(skipReason);
    const box = await twoWindows();

    await dragBy(await box(0, ".doc-window-head"), 300, 180);
    const atRest = await box(0);

    await page.mouse.move(150, 650);
    await page.mouse.move(900, 200);

    const afterIdleMove = await box(0);
    assert.ok(
        near(afterIdleMove.left, atRest.left, 1) && near(afterIdleMove.top, atRest.top, 1),
        "no window should move while no button is held"
    );

    const stuck = await page.evaluate(
        () => document.body.classList.contains("doc-window-dragging")
    );
    assert.equal(stuck, false, "body.doc-window-dragging must be cleared after a drag");
});

test("a window cannot be dragged off-screen", async (t) => {
    if (!browserAvailable) return t.skip(skipReason);
    const box = await twoWindows();

    await dragBy(await box(1, ".doc-window-head"), 4000, 4000);

    const b = await box(1);
    const view = page.viewportSize();
    assert.ok(
        b.right <= view.width + 1 && b.bottom <= view.height + 1
        && b.left >= -1 && b.top >= -1,
        `window left the viewport: L${Math.round(b.left)} T${Math.round(b.top)} `
        + `R${Math.round(b.right)} B${Math.round(b.bottom)} in ${view.width}x${view.height}`
    );
});

test("opening and closing windows repeatedly leaves nothing behind", async (t) => {
    if (!browserAvailable) return t.skip(skipReason);
    await page.goto(base + "/app", { waitUntil: "domcontentloaded" });

    const remaining = await page.evaluate(async () => {
        const m = await import("/js/doc-windows.js");
        for (let i = 0; i < 8; i += 1) {
            await m.openDocumentWindow("CYCLE-" + i, "A", "Cycle " + i);
        }
        document.querySelectorAll("[data-doc-window-close]").forEach((btn) => btn.click());
        return document.querySelectorAll(".doc-window").length;
    });
    assert.equal(remaining, 0, "every closed window should be gone from the DOM");

    /* And the drag still works after all that churn. */
    const box = await twoWindows();
    const before = await box(0);
    await dragBy(await box(0, ".doc-window-head"), 200, 120);
    const after = await box(0);
    assert.ok(
        near(after.left - before.left, 200) && near(after.top - before.top, 120),
        "dragging is still correct after repeated open/close"
    );
});
