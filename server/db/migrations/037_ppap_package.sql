-- ============================================================
-- PPAP submission package, a twelfth record type - clause 8.3.4.4.
--
-- A PPAP is submitted to a customer at a level (1-5). Level sets
-- which of the 18 AIAG elements have to be on file before it can be
-- submitted. Each element is a slot (ppap_elements, below) that
-- points at the record or controlled document satisfying it - the
-- Control Plan record, the PFMEA, the FAIR for dimensional results,
-- the PSW document - or is marked not applicable with a note.
--
-- One gate, enforced in POST /api/records/:number/transition: the
-- package cannot move to "submitted" until every element the level
-- requires is filled.
--
-- Generic over every organization, matching migrations 026 / 035.
-- scripts/provision-org.js carries the same for new companies.
-- ============================================================

-- ---------- permission ----------

insert into permissions (key, resource, action, description, clause) values
    ('ppap.manage', 'ppap', 'manage', 'Assemble and submit a PPAP package', '8.3.4.4')
on conflict (key) do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'ppap.manage'
  from roles r
 where r.key in (
     'quality_engineer', 'manufacturing_engineer', 'engineering_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- ---------- record type ----------

insert into record_types (org_id, key, name, prefix, clause)
select o.id, 'ppap', 'PPAP Submission', 'PPAP', '8.3.4.4'
  from organizations o
 where not exists (
     select 1 from record_types rt where rt.org_id = o.id and rt.key = 'ppap'
 );

-- ---------- workflow ----------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',      'Draft',              1, false),
        ('assembling', 'Assembling package', 2, false),
        ('submitted',  'Submitted',          3, false),
        ('interim',    'Interim approval',   4, false),
        ('approved',   'Approved',           5, true),
        ('rejected',   'Rejected',           6, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'ppap'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',      'assembling', 'ppap.manage'),
        ('assembling', 'submitted',  'ppap.manage'),   -- gated on required elements
        ('submitted',  'interim',    'ppap.manage'),
        ('submitted',  'approved',   'ppap.manage'),
        ('submitted',  'rejected',   'ppap.manage'),
        ('interim',    'approved',   'ppap.manage'),
        ('interim',    'rejected',   'ppap.manage'),
        ('rejected',   'assembling', 'ppap.manage')    -- rework and resubmit
     ) as v(from_key, to_key, permission)
where rt.key = 'ppap'
on conflict do nothing;

-- ---------- form ----------

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1, '{
  "fields": [
    {"key":"part_number",          "label":"Part number",           "type":"text", "required":true, "section":"Part"},
    {"key":"part_name",            "label":"Part name",             "type":"text", "section":"Part"},
    {"key":"revision",             "label":"Revision / change level","type":"text", "required":true, "section":"Part"},
    {"key":"customer",             "label":"Customer",              "type":"text", "required":true, "section":"Part"},
    {"key":"customer_part_number", "label":"Customer part number",  "type":"text", "section":"Part"},
    {"key":"drawing",              "label":"Drawing / spec no.",    "type":"text", "section":"Part"},

    {"key":"submission_level", "label":"Submission level", "type":"select", "required":true, "section":"Submission",
     "options":["Level 1","Level 2","Level 3","Level 4","Level 5"]},
    {"key":"reason", "label":"Reason for submission", "type":"select", "section":"Submission",
     "options":["Initial submission","Engineering change","Tooling: transfer / replacement / refurbishment",
                "Material or sub-supplier change","Process change","Correction of discrepancy",
                "Annual revalidation","Other"]},
    {"key":"part_weight", "label":"Part weight", "type":"text", "section":"Submission"},
    {"key":"psw_number",  "label":"PSW number",  "type":"text", "section":"Submission"},

    {"key":"submitted_on",         "label":"Submitted on",           "type":"date", "section":"Approval"},
    {"key":"submitted_by",         "label":"Submitted by",           "type":"signature", "section":"Approval"},
    {"key":"customer_disposition", "label":"Customer disposition",   "type":"select", "section":"Approval",
     "options":["Not submitted","Submitted","Interim Approval","Full Approval","Rejected"]},
    {"key":"customer_signoff",     "label":"Customer approver / date","type":"text", "section":"Approval"}
  ],
  "rules": []
}'::jsonb, now()
  from record_types rt
 where rt.key = 'ppap'
on conflict do nothing;

-- ---------- element slots ----------

create table if not exists ppap_elements (
    id             uuid primary key default gen_random_uuid(),
    org_id         uuid not null references organizations(id) on delete cascade,
    record_id      uuid not null references records(id) on delete cascade,
    element        integer not null check (element between 1 and 18),
    reference      text,
    note           text,
    not_applicable boolean not null default false,
    updated_by     uuid references users(id) on delete set null,
    updated_at     timestamptz not null default now(),
    unique (record_id, element)
);

create index if not exists idx_ppap_elements on ppap_elements (record_id, element);
