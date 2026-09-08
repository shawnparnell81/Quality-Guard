-- ============================================================
-- First Article Inspection Report (FAIR), an eleventh record type -
-- clause 8.5.1 / AS9102. Promotes the imported "Dimensional Report"
-- into a first-class record: a part / revision header, a ballooned
-- characteristic table (nominal, tolerance, method, actual), an
-- overall disposition, and its own five-state workflow.
--
-- Each measured characteristic's Pass / Fail is derived, not typed:
-- POST/PATCH /api/records fills in the "result" column and the
-- conforming counts from nominal + [tol_minus, tol_plus] vs actual,
-- so the screen, the PDF and any report all read the same number
-- (the same guarantee withComputedRpn gives a risk's RPN).
--
-- Written generically over every organization, matching migrations
-- 013 / 026's style. scripts/provision-org.js carries the same
-- record type, workflow and form for newly provisioned companies.
-- ============================================================

-- ---------- permissions ----------

insert into permissions (key, resource, action, description, clause) values
    ('fair.read',   'fair', 'read',   'View first article inspection reports',       '8.5.1'),
    ('fair.manage', 'fair', 'manage', 'Raise a FAIR, record and disposition it',     '8.5.1')
on conflict (key) do nothing;

-- Reading a FAIR: quality and the engineers who consume first articles.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'fair.read'
  from roles r
 where r.key in (
     'quality_inspector', 'quality_tech', 'quality_engineer',
     'manufacturing_engineer', 'engineering_manager', 'production_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- Doing the inspection: the people who actually measure parts.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'fair.manage'
  from roles r
 where r.key in (
     'quality_inspector', 'quality_tech', 'quality_engineer',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- ---------- record type ----------

insert into record_types (org_id, key, name, prefix, clause)
select o.id, 'fair', 'First Article Inspection', 'FAIR', '8.5.1'
  from organizations o
 where not exists (
     select 1 from record_types rt where rt.org_id = o.id and rt.key = 'fair'
 );

-- ---------- workflow: draft -> in progress -> complete -> approved / rejected ----------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',       'Draft',       1, false),
        ('in_progress', 'In progress', 2, false),
        ('complete',    'Complete',    3, false),
        ('approved',    'Approved',    4, true),
        ('rejected',    'Rejected',    5, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'fair'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',       'in_progress', 'fair.manage'),
        ('in_progress', 'complete',    'fair.manage'),
        ('complete',    'in_progress', 'fair.manage'),   -- reopen for rework
        ('complete',    'approved',    'fair.manage'),
        ('complete',    'rejected',    'fair.manage')
     ) as v(from_key, to_key, permission)
where rt.key = 'fair'
on conflict do nothing;

-- ---------- form ----------

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1, '{
  "fields": [
    {"key":"part_number", "label":"Part number",            "type":"text", "required":true, "section":"Part"},
    {"key":"part_name",   "label":"Part name",               "type":"text", "section":"Part"},
    {"key":"revision",    "label":"Revision",                "type":"text", "required":true, "section":"Part"},
    {"key":"drawing",     "label":"Drawing / spec no.",      "type":"text", "section":"Part"},
    {"key":"customer",    "label":"Customer",                "type":"text", "section":"Part"},
    {"key":"po_number",   "label":"Customer PO / contract",  "type":"text", "section":"Part"},

    {"key":"process",          "label":"Manufacturing process / cell", "type":"text", "section":"Manufacturing"},
    {"key":"serial_or_lot",    "label":"Serial / lot no.",             "type":"text", "section":"Manufacturing"},
    {"key":"material_cert",    "label":"Raw material cert no.",         "type":"text", "section":"Manufacturing"},
    {"key":"special_processes","label":"Special process certifications","type":"memo", "section":"Manufacturing"},

    {"key":"fai_type",       "label":"FAI type",                "type":"select", "section":"Inspection",
     "options":["Full FAI","Partial FAI","Delta FAI"]},
    {"key":"inspection_date","label":"Inspection date",         "type":"date",   "section":"Inspection"},
    {"key":"inspected_by",  "label":"Inspected by",             "type":"signature","section":"Inspection"},
    {"key":"equipment_used","label":"Gauges & equipment used",  "type":"memo",   "section":"Inspection"},

    {"key":"characteristics", "label":"Characteristics", "type":"table", "section":"Characteristics",
     "columns":[
        {"key":"balloon",    "label":"Balloon #",         "type":"text"},
        {"key":"feature",    "label":"Characteristic",    "type":"text"},
        {"key":"char_class", "label":"Class",             "type":"select",
         "options":["Standard","Key","Critical","Major","Minor"]},
        {"key":"nominal",    "label":"Nominal",           "type":"number"},
        {"key":"tol_minus",  "label":"Tol −",        "type":"number"},
        {"key":"tol_plus",   "label":"Tol +",             "type":"number"},
        {"key":"method",     "label":"Method",            "type":"text"},
        {"key":"actual",     "label":"Actual",            "type":"number"},
        {"key":"result",     "label":"Result",            "type":"text"},
        {"key":"notes",      "label":"Notes",             "type":"text"}
     ]},

    {"key":"disposition",        "label":"Disposition",              "type":"select", "required":true, "section":"Disposition",
     "options":["Accepted","Accepted with deviation","Rejected"]},
    {"key":"deviation_reference","label":"Deviation / concession no.","type":"text", "section":"Disposition"},
    {"key":"nonconformances",   "label":"Nonconformance detail",     "type":"memo", "section":"Disposition"},
    {"key":"reviewed_by",       "label":"Reviewed by",              "type":"signature", "section":"Disposition"},
    {"key":"review_date",       "label":"Review date",              "type":"date", "section":"Disposition"}
  ],
  "rules": []
}'::jsonb, now()
  from record_types rt
 where rt.key = 'fair'
on conflict do nothing;
