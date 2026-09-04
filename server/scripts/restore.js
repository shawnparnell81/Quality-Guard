/* ============================================================
   Restore a backup.

     npm run db:restore                    most recent backup
     npm run db:restore -- <path or name>  a specific one
     npm run db:restore -- --list          show what is available

   Takes a safety backup of the CURRENT database first, so restoring
   the wrong file is itself recoverable.
   ============================================================ */

import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { backup } from "./backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const backupDir = join(here, "..", "backups");

function findPsql() {
    const candidates = [
        ...["18", "17", "16", "15", "14"].map(
            (v) => "C:\\Program Files\\PostgreSQL\\" + v + "\\bin\\psql.exe"
        ),
        "/usr/bin/psql",
        "/usr/local/bin/psql"
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }

    return "psql";
}

async function listBackups() {
    if (!existsSync(backupDir)) return [];

    const names = (await readdir(backupDir)).filter((f) => f.endsWith(".sql"));

    const withTimes = await Promise.all(names.map(async (name) => {
        const info = await stat(join(backupDir, name));
        return { name, size: info.size, at: info.mtime };
    }));

    return withTimes.sort((a, b) => b.at - a.at);
}

const argument = process.argv[2];

if (argument === "--list") {
    const items = await listBackups();

    if (items.length === 0) {
        console.log("No backups yet. Run: npm run db:backup");
    } else {
        console.log(items.length + " backup(s), newest first:");
        for (const item of items) {
            console.log("  " + item.at.toISOString().slice(0, 19).replace("T", " ")
                + "  " + String((item.size / 1024).toFixed(0)).padStart(6) + " KB"
                + "  " + item.name);
        }
    }
    process.exit(0);
}

try {
    let file;

    if (argument) {
        file = isAbsolute(argument) ? argument : join(backupDir, argument);
        if (!existsSync(file)) throw new Error("No such backup: " + file);
    } else {
        const items = await listBackups();
        if (items.length === 0) throw new Error("No backups found. Run: npm run db:backup");
        file = join(backupDir, items[0].name);
        console.log("Using most recent backup: " + items[0].name);
    }

    /* Restoring replaces everything. Capture what is there now, so a
       wrong choice here is not the end of the story. */
    console.log("Taking a safety backup of the current database first...");
    const safety = await backup("pre-restore");
    console.log("  saved to " + safety.file);
    console.log("");

    console.log("Restoring...");

    await new Promise((resolve, reject) => {
        const child = spawn(findPsql(), [
            "--host=" + process.env.PGHOST,
            "--port=" + (process.env.PGPORT || 5432),
            "--username=" + process.env.PGUSER,
            "--dbname=" + process.env.PGDATABASE,
            "--quiet",
            "--file=" + file
        ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD } });

        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });

        child.on("error", (error) => reject(new Error(error.message)));
        child.on("close", (code) => {
            /* psql reports notices on stderr even when everything
               worked, so only the exit code decides. */
            code === 0 ? resolve() : reject(new Error(stderr.trim() || "exited " + code));
        });
    });

    console.log("Restored from " + file);
} catch (error) {
    console.error("Restore failed: " + error.message);
    process.exitCode = 1;
}
