/* ============================================================
   Rebuild the database from schema.sql and seed.sql.

     npm run db:reset

   THIS DESTROYS EVERYTHING IN THE DATABASE. Every nonconformance you
   entered, every password anyone set, gone.

   It takes a backup first, so a mistake is recoverable:
     npm run db:restore

   Once you are entering data you care about, stop using this and use
   npm run db:migrate for schema changes instead.
   ============================================================ */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db.js";
import { backup } from "./backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..");

function npmRun(script) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.platform === "win32" ? "npm.cmd" : "npm",
            ["run", script],
            { cwd: serverDir, stdio: "inherit", shell: process.platform === "win32" }
        );

        child.on("close", (code) => {
            code === 0 ? resolve() : reject(new Error(script + " failed"));
        });
    });
}

try {
    /* Is there anything worth protecting? A fresh database has no
       tables, and backing that up is noise. */
    const existing = await pool.query(`
        select count(*)::int as n
          from information_schema.tables
         where table_schema = 'public'
    `);

    const hasTables = existing.rows[0].n > 0;

    let recordCount = 0;
    if (hasTables) {
        const counted = await pool.query("select count(*)::int as n from records")
            .catch(() => ({ rows: [{ n: 0 }] }));
        recordCount = counted.rows[0].n;
    }

    await pool.end();

    if (hasTables) {
        console.log("About to drop " + existing.rows[0].n + " tables containing "
            + recordCount + " quality records.");
        console.log("Taking a backup first...");

        const { file } = await backup("pre-reset");
        console.log("  " + file);
        console.log("  Recover with: npm run db:restore");
        console.log("");
    }

    await npmRun("db:schema");
    await npmRun("db:seed");

    /* schema.sql is the baseline. Migrations carry it forward to
       where the code expects it to be, so a rebuilt database and a
       long-lived one end up identical. */
    await npmRun("db:migrate");
    await npmRun("db:passwords");
} catch (error) {
    console.error("Reset failed: " + error.message);
    process.exitCode = 1;
}
