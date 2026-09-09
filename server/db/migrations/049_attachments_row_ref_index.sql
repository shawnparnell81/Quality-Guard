-- ============================================================
-- Index the per-row attachment lookup (audit M5).
--
-- attachments.row_ref ("<fieldKey>:<rowId>") was added in migration
-- 042 with no index. "Which files are pinned to this table row" and
-- "how many attachments does each row have" are per-record-detail
-- reads that otherwise scan every attachment on the record.
--
-- Partial: row_ref is null for the vast majority of attachments
-- (plain record-level files), so the index only carries the rows
-- that actually use the feature.
-- Idempotent.
-- ============================================================

create index if not exists idx_attachments_row_ref
    on attachments (record_id, row_ref)
    where row_ref is not null;
