/* ============================================================
   Backup bundles (P4.1).

   backup() writes a folder with db.sql + storage/ + manifest.json;
   { skipStorage: true } leaves the files out and says so in the
   manifest; listBackups() reports bundles newest-first; and the
   retention rule keeps the newest N without ever dropping the most
   recent.

   pg_dump is read-only, so this runs against the dev database
   without disturbing it. The bundles it makes are tagged and removed
   in `after`.
   ============================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { backup, listBackups, bundlesToPrune } from "../scripts/backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const backupDir = join(here, "..", "backups");
const TAG = "test-p41-" + Date.now();

after(async () => {
    for (const name of await readdir(backupDir)) {
        if (name.includes("test-p41-")) {
            await rm(join(backupDir, name), { recursive: true, force: true });
        }
    }
});

test("a full backup is a bundle with a dump, the files and a manifest", async () => {
    const result = await backup(TAG);

    assert.ok(existsSync(result.dir), "the bundle folder exists");
    assert.ok(existsSync(join(result.dir, "db.sql")), "db.sql is present");
    assert.ok((await stat(join(result.dir, "db.sql"))).size > 0, "db.sql is not empty");

    const manifest = JSON.parse(await readFile(join(result.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.bundle_version, 1);
    assert.equal(manifest.label, TAG);
    assert.equal(typeof manifest.db_bytes, "number");
    assert.equal(manifest.storage_included, result.storageIncluded);

    if (result.storageIncluded) {
        assert.ok(existsSync(join(result.dir, "storage")), "storage/ was copied in");
        assert.ok(manifest.storage_bytes >= 0);
    }
});

test("skipStorage makes a database-only bundle", async () => {
    const result = await backup(TAG + "-dbonly", { skipStorage: true });

    assert.equal(result.storageIncluded, false);
    assert.ok(!existsSync(join(result.dir, "storage")), "no storage/ folder");

    const manifest = JSON.parse(await readFile(join(result.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.storage_included, false);
    assert.equal(manifest.storage_bytes, 0);
});

test("listBackups reports bundles newest-first", async () => {
    const items = await listBackups();
    const mine = items.filter((i) => i.name.includes(TAG));
    assert.ok(mine.length >= 2, "both test bundles are listed");
    assert.ok(mine.every((i) => i.kind === "bundle"));

    for (let i = 1; i < items.length; i++) {
        assert.ok(items[i - 1].at >= items[i].at, "sorted newest-first");
    }
});

test("retention keeps the newest N and never drops the most recent", async () => {
    const fake = (n) => ({ name: "b" + n, path: "/x/b" + n, at: new Date(2026, 0, n) })
        ;
    const list = [fake(9), fake(8), fake(7), fake(6), fake(5)];   // newest-first

    assert.deepEqual(bundlesToPrune(list, 3).map((b) => b.name), ["b6", "b5"]);
    assert.deepEqual(bundlesToPrune(list, 10).map((b) => b.name), []);
    /* keep 0 is treated as keep 1 - the latest is sacred */
    assert.deepEqual(bundlesToPrune(list, 0).map((b) => b.name), ["b8", "b7", "b6", "b5"]);
});
