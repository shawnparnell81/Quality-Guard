/* ============================================================
   Database access.

   One connection pool for the whole process. Every query goes
   through here so there is a single place to add logging, timing
   or a read replica later.
   ============================================================ */

import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const { Pool } = pg;

/* Carries the signed-in user through a request's async call chain so
   a transaction can tell the database who is making the change. An
   Express middleware (app.js) opens the store per request; the DB
   trigger record_audit reads it via current_setting('app.user_id').
   Outside a request (a script, a test's direct query) the store is
   empty and the change is logged with no user - which is the point. */
export const requestContext = new AsyncLocalStorage();

export const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    /* PGPOOL_MAX overrides; production gets 10, and dev / the test
       suite (which runs dozens of app processes at once, each also
       holding one LISTEN connection) get a smaller pool so Postgres'
       connection limit is not the thing that breaks. */
    max: Number(process.env.PGPOOL_MAX)
        || (process.env.NODE_ENV === "production" ? 10 : 5),
    idleTimeoutMillis: 30000
});

pool.on("error", (error) => {
    console.error("Unexpected database pool error:", error.message);
});

export function query(text, params) {
    return pool.query(text, params);
}

/* Runs a set of statements inside a transaction. Used anywhere a
   write has to be paired with its audit_log rows: either both land
   or neither does.

   If a request context is in scope, the signed-in user's id is set
   as a transaction-local GUC so the record_audit trigger can record
   who made the change. set_config(..., true) is transaction-scoped,
   so it reverts on COMMIT/ROLLBACK and never leaks to the next
   borrower of this pooled connection. */
export async function withTransaction(work) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
        const userId = requestContext.getStore()?.userId;
        if (userId) {
            await client.query("select set_config('app.user_id', $1, true)", [String(userId)]);
        }
        const result = await work(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
