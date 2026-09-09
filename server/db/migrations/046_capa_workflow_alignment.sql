-- ============================================================
-- CAPA module aligned to the five-phase CAPA process (clause 10.2):
--
--   Initiation & evaluation  ->  Investigation & root cause  ->
--   Action planning  ->  Implementation & monitoring  ->
--   Effectiveness verification  ->  Closed  |  Escalated
--
-- Per org, for every 'capa' record type this migration:
--   1. replaces workflow_states and workflow_transitions
--   2. publishes the phase-grouped form as the next version - older
--      records keep their pinned form_version and render unchanged
--   3. remaps existing records onto the new state names
--
-- Only 'problem_statement' is required at creation; the rest are
-- guidance grouped by phase (section) - the workflow, not a field
-- flag, is what enforces "no root cause, no action plan".
-- ============================================================

-- 1. workflow ------------------------------------------------------
delete from workflow_transitions
 where record_type_id in (select id from record_types where key = 'capa');
delete from workflow_states
 where record_type_id in (select id from record_types where key = 'capa');

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, s.key, s.name, s.pos, s.terminal
  from record_types rt
  cross join (values
     ('initiation',     'Initiation & evaluation',     1, false),
     ('investigation',  'Investigation & root cause',  2, false),
     ('planning',       'Action planning',             3, false),
     ('implementation', 'Implementation & monitoring', 4, false),
     ('effectiveness',  'Effectiveness verification',  5, false),
     ('closed',         'Closed',                      6, true),
     ('escalated',      'Escalated',                   7, true)
  ) as s(key, name, pos, terminal)
 where rt.key = 'capa';

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, t.from_key, t.to_key, t.perm
  from record_types rt
  cross join (values
     ('initiation',     'investigation',  'capa.create'),   -- CAPA warranted, proceed
     ('initiation',     'closed',         'capa.close'),     -- necessity determination: no CAPA needed
     ('investigation',  'planning',       'capa.create'),
     ('planning',       'implementation', 'capa.create'),
     ('implementation', 'effectiveness',  'capa.create'),
     ('effectiveness',  'closed',         'capa.close'),     -- effective
     ('effectiveness',  'planning',       'capa.create'),    -- not effective, re-plan
     ('effectiveness',  'escalated',      'capa.close')      -- not effective, escalate
  ) as t(from_key, to_key, perm)
 where rt.key = 'capa';

-- 2. the phase-grouped form -------------------------------------------------
insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce((select max(version) from form_versions fv where fv.record_type_id = rt.id), 0) + 1,
       $json$
       {
         "fields": [
           {"key":"source","label":"Source","type":"text","section":"Initiation & evaluation"},
           {"key":"problem_statement","label":"Problem statement","type":"memo","required":true,"section":"Initiation & evaluation"},
           {"key":"trigger_event","label":"Trigger event","type":"memo","section":"Initiation & evaluation"},
           {"key":"preliminary_findings","label":"Preliminary investigation","type":"memo","section":"Initiation & evaluation"},
           {"key":"significance","label":"Significance","type":"select","options":["Low","Medium","High","Critical"],"section":"Initiation & evaluation"},
           {"key":"capa_warranted","label":"CAPA warranted","type":"boolean","section":"Initiation & evaluation"},
           {"key":"necessity_rationale","label":"Necessity determination","type":"memo","section":"Initiation & evaluation"},

           {"key":"investigation_team","label":"Investigation team","type":"text","section":"Investigation & root cause"},
           {"key":"rca_method","label":"RCA method","type":"select","options":["5 Why","Fishbone","Fault Tree","Human Factors","FMEA","Other"],"section":"Investigation & root cause"},
           {"key":"why_1","label":"Why 1","type":"memo","section":"Investigation & root cause"},
           {"key":"why_2","label":"Why 2","type":"memo","section":"Investigation & root cause"},
           {"key":"why_3","label":"Why 3","type":"memo","section":"Investigation & root cause"},
           {"key":"why_4","label":"Why 4","type":"memo","section":"Investigation & root cause"},
           {"key":"why_5","label":"Why 5","type":"memo","section":"Investigation & root cause"},
           {"key":"root_cause","label":"Root cause","type":"memo","section":"Investigation & root cause"},
           {"key":"risk_ref","label":"Linked risk record","type":"text","section":"Investigation & root cause"},

           {"key":"actions","label":"Action plan","type":"table","rowAttachments":true,"section":"Action planning","columns":[
             {"key":"action","label":"Action","type":"text"},
             {"key":"type","label":"Type","type":"select","options":["Containment","Corrective","Preventive"]},
             {"key":"owner","label":"Owner","type":"text"},
             {"key":"due","label":"Due","type":"date"},
             {"key":"status","label":"Status","type":"select","options":["Open","In progress","Done"]}
           ]},
           {"key":"resources_required","label":"Resources required","type":"memo","section":"Action planning"},

           {"key":"implementation_notes","label":"Implementation notes","type":"memo","section":"Implementation & monitoring"},
           {"key":"implementation_complete","label":"Implementation complete","type":"boolean","section":"Implementation & monitoring"},

           {"key":"verification_plan","label":"Verification plan (method, sample, acceptance)","type":"memo","section":"Effectiveness verification"},
           {"key":"effectiveness_criterion","label":"How effectiveness is judged","type":"memo","section":"Effectiveness verification"},
           {"key":"verification_result","label":"Verification result","type":"memo","section":"Effectiveness verification"},
           {"key":"effectiveness_outcome","label":"Effectiveness outcome","type":"select","options":["Effective","Not effective - re-plan","Not effective - escalate"],"section":"Effectiveness verification"},
           {"key":"closure_summary","label":"Closure summary","type":"memo","section":"Effectiveness verification"}
         ],
         "rules": []
       }
       $json$::jsonb,
       now()
  from record_types rt
 where rt.key = 'capa';

-- 3. bring existing CAPA records onto the new state names -----------------
update records
   set status = case status
                  when 'draft'         then 'initiation'
                  when 'root_cause'    then 'investigation'
                  when 'eightd_linked' then 'investigation'
                  when 'action_plan'   then 'planning'
                  when 'verify'        then 'implementation'
                  else status
                end
 where record_type_id in (select id from record_types where key = 'capa')
   and status in ('draft', 'root_cause', 'eightd_linked', 'action_plan', 'verify');
