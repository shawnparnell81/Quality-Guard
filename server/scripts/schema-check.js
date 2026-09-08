/* ============================================================
   Schema drift check (P4.2).

     npm run db:schema-check            fail if the schema drifted
     npm run db:schema-check -- --write regenerate the snapshot

   Builds a throwaway database the canonical way - db/schema.sql,
   db/seed.sql, then every migration in order (the early migrations
   carry demo data that references the seed org) - dumps its schema,
   and compares that to the committed snapshot at
   db/schema.snapshot.sql. The dump is --schema-only, so no seed or
   migration rows land in the snapshot.

   It catches the things that quietly rot a schema: a migration that
   was written but never committed, a hand edit to schema.sql that no
   migration reflects, two migrations that disagree. A drift shows up
   as a failing check in the PR, with the fix being "run --write and
   commit the snapshot" once the change is understood.
   ============================================================ */

import pg from "pg";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = join(here, "..", "db");
const migrationsDir = join(dbDir, "migrations");
const snapshotFile = join(dbDir, "schema.snapshot.sql");

const scratchDb = (process.env.PGDATABASE || "qualityguard") + "_schemacheck";
const write = process.argv.includes("--write");

const conn = (database) => ({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database
});

function findPgDump() {
    const candidates = [
        ...["18", "17", "16", "15", "14"].map(
            (v) => "C:\\Program Files\\PostgreSQL\\" + v + "\\bin\\pg_dump.exe"),
        "/usr/bin/pg_dump", "/usr/local/bin/pg_dump"
    ];
    for (const c of candidates) if (existsSync(c)) return c;
    return "pg_dump";
}

function pgDumpSchema(database) {
    return new Promise((resolve, reject) => {
        const child = spawn(findPgDump(), [
            "--host=" + process.env.PGHOST,
            "--port=" + (process.env.PGPORT || 5432),
            "--username=" + process.env.PGUSER,
            "--dbname=" + database,
            "--schema-only", "--no-owner", "--no-privileges", "--schema=public"
        ], { env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD } });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => { stdout += c; });
        child.stderr.on("data", (c) => { stderr += c; });
        child.on("error", (e) => reject(new Error(
            e.code === "ENOENT" ? "pg_dump not found. Is PostgreSQL installed?" : e.message)));
        child.on("close", (code) => code === 0
            ? resolve(stdout)
            : reject(new Error(stderr.trim() || "pg_dump exited " + code)));
    });
}

/* Strip the noise a dump carries that is not schema: comments, blank
   lines, session GUC sets, and pg 16+/18's \restrict guard whose
   token is random per run. */
function normalise(dump) {
    return dump
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line !== "")
        .filter((line) => !line.startsWith("--"))
        .filter((line) => !line.startsWith("SET "))
        .filter((line) => !line.startsWith("SELECT pg_catalog.set_config"))
        .filter((line) => !line.startsWith("\\restrict"))
        .filter((line) => !line.startsWith("\\unrestrict"))
        .join("\n")
        .trim() + "\n";
}

async function buildScratch() {
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query('drop database if exists "' + scratchDb + '"');
    await admin.query('create database "' + scratchDb + '"');
    await admin.end();

    const db = new pg.Client(conn(scratchDb));
    await db.connect();
    try {
        await db.query(await readFile(join(dbDir, "schema.sql"), "utf8"));
        await db.query(await readFile(join(dbDir, "seed.sql"), "utf8"));

        const migrations = (await readdir(migrationsDir))
            .filter((n) => n.endsWith(".sql")).sort();
        for (const name of migrations) {
            await db.query(await readFile(join(migrationsDir, name), "utf8"));
        }
    } finally {
        await db.end();
    }
}

async function dropScratch() {
    const admin = new pg.Client(conn("postgres"));
    await admin.connect();
    await admin.query('drop database if exists "' + scratchDb + '"');
    await admin.end();
}

function firstDifference(a, b) {
    const la = a.split("\n");
    const lb = b.split("\n");
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) {
            return { line: i + 1, expected: la[i] ?? "(nothing)", actual: lb[i] ?? "(nothing)" };
        }
    }
    return null;
}

try {
    await buildScratch();
    const fresh = normalise(await pgDumpSchema(scratchDb));
    await dropScratch();

    if (write) {
        await writeFile(snapshotFile, fresh);
        console.log("Wrote db/schema.snapshot.sql (" + fresh.split("\n").length + " lines).");
        process.exit(0);
    }

    if (!existsSync(snapshotFile)) {
        console.error("No snapshot yet. Create it with:  npm run db:schema-check -- --write");
        process.exit(1);
    }

    const snapshot = (await readFile(snapshotFile, "utf8")).replace(/\r\n/g, "\n");
    if (snapshot === fresh) {
        console.log("Schema matches db/schema.snapshot.sql - no drift.");
        process.exit(0);
    }

    const diff = firstDifference(snapshot, fresh);
    console.error("Schema DRIFT: db/schema.snapshot.sql does not match schema.sql + migrations.");
    if (diff) {
        console.error("  first difference at line " + diff.line + ":");
        console.error("    snapshot: " + diff.expected);
        console.error("    fresh:    " + diff.actual);
    }
    console.error("");
    console.error("If the change is intended, run:  npm run db:schema-check -- --write");
    console.error("and commit db/schema.snapshot.sql with your migration.");
    process.exit(1);
} catch (error) {
    console.error("Schema check failed: " + error.message);
    await dropScratch().catch(() => {});
    process.exitCode = 1;
}
