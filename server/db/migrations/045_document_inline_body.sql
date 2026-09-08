-- ============================================================
-- Documents authored in the app, plus version supersession.
--
-- A document revision has always been an uploaded file (migration
-- 019). Some controlled documents - a short work instruction, a
-- policy statement - are better written in place. A revision may now
-- carry a `body` text instead of a file; the route requires one or
-- the other.
--
-- documents.versioning picks the revision scheme per document:
-- 'letter' (A, B, C - the existing default) or 'numeric' (1.0, 2.0).
--
-- document_revisions.superseded_at is stamped on the previously
-- released revision when its successor is released - so "the old
-- version is obsolete" is a fact recorded on the revision at the
-- moment it becomes true, without disturbing the draft-then-release
-- flow (a drafted revision can still sit unapproved while the
-- released one stays current).
--
-- Idempotent.
-- ============================================================

alter table document_revisions
    add column if not exists body text;

alter table document_revisions
    add column if not exists superseded_at timestamptz;

alter table documents
    add column if not exists versioning text not null default 'letter';

alter table documents
    drop constraint if exists documents_versioning_check;
alter table documents
    add constraint documents_versioning_check check (versioning in ('letter', 'numeric'));
