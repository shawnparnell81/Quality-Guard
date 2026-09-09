-- ============================================================
-- Asynchronous exports (audit M9).
--
-- A big PDF or a 9-tab template fill runs pdfkit / exceljs on the
-- request thread and blocks the event loop for everyone else. This
-- table is the queue: a heavy export is enqueued here, a worker loop
-- (concurrency 2, server/src/export-jobs.js) claims a row with FOR
-- UPDATE SKIP LOCKED so any instance can process any job, generates
-- the file, stores it, and NOTIFYs "ready" on the change bus.
--
-- Small exports still run synchronously - nothing about the common
-- case changes.
-- Idempotent.
-- ============================================================

create table if not exists export_jobs (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    requested_by  uuid references users(id) on delete set null,
    kind          text not null check (kind in ('record_pdf', 'record_excel')),
    params        jsonb not null default '{}'::jsonb,
    status        text not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'error')),
    filename      text,
    content_type  text,
    storage_path  text,
    error         text,
    created_at    timestamptz not null default now(),
    started_at    timestamptz,
    finished_at   timestamptz
);

create index if not exists idx_export_jobs_claim
    on export_jobs (created_at)
    where status = 'queued';

create index if not exists idx_export_jobs_org
    on export_jobs (org_id, created_at desc);
