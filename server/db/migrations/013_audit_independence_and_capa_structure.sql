-- ============================================================
-- Audit independence (clause 9.2) and structured CAPA root cause
-- (clause 10.2).
--
-- Publishes a new form version for both types, per org, on top of
-- whatever version each org already has - same "never overwrite,
-- always publish forward" rule the Form Builder itself follows, so a
-- record captured under the old field list keeps rendering with it.
--
-- Numbered 013 on this branch because it was created directly off
-- main; 013-015 exist with different content on other still-unmerged
-- branches. migrate.js tracks applied migrations by filename, not by
-- a contiguous sequence, so this is cosmetic, not a conflict - noted
-- here so it isn't mistaken for one later.
-- ============================================================

-- Audit: "auditor" becomes a real reference to a user (type "user",
-- accepted by the form validator since it was written but never
-- actually usable - nothing loaded its options or rendered it as
-- anything but a text box, until this same change wires that up in
-- masterdata.js and forms.js). "department" names the process area
-- under review - the fact records.js's independence check compares
-- against the assigned auditor's own discipline. Options are the
-- real discipline values already present among this org's people,
-- not an invented fixed list.
insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce((select max(version) from form_versions fv where fv.record_type_id = rt.id), 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'scope',      'label', 'Scope',                  'type', 'text',   'required', true),
               jsonb_build_object('key', 'department', 'label', 'Department under review', 'type', 'select', 'required', true,
                                   'options', coalesce(disciplines.options, '[]'::jsonb)),
               jsonb_build_object('key', 'auditor',    'label', 'Auditor',                 'type', 'user',   'required', true),
               jsonb_build_object('key', 'planned',    'label', 'Planned date',            'type', 'date')
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
  left join lateral (
        select jsonb_agg(d.discipline order by d.discipline) as options
          from (select distinct discipline from users
                 where org_id = rt.org_id and discipline is not null) d
       ) disciplines on true
 where rt.key = 'audit';

-- CAPA: root cause becomes five discrete lines instead of one
-- free-text memo, so "5 Whys" is a structural requirement of the
-- form rather than a habit someone might skip. why_4/why_5 stay
-- optional - real root-cause analysis sometimes lands in three or
-- four whys, and a mandatory fifth line would just get filled with a
-- repeat of the fourth to satisfy the form.
insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce((select max(version) from form_versions fv where fv.record_type_id = rt.id), 0) + 1,
       '{
           "fields": [
               {"key":"source",                 "label":"Source",                      "type":"text"},
               {"key":"problem_statement",       "label":"Problem statement",           "type":"memo", "required":true},
               {"key":"why_1",                   "label":"Why 1",                       "type":"memo", "required":true},
               {"key":"why_2",                   "label":"Why 2",                       "type":"memo", "required":true},
               {"key":"why_3",                   "label":"Why 3",                       "type":"memo", "required":true},
               {"key":"why_4",                   "label":"Why 4",                       "type":"memo"},
               {"key":"why_5",                   "label":"Why 5",                       "type":"memo"},
               {"key":"corrective_action",       "label":"Corrective action",           "type":"memo"},
               {"key":"effectiveness_criterion", "label":"How effectiveness is judged", "type":"memo"}
           ],
           "rules": []
       }'::jsonb,
       now()
  from record_types rt
 where rt.key = 'capa';
