-- ============================================================
-- Two read-only screens get a way to write.
--
-- Training: the competency matrix and the gaps list have always
-- been computed at read time, and there was no route that recorded a
-- training completion at all. These columns give a training_record
-- somewhere to keep who ran the training and the sign-off sheet, so
-- one can actually be opened and reviewed.
--
-- Onboarding: vendor_onboarding_stages carried a `detail` string and
-- nothing else. A stage is where evidence lives - the returned
-- questionnaire, the cert copy, the audit report, the PPAP package -
-- so this adds a child table it can hang documents from, either
-- uploaded here or linked to a controlled document that already
-- exists.
--
-- Idempotent throughout.
-- ============================================================

-- ---------- training_records: who trained, and the evidence ----------

alter table training_records add column if not exists trained_by        uuid references users(id) on delete set null;
alter table training_records add column if not exists evidence_path     text;
alter table training_records add column if not exists evidence_filename text;
alter table training_records add column if not exists notes             text;

-- The unique(user_id, document_id) constraint stays: recording a
-- person on a document again updates that row. A full session-by-
-- session history is a later change.

-- ---------- vendor_onboarding_documents ----------
-- One row per document attached to an onboarding stage. `kind`
-- decides which half of the row is used: an uploaded file
-- (storage_path et al) or a link to a controlled document
-- (document_id).

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
