-- ============================================================
-- Engineering can upload its own files.
--
-- The app has no CAD tool, so a drawing revision needs to carry the
-- actual file - the PDF, the DXF, the STEP - the same way a controlled
-- document revision already does (migration 019). And engineers need
-- somewhere of their own to keep specs, calculations and standards:
-- a `category` on documents lets the Engineering Documents screen show
-- just those without a second document store.
--
-- All columns nullable; existing rows keep working unchanged.
-- Idempotent.
-- ============================================================

alter table drawing_revisions
    add column if not exists original_filename text,
    add column if not exists mime_type         text,
    add column if not exists size_bytes         bigint,
    add column if not exists storage_path       text;

alter table documents
    add column if not exists category text;

create index if not exists idx_documents_category on documents (org_id, category);
