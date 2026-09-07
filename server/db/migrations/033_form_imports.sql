-- ============================================================
-- Excel form imports.
--
-- An admin uploads a spreadsheet (a PFMEA, a Control Plan, an 8D
-- template), the server infers a form schema from it, and the admin
-- corrects it before it becomes a record type. This table holds the
-- uploaded file and the schema that was inferred / last edited; the
-- finished schema is applied through the normal record-type routes
-- (POST /api/record-types or PUT /api/record-types/:key/form), which
-- is where it becomes real.
--
-- org_id on every row, like every other table here.
-- Idempotent.
-- ============================================================

create table if not exists imported_forms (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    name          text not null,
    original_name text,
    storage_path  text not null,
    schema        jsonb not null default '{}'::jsonb,
    status        text not null default 'inferred' check (status in ('inferred', 'applied')),
    applied_key   text,
    created_by    uuid references users(id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create index if not exists idx_imported_forms_org
    on imported_forms (org_id, created_at desc);
