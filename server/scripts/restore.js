/* ============================================================
   Restore a backup bundle - the database and the uploaded files.

     npm run db:restore                    most recent bundle
     npm run db:restore -- <name or path>  a specific one
     npm run db:restore -- --list          show what is available

   A full safety bundle of the CURRENT state is taken first, so
   restoring the wrong one is itself recoverable. The existing
   server/storage/ is moved aside (not deleted) before the bundle's
   files are put in its place.

   Bundles are the folders backup.js writes (db.sql + storage/ +
   manifest.json). A bare *.sql file from before bundles still
   restores - just without any file swap.
   ============================================================ */

import { spawn } from "node:child_process";
import { rename, cp, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, listBackups } from "./backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const backupDir = join(here, "..", "backups");
const storageRoot = join(here, "..", "storage");

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

function psql(sqlFile) {
    return new Promise((resolve, reject) => {
        const child = spawn(findPsql(), [
            "--host=" + process.env.PGHOST,
            "--port=" + (process.env.PGPORT || 5432),
            "--username=" + process.env.PGUSER,
            "--dbname=" + process.env.PGDATABASE,
            "--quiet",
            "--set=ON_ERROR_STOP=on",
            "--file=" + sqlFile
        ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD } });

        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => reject(new Error(error.message)));
        child.on("close", (code) => {
            /* psql prints notices on stderr even on success, so the
               exit code is what decides. */
            code === 0 ? resolve() : reject(new Error(stderr.trim() || "psql exited " + code));
        });
    });
}

if (process.argv[2] === "--list") {
    const items = await listBackups();
    if (items.length === 0) {
        console.log("No backups yet. Run: npm run db:backup");
    } else {
        console.log(items.length + " backup(s), newest first:");
        for (const item of items) {
            console.log("  " + item.at.toISOString().slice(0, 19).replace("T", " ")
                + "  " + item.kind.padEnd(6) + "  " + item.name);
        }
    }
    process.exit(0);
}

try {
    const argument = process.argv[2];
    let target;

    if (argument) {
        const path = isAbsolute(argument) ? argument : join(backupDir, argument);
        if (!existsSync(path)) throw new Error("No such backup: " + path);
        target = {
            path,
            kind: statSync(path).isDirectory() ? "bundle" : "legacy",
            name: argument
        };
    } else {
        const items = await listBackups();
        if (items.length === 0) throw new Error("No backups found. Run: npm run db:backup");
        target = items[0];
        console.log("Using most recent backup: " + target.name);
    }

    const sqlFile = target.kind === "bundle" ? join(target.path, "db.sql") : target.path;
    if (!existsSync(sqlFile)) throw new Error("Bundle has no db.sql: " + target.path);

    let manifest = null;
    if (target.kind === "bundle" && existsSync(join(target.path, "manifest.json"))) {
        manifest = JSON.parse(await readFile(join(target.path, "manifest.json"), "utf8"));
    }

    console.log("Taking a full safety backup of the current state first...");
    const safety = await backup("pre-restore");
    console.log("  " + safety.dir);
    console.log("");

    console.log("Restoring the database...");
    await psql(sqlFile);

    const bundleStorage = target.kind === "bundle" ? join(target.path, "storage") : null;
    if (bundleStorage && existsSync(bundleStorage)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        if (existsSync(storageRoot)) {
            const aside = storageRoot + ".replaced-" + stamp;
            await rename(storageRoot, aside);
            console.log("Moved current files aside to " + aside);
        }
        await cp(bundleStorage, storageRoot, { recursive: true });
        console.log("Restored uploaded files from the bundle.");
    } else if (target.kind === "bundle" && manifest && !manifest.storage_included) {
        console.log("This bundle is database-only; uploaded files left as they are.");
    } else if (target.kind === "legacy") {
        console.log("Legacy dump: database restored, no file swap.");
    }

    console.log("");
    console.log("Restored from " + target.path);
} catch (error) {
    console.error("Restore failed: " + error.message);
    process.exitCode = 1;
}
