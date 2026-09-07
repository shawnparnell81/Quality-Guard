-- ============================================================
-- Record attachments can now carry the file itself, not just a
-- pointer to where it lives.
--
-- The attachments table was metadata only: a filename and a
-- storage_key that had to be typed out - a network path or a link
-- into wherever the org already kept files. Every other upload in
-- the app (drawings, controlled documents, calibration certs,
-- receiving photos) moved to real files under server/storage via
-- file-storage.js; record attachments are the last holdout.
--
-- storage_path holds the file-storage key for an uploaded file.
-- storage_key stays for the older "link to a file elsewhere" rows
-- and is no longer required, so a row can have one or the other.
-- Idempotent.
-- ============================================================

alter table attachments
    add column if not exists storage_path text;

alter table attachments
    alter column storage_key drop not null;

-- A row must carry a file or a link, never neither.
alter table attachments
    drop constraint if exists attachments_has_a_location;
alter table attachments
    add constraint attachments_has_a_location
    check (storage_path is not null or storage_key is not null);
