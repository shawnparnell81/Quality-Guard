/* ============================================================
   Runs a .sql file against the configured database.

     npm run db:schema
     npm run db:seed
     npm run db:reset     (schema then seed)

   Kept deliberately small. When the project outgrows this, replace
   it with a real migration tool rather than growing this script.
   ============================================================ */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../src/db.js";

const file = process.argv[2];

if (!file) {
    console.error("Usage: node scripts/run-sql.js <path-to-file.sql>");
    process.exit(1);
}

const path = resolve(process.cwd(), file);

try {
    const sql = await readFile(path, "utf8");

    console.log("Running " + file + " against " + process.env.PGDATABASE + " ...");
    await pool.query(sql);
    console.log("Done.");
} catch (error) {
    console.error("Failed: " + error.message);
    if (error.position) {
        console.error("At character position " + error.position);
    }
    process.exitCode = 1;
} finally {
    await pool.end();
}
