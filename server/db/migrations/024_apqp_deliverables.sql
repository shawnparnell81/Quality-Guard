-- ============================================================
-- APQP is its deliverables.
--
-- An APQP program moves through five phases; what actually carries
-- the process is three controlled documents - the Process Flow
-- Diagram, the FMEA, and the Control Plan. This table names which
-- linked controlled document fills each slot for a program, so the
-- screen can show them, open them, and gate Phase 3 on them instead
-- of a typed-in "moving to next phase" note.
--
-- documents.record_id (migration 019) already links a controlled
-- document to a record; this adds the slot on top. One document per
-- slot per program.
-- ============================================================

create table if not exists apqp_deliverables (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    record_id   uuid not null references records(id) on delete cascade,
    slot        text not null check (slot in ('process_flow', 'fmea', 'control_plan')),
    document_id uuid not null references documents(id) on delete cascade,
    added_by    uuid references users(id) on delete set null,
    added_at    timestamptz not null default now(),
    unique (record_id, slot)
);

create index if not exists idx_apqp_deliverables on apqp_deliverables (record_id);
