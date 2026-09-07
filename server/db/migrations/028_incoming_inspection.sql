-- ============================================================
-- Incoming Material Inspection - a real receiving inspection form.
--
-- The receipts row was thin: number, PO, part, qty, a pending/accept/
-- reject status and a note. Warehouse receiving needs the whole ISO
-- 8.4.2 check - supplier identification, packaging condition, visual
-- inspection, documentation verification, a proper disposition.
--
-- Rather than 40 new columns (every future field a migration), the
-- form payload lives in `data`, the same shape records.data uses.
-- Two flags get their own columns because the register filters on
-- them; ncr_number links a rejected receipt to the NCR it raised.
-- Idempotent.
-- ============================================================

alter table receipts
    add column if not exists data        jsonb   not null default '{}'::jsonb,
    add column if not exists quarantined  boolean not null default false,
    add column if not exists ncr_number   text;
