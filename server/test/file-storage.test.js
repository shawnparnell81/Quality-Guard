/* ============================================================
   File storage driver contract (audit P1 / H5) + upload hardening
   (audit P2 / M10).

   saveUploadedFile / readUploadedFile go through a driver chosen by
   STORAGE_DRIVER (default "local"); the traversal guard holds
   whatever the driver; and a file whose bytes do not match its
   claimed extension is refused before it is ever stored.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
    saveUploadedFile, readUploadedFile, assertAllowedExtension,
    assertContentMatchesExtension, STORAGE_DRIVER, STORAGE_ROOT
} from "../src/file-storage.js";
import { assertSaneWorkbook } from "../src/uploads.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

const EXTS = new Set([".txt", ".pdf"]);
const written = [];

test.after(async () => {
    for (const p of written) {
        await rm(path.resolve(STORAGE_ROOT, p), { force: true });
    }
});

test("defaults to the local driver", () => {
    assert.equal(STORAGE_DRIVER, "local", "no STORAGE_DRIVER in the test env -> local");
});

test("save returns an opaque <subdir>/<uuid><ext> path, read gets the bytes back", async () => {
    const bytes = Buffer.from("calibration cert body");
    const storagePath = await saveUploadedFile("test-fixtures", EXTS, "Cert For Gage 12.txt", bytes);
    written.push(storagePath);

    assert.match(storagePath, /^test-fixtures\/[0-9a-f-]{36}\.txt$/, "generated id, caller's name discarded");
    const round = await readUploadedFile(storagePath);
    assert.equal(round.toString(), "calibration cert body");
});

test("an extension outside the caller's allowlist is a 422", async () => {
    await assert.rejects(
        () => saveUploadedFile("test-fixtures", EXTS, "payload.exe", Buffer.from("x")),
        (e) => e.status === 422
    );
    assert.throws(() => assertAllowedExtension("a.zip", EXTS), (e) => e.status === 422);
});

test("a climbed storage_path is refused at read time", async () => {
    await assert.rejects(
        () => readUploadedFile("../../../etc/passwd"),
        (e) => e.status === 400
    );
    await assert.rejects(
        () => readUploadedFile("test-fixtures/../../secret.txt"),
        (e) => e.status === 400
    );
});

test("magic bytes are checked: a renamed file is refused", () => {
    /* PNG bytes wearing a .pdf name */
    assert.throws(() => assertContentMatchesExtension(".pdf", PNG_BYTES), (e) => e.status === 422);
    /* an OOXML .xlsx must actually be a zip */
    assert.throws(() => assertContentMatchesExtension(".xlsx", PDF_BYTES), (e) => e.status === 422);
    /* the real thing passes */
    assert.doesNotThrow(() => assertContentMatchesExtension(".pdf", PDF_BYTES));
    assert.doesNotThrow(() => assertContentMatchesExtension(".png", PNG_BYTES));
    assert.doesNotThrow(() => assertContentMatchesExtension(".xlsx", ZIP_BYTES));
    /* no signature for these - allowed on the extension alone */
    assert.doesNotThrow(() => assertContentMatchesExtension(".txt", Buffer.from("anything at all")));
    assert.doesNotThrow(() => assertContentMatchesExtension(".csv", Buffer.from("a,b,c")));
});

test("saveUploadedFile rejects a renamed file before it is stored", async () => {
    await assert.rejects(
        () => saveUploadedFile("test-fixtures", EXTS, "sneaky.pdf", PNG_BYTES),
        (e) => e.status === 422
    );
});

test("assertSaneWorkbook trips on an implausibly large workbook", () => {
    const ok = { worksheets: [{ actualRowCount: 500, actualColumnCount: 20 }] };
    assert.doesNotThrow(() => assertSaneWorkbook(ok));

    const bomb = { worksheets: [{ actualRowCount: 3_000_000, actualColumnCount: 50 }] };
    assert.throws(() => assertSaneWorkbook(bomb), (e) => e.status === 413);
});
