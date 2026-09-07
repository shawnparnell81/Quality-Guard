-- ============================================================
-- ISO 9001 turtle diagrams, one per department process.
--
-- A turtle is a process box plus six labelled sides: what goes in,
-- what comes out, with what (equipment), with whom (people), how
-- (methods), and how it is measured. It is the artefact an auditor
-- asks for when they want to see a process end to end, so it needs
-- to be editable in the app and printable as a one-pager.
--
-- turtle_diagrams: one header row per (org, department).
-- turtle_entries:  the lines on each side.
-- Idempotent.
-- ============================================================

create table if not exists turtle_diagrams (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    department   text not null,
    process_name text not null,
    process_desc text,
    updated_by   uuid references users(id) on delete set null,
    updated_at   timestamptz not null default now(),
    unique (org_id, department)
);

create table if not exists turtle_entries (
    id          uuid primary key default gen_random_uuid(),
    diagram_id  uuid not null references turtle_diagrams(id) on delete cascade,
    side        text not null check (side in (
                    'inputs', 'outputs', 'resources', 'people', 'methods', 'metrics'
                )),
    text        text not null,
    document_id uuid references documents(id) on delete set null,
    position    integer not null default 0,
    created_at  timestamptz not null default now()
);

create index if not exists idx_turtle_entries on turtle_entries (diagram_id, side, position);

-- ---------- permission ----------
insert into permissions (key, resource, action, description, clause)
values ('turtle.manage', 'turtle', 'manage', 'Edit a department turtle diagram', '4.4')
on conflict (key) do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'turtle.manage'
  from roles r
 where r.key in (
     'quality_manager', 'quality_engineer', 'engineering_manager',
     'manufacturing_engineer', 'production_manager', 'purchasing_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;
