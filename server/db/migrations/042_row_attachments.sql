-- ============================================================
-- Per-row attachments for table fields.
--
-- Attachments were record-level only: a photo belonged to the NCR,
-- not to one line of its containment table. Real quality forms need
-- the finer grain - a picture of the defect on FAIR characteristic
-- 14, an ILAC cert against 8D containment action 3.
--
-- row_ref is null for every attachment that exists today (a plain
-- record-level file, unchanged) and "<fieldKey>:<rowId>" for one
-- pinned to a specific table row. The rowId is the stable "_id" the
-- API stamps onto each table row in records.data. No foreign key -
-- the target lives inside a jsonb document, not another table.
-- Idempotent.
-- ============================================================

alter table attachments
    add column if not exists row_ref text;
