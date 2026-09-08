/* ============================================================
   Backup: the database and the uploaded files, together.

     npm run db:backup                 full bundle (db + files)
     npm run db:backup -- <label>      name it (default "manual")

   Each run writes one timestamped folder under server/backups/:

     qualityguard-2026-09-08T15-44-18-manual/
       db.sql          pg_dump --clean --if-exists
       storage/        a copy of server/storage/ (attachments,
                       controlled documents, training evidence, ...)
       manifest.json   what this bundle is and what it holds

   A schema dump alone is only half a restore - the rows point at
   files on disk that a plain pg_dump never sees. This captures both
   so a restore is one operation.

   Old bundles are pruned to the newest BACKUP_KEEP (default 14) when
   run from the command line; the safety bundles that migrate/restore
   take are left alone.
   ============================================================ */

import { spawn } from "node:child_process";
import { mkdir, readdir, stat, rm, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const backupDir = join(here, "..", "backups");
const storageRoot = join(here, "..", "storage");

const BUNDLE_VERSION = 1;

/* pg_dump is not on PATH in a default Windows install, so look where
   the installer actually puts it before giving up. */
function findPgTool(name) {
    const candidates = [
        ...["18", "17", "16", "15", "14"].map(
            (v) => "C:\\Program Files\\PostgreSQL\\" + v + "\\bin\\" + name + ".exe"
        ),
        "/usr/bin/" + name,
        "/usr/local/bin/" + name
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return name;   // let spawn resolve it from PATH
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

async function dirSize(root) {
    let total = 0;
    async function walk(d) {
        for (const entry of await readdir(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) await walk(full);
            else total += (await stat(full)).size;
        }
    }
    if (existsSync(root)) await walk(root);
    return total;
}

/* Write one bundle. Pass { skipStorage: true } for a schema-only
   safety copy (files are untouched by a migration). Returns
   { dir, file, size, storageIncluded }. `file` is the db.sql path,
   kept for callers that only care about the dump. */
export async function backup(label = "manual", { skipStorage = false } = {}) {
    await mkdir(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = join(backupDir, "qualityguard-" + stamp + "-" + label);
    await mkdir(dir, { recursive: true });

    const sqlFile = join(dir, "db.sql");
    await run(findPgTool("pg_dump"), [
        "--host=" + process.env.PGHOST,
        "--port=" + (process.env.PGPORT || 5432),
        "--username=" + process.env.PGUSER,
        "--dbname=" + process.env.PGDATABASE,
        "--no-owner",
        "--no-privileges",
        "--clean",
        "--if-exists",
        "--file=" + sqlFile
    ], { PGPASSWORD: process.env.PGPASSWORD });

    let storageIncluded = false;
    let storageBytes = 0;
    if (!skipStorage && existsSync(storageRoot)) {
        await cp(storageRoot, join(dir, "storage"), { recursive: true });
        storageIncluded = true;
        storageBytes = await dirSize(join(dir, "storage"));
    }

    const dbBytes = (await stat(sqlFile)).size;
    const manifest = {
        bundle_version: BUNDLE_VERSION,
        created_at: new Date().toISOString(),
        label,
        database: process.env.PGDATABASE,
        db_bytes: dbBytes,
        storage_included: storageIncluded,
        storage_bytes: storageBytes
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    return { dir, file: sqlFile, size: dbBytes + storageBytes, storageIncluded };
}

/* Every backup bundle, newest first. Legacy flat *.sql dumps from
   before bundles are listed too, so an old backup is still
   restorable. */
export async function listBackups() {
    if (!existsSync(backupDir)) return [];

    const entries = await readdir(backupDir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
        const full = join(backupDir, entry.name);
        if (entry.isDirectory() && existsSync(join(full, "db.sql"))) {
            out.push({ name: entry.name, path: full, kind: "bundle", at: (await stat(full)).mtime });
        } else if (entry.isFile() && entry.name.endsWith(".sql")) {
            out.push({ name: entry.name, path: full, kind: "legacy", at: (await stat(full)).mtime });
        }
    }
    return out.sort((a, b) => b.at - a.at);
}

/* Which entries a "keep the newest N" policy would drop, given a
   newest-first list. Pure, so the retention rule is testable without
   deleting anything. Never drops the single most recent. */
export function bundlesToPrune(newestFirst, keep) {
    return newestFirst.slice(Math.max(Number(keep) || 0, 1));
}

/* Keep the newest `keep`; delete the rest. Returns the names removed. */
export async function prune(keep) {
    const doomed = bundlesToPrune(await listBackups(), keep);
    for (const item of doomed) {
        await rm(item.path, { recursive: true, force: true });
    }
    return doomed.map((d) => d.name);
}

/* Run directly rather than imported. */
if (process.argv[1] && process.argv[1].endsWith("backup.js")) {
    try {
        const { dir, size, storageIncluded } = await backup(process.argv[2] || "manual");
        console.log("Backed up to:");
        console.log("  " + dir);
        console.log("  " + (size / 1024 / 1024).toFixed(2) + " MB"
            + (storageIncluded ? " (database + files)" : " (database only)"));

        const keep = Number(process.env.BACKUP_KEEP) || 14;
        const removed = await prune(keep);
        const remaining = (await listBackups()).length;
        console.log("");
        if (removed.length) console.log("Pruned " + removed.length + " old backup(s).");
        console.log(remaining + " backup(s) kept in server/backups/ (BACKUP_KEEP=" + keep + ")");
    } catch (error) {
        console.error("Backup failed: " + error.message);
        process.exitCode = 1;
    }
}
