-- ============================================================
-- Evidence for a vendor onboarding stage.
--
-- vendor_onboarding_stages carried a `detail` string and nothing
-- else. A stage is where the evidence lives - the returned
-- questionnaire, the cert copy, the audit report, the PPAP package -
-- so this hangs documents off it, either uploaded directly or linked
-- to a controlled document that already exists.
--
-- `create table if not exists`: migration 021 (the training PR)
-- defines the identical table. Whichever lands first wins and the
-- other is a no-op - the shape is the same either way.
-- ============================================================

create table if not exists vendor_onboarding_documents (
    id                uuid primary key default gen_random_uuid(),
    org_id            uuid not null references organizations(id) on delete cascade,
    stage_id          uuid not null references vendor_onboarding_stages(id) on delete cascade,
    kind              text not null check (kind in ('upload', 'link')),
    original_filename text,
    mime_type         text,
    size_bytes        bigint,
    storage_path      text,
    document_id       uuid references documents(id) on delete set null,
    note              text,
    uploaded_by       uuid references users(id) on delete set null,
    uploaded_at       timestamptz not null default now()
);

create index if not exists idx_onboarding_docs
    on vendor_onboarding_documents (stage_id);
