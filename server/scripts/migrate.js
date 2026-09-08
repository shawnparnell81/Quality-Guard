/* ============================================================
   Applies pending migrations.

     npm run db:migrate

   Every schema change from here on goes in db/migrations as a new
   numbered file. They run once, in order, and are recorded, so
   changing the schema no longer means destroying the data.

   Naming: 002_add_something.sql, 003_..., zero padded so they sort
   the way they run.
   ============================================================ */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";
import { backup } from "./backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

try {
    /* The runner owns this table. `checksum` was added later, so the
       alter covers databases that still have the two-column shape. */
    await pool.query(`
        create table if not exists schema_migrations (
            filename    text primary key,
            checksum    text,
            applied_at  timestamptz not null default now()
        )
    `);
    await pool.query("alter table schema_migrations add column if not exists checksum text");

    if (!existsSync(migrationsDir)) {
        console.log("No migrations folder yet. Nothing to do.");
        process.exit(0);
    }

    const files = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql"))
        .sort();

    const appliedRows = (await pool.query(
        "select filename, checksum from schema_migrations")).rows;
    const applied = new Set(appliedRows.map((row) => row.filename));

    /* An applied migration is history. If its file changed on disk
       since, the database and the tree disagree about what ran -
       refuse to go further rather than paper over it with a new
       migration. Rows with no checksum predate this check and are
       backfilled, not flagged. */
    const changed = [];
    for (const row of appliedRows) {
        const path = join(migrationsDir, row.filename);
        if (!existsSync(path)) {
            if (row.checksum) changed.push(row.filename + "  (file is gone)");
            continue;
        }
        const digest = sha256(await readFile(path, "utf8"));
        if (!row.checksum) {
            await pool.query(
                "update schema_migrations set checksum = $1 where filename = $2",
                [digest, row.filename]);
        } else if (digest !== row.checksum) {
            changed.push(row.filename + "  (content changed since it was applied)");
        }
    }
    if (changed.length > 0) {
        console.error("Applied migrations no longer match their files:");
        for (const line of changed) console.error("  " + line);
        console.error("");
        console.error("Migrations are append-only. Revert the edit and add a new one instead.");
        process.exit(1);
    }

    const pending = files.filter((name) => !applied.has(name));

    if (pending.length === 0) {
        console.log("Up to date. " + applied.size + " migration(s) already applied.");
        process.exit(0);
    }

    console.log(pending.length + " migration(s) to apply.");
    console.log("Taking a database backup first...");
    /* Schema migrations never touch stored files, so the pre-migrate
       safety copy is the dump only - fast, and enough to roll back. */
    const safety = await backup("pre-migrate", { skipStorage: true });
    console.log("  " + safety.dir);
    console.log("");

    for (const filename of pending) {
        const sql = await readFile(join(migrationsDir, filename), "utf8");
        const client = await pool.connect();

        try {
            /* Each migration is one transaction. A failure half way
               through leaves the schema as it was, rather than in a
               state nothing knows how to describe. */
            await client.query("BEGIN");
            await client.query(sql);
            await client.query(
                "insert into schema_migrations (filename, checksum) values ($1, $2)",
                [filename, sha256(sql)]
            );
            await client.query("COMMIT");

            console.log("  applied  " + filename);
        } catch (error) {
            await client.query("ROLLBACK");
            console.error("  FAILED   " + filename);
            console.error("           " + error.message);
            console.error("");
            console.error("Nothing was changed by this migration. Fix it and run again.");
            process.exitCode = 1;
            break;
        } finally {
            client.release();
        }
    }
} catch (error) {
    console.error("Migration run failed: " + error.message);
    process.exitCode = 1;
} finally {
    await pool.end().catch(() => {});
}
