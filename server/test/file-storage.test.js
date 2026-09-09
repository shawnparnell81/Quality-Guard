/* ============================================================
   File storage driver contract (audit P1 / H5).

   saveUploadedFile / readUploadedFile now go through a driver chosen
   by STORAGE_DRIVER (default "local"), so an object store can be
   dropped in later without touching a single caller. These pin the
   local driver's behaviour and the traversal guard that must hold
   whatever the driver.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
    saveUploadedFile, readUploadedFile, assertAllowedExtension,
    STORAGE_DRIVER, STORAGE_ROOT
} from "../src/file-storage.js";

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
