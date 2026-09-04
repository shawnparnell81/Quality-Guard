/* ============================================================
   Database backup.

     npm run db:backup

   Writes a timestamped dump to server/backups/. Run it before
   anything that changes the schema, and before you stop for the day.

   Uses pg_dump rather than dumping rows from Node: it captures the
   schema, the data, sequences, constraints and indexes in a form
   Postgres can restore exactly.
   ============================================================ */

import { spawn } from "node:child_process";
import { mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backupDir = join(here, "..", "backups");

/* pg_dump is not on PATH in a default Windows install, so look where
   the installer actually puts it before giving up. */
function findPgDump(name = "pg_dump") {
    const candidates = [
        name,
        ...["18", "17", "16", "15", "14"].map(
            (v) => "C:\\Program Files\\PostgreSQL\\" + v + "\\bin\\" + name + ".exe"
        ),
        "/usr/bin/" + name,
        "/usr/local/bin/" + name
    ];

    for (const candidate of candidates) {
        if (candidate === name) continue;
        if (existsSync(candidate)) return candidate;
    }

    /* Fall back to the bare name and let spawn decide. */
    return name;
}

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { env: { ...process.env, ...env } });

        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });

        child.on("error", (error) => {
            reject(new Error(
                error.code === "ENOENT"
                    ? "Could not find " + command + ". Is PostgreSQL installed?"
                    : error.message
            ));
        });

        child.on("close", (code) => {
            code === 0 ? resolve() : reject(new Error(stderr.trim() || "exited " + code));
        });
    });
}

export async function backup(label = "manual") {
    await mkdir(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = join(backupDir, "qualityguard-" + stamp + "-" + label + ".sql");

    await run(findPgDump(), [
        "--host=" + process.env.PGHOST,
        "--port=" + (process.env.PGPORT || 5432),
        "--username=" + process.env.PGUSER,
        "--dbname=" + process.env.PGDATABASE,
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "--file=" + file
    ], { PGPASSWORD: process.env.PGPASSWORD });

    const { size } = await stat(file);
    return { file, size };
}

/* Run directly rather than imported. */
if (import.meta.url === "file://" + process.argv[1].replace(/\\/g, "/")
    || process.argv[1].endsWith("backup.js")) {

    try {
        const { file, size } = await backup(process.argv[2] || "manual");
        console.log("Backed up to:");
        console.log("  " + file);
        console.log("  " + (size / 1024).toFixed(1) + " KB");

        const kept = (await readdir(backupDir)).filter((f) => f.endsWith(".sql"));
        console.log("");
        console.log(kept.length + " backup(s) in server/backups/");
    } catch (error) {
        console.error("Backup failed: " + error.message);
        process.exitCode = 1;
    }
}
