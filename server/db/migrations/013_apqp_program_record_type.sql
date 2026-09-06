-- ============================================================
-- APQP Program, a ninth record type.
--
-- Not a bespoke module: the same records/record_types/form_versions/
-- workflow_states/workflow_transitions engine every other quality
-- event already runs on, because an APQP program is exactly that
-- shape - a numbered record with a status, a form, and a sequence of
-- gates it moves through one at a time.
--
-- The five states below are the five APQP phases themselves (Plan &
-- Define, Product Design, Process Design, Validation, Feedback), so
-- a program's workflow position on this screen IS its phase - there
-- is no separate "current phase" field to fall out of sync with it.
-- "Program Manager" is not a form field either: it is whoever this
-- record's existing owner_id already names, the same as every other
-- record type's owner.
--
-- Written generically over every organization that exists, matching
-- migrations 010-012's style, not hard-coded to one org.
-- ============================================================

-- ---------- permission ----------

insert into permissions (key, resource, action, description, clause)
values ('apqp.manage', 'apqp', 'manage', 'Create and advance an APQP program through its phases', '8.3')
on conflict (key) do nothing;

-- Granted to the roles that already carry cross-functional program
-- authority elsewhere (capa.create, change.approve, audit.schedule).
-- general_manager and admin need it explicitly - see migration 018's
-- note: "every permission" is a one-time snapshot at provisioning
-- time, not a live grant.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'apqp.manage'
  from roles r
 where r.key in (
     'quality_manager', 'quality_engineer', 'engineering_manager',
     'manufacturing_engineer', 'general_manager', 'admin'
 )
 on conflict do nothing;

-- ---------- record type ----------

insert into record_types (org_id, key, name, prefix, clause)
select o.id, 'apqp', 'APQP Program', 'APQP', '8.3'
  from organizations o
 where not exists (
     select 1 from record_types rt where rt.org_id = o.id and rt.key = 'apqp'
 );

-- ---------- workflow: the five phases, in order, no skipping a gate ----------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',          'Draft',                                1, false),
        ('plan_define',    'Phase 1 - Plan & Define Program',      2, false),
        ('product_design', 'Phase 2 - Product Design & Dev.',      3, false),
        ('process_design', 'Phase 3 - Process Design & Dev.',      4, false),
        ('validation',     'Phase 4 - Product & Process Validation', 5, false),
        ('production',     'Phase 5 - Feedback & Corrective Action', 6, false),
        ('closed',         'Closed',                               7, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'apqp'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',          'plan_define',    'apqp.manage'),
        ('plan_define',    'product_design', 'apqp.manage'),
        ('product_design', 'process_design', 'apqp.manage'),
        ('process_design', 'validation',     'apqp.manage'),
        ('validation',     'production',     'apqp.manage'),
        ('production',     'closed',         'apqp.manage')
     ) as v(from_key, to_key, permission)
where rt.key = 'apqp'
on conflict do nothing;

-- ---------- form ----------

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1, '{
    "fields": [
        {"key":"customer",              "label":"Customer",                 "type":"text",   "required":true},
        {"key":"part_number",           "label":"Part number",              "type":"text"},
        {"key":"target_sop",            "label":"Target start of production","type":"date"},
        {"key":"ppap_level",            "label":"PPAP submission level",    "type":"select",
         "options":["Level 1","Level 2","Level 3","Level 4","Level 5"]},
        {"key":"psw_status",            "label":"PSW status",               "type":"select",
         "options":["Not submitted","Submitted","Interim Approval","Approved","Rejected"]},
        {"key":"program_risk_summary",  "label":"Top program risks",        "type":"memo"},
        {"key":"lessons_learned",       "label":"Lessons learned",          "type":"memo"}
    ],
    "rules": []
}'::jsonb, now()
  from record_types rt
 where rt.key = 'apqp'
on conflict do nothing;
