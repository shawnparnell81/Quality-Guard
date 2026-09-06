-- ============================================================
-- Periodic supplier re-evaluation, clause 8.4.1.
--
-- Distinct from the live PPM/grade in vendor-scoring.js, which is a
-- rolling number recomputed from receiving history on every read.
-- This is the other half of 8.4.1: a documented, dated review - "we
-- looked at this supplier on this day and it scored X, with N
-- non-conformances" - the record an auditor actually asks to see.
-- Nothing computes this; someone conducts the review and enters it.
--
-- No separate org_id, same as vendor_onboarding_stages: this is a
-- child of exactly one vendor, and a vendor is already tenant-scoped,
-- so every query reaches org_id through vendor_id same as that table
-- does.
-- ============================================================

create table if not exists vendor_evaluations (
    id                    uuid primary key default gen_random_uuid(),
    vendor_id             uuid not null references vendors(id) on delete cascade,
    audit_date            date not null,
    performance_score     numeric(5,2),
    non_conformance_count integer not null default 0,
    notes                 text,
    evaluated_by          uuid references users(id) on delete set null,
    created_at            timestamptz not null default now()
);

create index if not exists idx_vendor_evaluations_vendor
    on vendor_evaluations (vendor_id, audit_date desc);
