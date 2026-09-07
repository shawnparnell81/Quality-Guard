-- ============================================================
-- Discrepancy Investigation, a tenth record type - the bridge
-- between an internal audit finding (clause 9.2) and the corrective
-- machinery (8.7 / 10.2).
--
-- A DI is raised from an audit that turned up a discrepancy. It runs
-- its own four-state workflow and carries the three completed forms
-- the finding requires - the NCR form, the 8D report, the CAPA form -
-- as controlled documents in named slots (di_deliverables, below),
-- the same shape APQP carries its Process Flow / FMEA / Control Plan.
-- The forms themselves are the ones already in Document Control:
-- filled out, uploaded, attached here. When those move to in-app
-- editable forms later, a slot gains a linked-record option and none
-- of this changes.
--
-- Two gates, both enforced in POST /api/records/:number/transition:
--   * a DI cannot close until all three form slots are filled;
--   * an audit cannot close until its DI is closed.
--
-- Written generically over every organization, matching migrations
-- 010-013's style.
-- ============================================================

-- ---------- permissions ----------

insert into permissions (key, resource, action, description, clause) values
    ('di.read',   'di', 'read',   'View discrepancy investigations',                 '9.2'),
    ('di.manage', 'di', 'manage', 'Raise a DI and record its investigation',         '9.2'),
    ('di.close',  'di', 'close',   'Close a discrepancy investigation',              '9.2')
on conflict (key) do nothing;

-- Reading a DI: the quality and engineering people who work findings.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'di.read'
  from roles r
 where r.key in (
     'quality_inspector', 'quality_tech', 'quality_engineer',
     'manufacturing_engineer', 'engineering_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- Running the investigation: same cross-functional set that carries
-- apqp.manage / capa.create elsewhere.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'di.manage'
  from roles r
 where r.key in (
     'quality_engineer', 'manufacturing_engineer', 'engineering_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- Closing the investigation: the Quality Manager and the General
-- Manager only. Deliberately narrower than di.manage - closing a DI
-- signs off that the audit finding is resolved.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'di.close'
  from roles r
 where r.key in ('quality_manager', 'general_manager')
 on conflict do nothing;

-- ---------- record type ----------

insert into record_types (org_id, key, name, prefix, clause)
select o.id, 'di', 'Discrepancy Investigation', 'DI', '9.2'
  from organizations o
 where not exists (
     select 1 from record_types rt where rt.org_id = o.id and rt.key = 'di'
 );

-- ---------- workflow: open -> investigating -> awaiting forms -> closed ----------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('open',           'Open',                      1, false),
        ('investigating',  'Investigating',             2, false),
        ('linked_closure', 'Awaiting form closure',     3, false),
        ('closed',         'Closed',                    4, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'di'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('open',           'investigating',  'di.manage'),
        ('investigating',  'linked_closure', 'di.manage'),
        ('linked_closure', 'investigating',  'di.manage'),   -- reopen for more work
        ('linked_closure', 'closed',         'di.close')
     ) as v(from_key, to_key, permission)
where rt.key = 'di'
on conflict do nothing;

-- ---------- form ----------

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1, '{
    "fields": [
        {"key":"department",      "label":"Department under review",   "type":"text", "required":true},
        {"key":"finding",         "label":"What the audit found",      "type":"memo", "required":true},
        {"key":"investigator",    "label":"Investigator",              "type":"text"},
        {"key":"root_cause",      "label":"Root cause",                "type":"memo"},
        {"key":"containment",     "label":"Containment / interim action","type":"memo"},
        {"key":"corrective_plan", "label":"Corrective plan",           "type":"memo"}
    ],
    "rules": []
}'::jsonb, now()
  from record_types rt
 where rt.key = 'di'
on conflict do nothing;

-- ---------- form slots ----------
-- One controlled document per slot per DI: the completed NCR form,
-- the completed 8D report, the completed CAPA form. documents.record_id
-- (migration 019) already links a controlled document to a record;
-- this names which linked document fills which slot.

create table if not exists di_deliverables (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    record_id   uuid not null references records(id) on delete cascade,
    slot        text not null check (slot in ('ncr', 'eightd', 'capa')),
    document_id uuid not null references documents(id) on delete cascade,
    added_by    uuid references users(id) on delete set null,
    added_at    timestamptz not null default now(),
    unique (record_id, slot)
);

create index if not exists idx_di_deliverables on di_deliverables (record_id);
