/* ============================================================
   Database access.

   One connection pool for the whole process. Every query goes
   through here so there is a single place to add logging, timing
   or a read replica later.
   ============================================================ */

import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    max: 10,
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
   or neither does. */
export async function withTransaction(work) {
    const client = await pool.connect();

    try {
        await client.query("BEGIN");
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
