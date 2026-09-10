/* ============================================================
   Asynchronous export queue (audit M9).

   A big PDF or template fill runs pdfkit / exceljs on the request
   thread. Small exports still do that - it is fast and simplest. A
   heavy one is enqueued in export_jobs (migration 052) and a worker
   loop generates it off the request's critical path, at a bounded
   concurrency, so a burst of large exports cannot pin the event
   loop. Any instance can process any job (FOR UPDATE SKIP LOCKED),
   and "ready" is pushed on the same change bus the SSE feed uses.

   A route registers how to build each kind:
       registerExporter("record_pdf", async (params) =>
           ({ buffer, filename, contentType }))
   ============================================================ */

import { query } from "./db.js";
import { log } from "./logger.js";
import { publish, listenOn } from "./stream.js";
import { saveUploadedFile, readUploadedFile } from "./file-storage.js";

const WAKE_CHANNEL = "qms_export_wake";
const EXPORT_EXTS = [".pdf", ".xlsx"];
const MAX_CONCURRENT = Number(process.env.EXPORT_WORKER_CONCURRENCY) > 0
    ? Number(process.env.EXPORT_WORKER_CONCURRENCY) : 2;

const runners = new Map();

export function registerExporter(kind, fn) {
    runners.set(kind, fn);
}

/* ---------- queue API ---------- */

export async function enqueueExport(orgId, userId, kind, params) {
    const row = await query(`
        insert into export_jobs (org_id, requested_by, kind, params)
        values ($1, $2, $3, $4)
        returning id
    `, [orgId, userId || null, kind, JSON.stringify(params || {})]);

    query("select pg_notify($1, '')", [WAKE_CHANNEL]).catch(() => { /* the poll will get it */ });
    pump();   // this instance can start on it right away
    return { id: row.rows[0].id };
}

/* Scoped to the person who asked for it, not just their organization:
   the file is a whole record rendered out, so a colleague who may not
   read that record's type must not be able to fetch it by job id
   either. */
export async function getJob(orgId, userId, id) {
    const row = await query(`
        select id, kind, status, filename, content_type, error,
               created_at, started_at, finished_at,
               (storage_path is not null) as has_file
          from export_jobs
         where id = $1 and org_id = $2 and requested_by = $3
    `, [id, orgId, userId]);
    return row.rows[0] || null;
}

export async function readJobFile(orgId, userId, id) {
    const row = await query(`
        select storage_path, filename, content_type from export_jobs
         where id = $1 and org_id = $2 and requested_by = $3 and status = 'done'
    `, [id, orgId, userId]);
    if (row.rowCount === 0) return null;
    const buffer = await readUploadedFile(row.rows[0].storage_path);
    return { buffer, filename: row.rows[0].filename, contentType: row.rows[0].content_type };
}

/* ---------- worker ---------- */

let inFlight = 0;
let pumping = false;

async function claimOne() {
    const row = await query(`
        update export_jobs
           set status = 'running', started_at = now()
         where id = (
            select id from export_jobs
             where status = 'queued'
             order by created_at
             for update skip locked
             limit 1
         )
        returning id, org_id, requested_by, kind, params
    `);
    return row.rows[0] || null;
}

async function runJob(job) {
    const runner = runners.get(job.kind);
    try {
        if (!runner) throw new Error("no exporter registered for " + job.kind);
        const { buffer, filename, contentType } = await runner(job.params);
        const storagePath = await saveUploadedFile("exports", EXPORT_EXTS, filename, buffer);
        await query(`
            update export_jobs
               set status = 'done', storage_path = $2, filename = $3,
                   content_type = $4, finished_at = now(), error = null
             where id = $1
        `, [job.id, storagePath, filename, contentType]);
        publish(job.org_id, { entity: "export", id: job.id, action: "ready" });
    } catch (error) {
        log.warn("export_job_failed", { id: job.id, kind: job.kind, err: error });
        await query(
            "update export_jobs set status = 'error', error = $2, finished_at = now() where id = $1",
            [job.id, String(error.message || error)]);
        publish(job.org_id, { entity: "export", id: job.id, action: "failed" });
    }
}

/* Claim and run until the queue is empty or we are at capacity. */
async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (inFlight < MAX_CONCURRENT) {
            const job = await claimOne();
            if (!job) break;
            inFlight += 1;
            runJob(job).finally(() => {
                inFlight -= 1;
                setImmediate(pump);
            });
        }
    } catch (error) {
        log.warn("export_pump_error", { err: error });
    } finally {
        pumping = false;
    }
}

let pollTimer = null;

export function startExportWorker() {
    /* the shared LISTEN connection wakes us the moment a job lands on
       any instance */
    listenOn(WAKE_CHANNEL, () => pump());
    /* a slow poll as a safety net (a job enqueued while the shared
       listener was mid-reconnect) */
    pollTimer = setInterval(() => pump(), 10000);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
    pump();
}

export async function stopExportWorker() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}
