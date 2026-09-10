-- ============================================================
-- Audit automation - generalise the automation trail.
--
-- 054 introduced automation_logs keyed 1:1 to a customer. Internal
-- Audit (records type 'audit') and Layered Process Audit (lpa_audits)
-- now run the same STEPS-registry engine (server/src/audit-automation.js),
-- so the log's subject becomes polymorphic: exactly one of
-- customer_id / record_id / lpa_audit_id is set on every row.
--
-- No new audit tables - the automation reuses the records engine, the
-- lpa_* checklist tables, the di.js audit->DI bridge, and the same
-- numbered-folder / branded-PDF pattern as customer onboarding.
--
-- Idempotent. Written over every organization.
-- ============================================================

-- ---------- automation_logs: one subject, three kinds ----------

alter table automation_logs
    alter column customer_id drop not null;

alter table automation_logs
    add column if not exists record_id uuid references records(id) on delete cascade;

alter table automation_logs
    add column if not exists lpa_audit_id uuid references lpa_audits(id) on delete cascade;

-- Exactly one subject per row. Existing rows all carry customer_id, so
-- the constraint holds without a backfill.
alter table automation_logs
    drop constraint if exists automation_logs_one_subject;
alter table automation_logs
    add constraint automation_logs_one_subject
    check (num_nonnulls(customer_id, record_id, lpa_audit_id) = 1);

create index if not exists idx_automation_logs_record
    on automation_logs (record_id, step, created_at desc)
 where record_id is not null;

create index if not exists idx_automation_logs_lpa_audit
    on automation_logs (lpa_audit_id, step, created_at desc)
 where lpa_audit_id is not null;

-- ---------- LPA audit: where its automation folder tree lives ----------

alter table lpa_audits
    add column if not exists folder_root text;
