-- ============================================================
-- Real files for controlled documents.
--
-- documents/document_revisions have existed since the base schema -
-- doc number, title, owner, current revision, a real status
-- lifecycle (draft/in_approval/released/obsolete), and a revision
-- table with change_summary/author/approved_by/effective_date. All
-- of it has been read-only: there has never been a way to create a
-- document, add a revision, or get the actual file back. This is
-- the schema half of making that real.
--
-- storage_path is not null on purpose: a document_revisions row with
-- no file behind it is not a real revision of anything, it is a
-- change_summary with nothing to change. The file's actual bytes
-- live on disk (server/storage/documents/<uuid>.<ext>), named by a
-- generated id rather than the person's own filename, so nothing a
-- client uploads can collide with another file or escape that
-- directory - original_filename is kept separately for exactly what
-- a download should call the file, which is a different job from
-- what it should be named on disk.
--
-- record_id is nullable and new: a document can now optionally
-- belong to a specific record (an APQP program, an 8D investigation)
-- so the real FMEA/Control Plan/Process Flow/8D file someone
-- actually attaches shows up on that record's own detail view, not
-- only in the general document library.
-- ============================================================

alter table documents
    add column if not exists record_id uuid references records(id) on delete set null;

alter table document_revisions
    add column if not exists original_filename text,
    add column if not exists mime_type         text,
    add column if not exists size_bytes        bigint,
    add column if not exists storage_path      text;

-- Existing seed revisions (QM-001, SOP-0102, WI-0412) predate real file
-- storage and have no file behind them - not backfilled with a fake one.
-- The not-null constraint below only binds new rows going forward
-- (validate at insert time in the API, not with a table-wide not null
-- that would reject the very seed data this project already ships).
comment on column document_revisions.storage_path is
    'Path under server/storage/documents/ where this revision''s real file lives. Required for every revision created through the API; historical seed revisions predate real file storage and may have none.';
