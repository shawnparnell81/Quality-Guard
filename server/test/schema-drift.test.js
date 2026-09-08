/* ============================================================
   Schema drift check (P4.2).

   db/schema.snapshot.sql is committed. It must equal the schema you
   get from building a database the canonical way - schema.sql, then
   seed.sql, then every migration in order. If it does not, either a
   migration is missing from the tree or schema.sql was hand-edited;
   either way this test fails and `npm run db:schema-check -- --write`
   is the fix once the change is understood.

   This drives scripts/schema-check.js, which stands up a throwaway
   database ("<PGDATABASE>_schemacheck"), dumps it --schema-only, and
   compares. Needs CREATE DATABASE rights and pg_dump on the box.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--env-file=.env", ...args],
            { cwd: serverRoot, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (c) => { out += c; });
        child.stderr.on("data", (c) => { out += c; });
        child.on("close", (code) => resolve({ code, out }));
    });
}

test("schema.sql + seed + migrations matches db/schema.snapshot.sql", async () => {
    const { code, out } = await run(["scripts/schema-check.js"]);
    assert.equal(code, 0,
        "schema drift detected - run `npm run db:schema-check -- --write` and commit the snapshot.\n\n" + out);
    assert.match(out, /no drift/);
});
