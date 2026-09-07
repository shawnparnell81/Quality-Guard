-- ============================================================
-- Work orders get a `data` jsonb column, the same way receipts and
-- purchase orders did (migrations 028, 030).
--
-- The work_orders table has a fixed handful of columns - number,
-- part, lot, qty, cell, op counts, status. The Customer Service work
-- order screen needs a place to record the rest (customer, PO
-- reference, due date, priority, ship-to, notes) without a migration
-- per field, and once the form engine can edit field sets those live
-- here too.
-- Idempotent.
-- ============================================================

alter table work_orders
    add column if not exists data jsonb not null default '{}'::jsonb;
