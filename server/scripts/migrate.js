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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";
import { backup } from "./backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "db", "migrations");

try {
    await pool.query(`
        create table if not exists schema_migrations (
            filename    text primary key,
            applied_at  timestamptz not null default now()
        )
    `);

    if (!existsSync(migrationsDir)) {
        console.log("No migrations folder yet. Nothing to do.");
        process.exit(0);
    }

    const files = (await readdir(migrationsDir))
        .filter((name) => name.endsWith(".sql"))
        .sort();

    const applied = new Set(
        (await pool.query("select filename from schema_migrations")).rows
            .map((row) => row.filename)
    );

    const pending = files.filter((name) => !applied.has(name));

    if (pending.length === 0) {
        console.log("Up to date. " + applied.size + " migration(s) already applied.");
        process.exit(0);
    }

    console.log(pending.length + " migration(s) to apply.");
    console.log("Taking a backup first...");
    const safety = await backup("pre-migrate");
    console.log("  " + safety.file);
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
                "insert into schema_migrations (filename) values ($1)",
                [filename]
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
