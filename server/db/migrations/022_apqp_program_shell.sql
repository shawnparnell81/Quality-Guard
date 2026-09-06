-- ============================================================
-- APQP: back to a Program shell.
--
-- Migrations 020/021 grew APQP into one record carrying DFMEA, PFMEA,
-- control plan and process flow as fields (real tables, by 021, but
-- still fields on one record). Rejected, correctly: those four are
-- controlled documents with their own identity, revision and
-- approval sign-off in real practice - a different kind of thing
-- than a form section. They move to their own record types
-- (022_fmea_control_plan_process_flow_ppap.sql, same commit), linked
-- to the Program via record_links (child_of) - the same generic
-- linking mechanism NCR-to-8D already uses, not a new one.
--
-- Program risk (program_risk_summary) and launch corrective actions
-- (corrective_actions_summary) move the same way, but to record
-- types that already existed before APQP ever did: `risk` and
-- `capa`. A program's risks are real Risk records, not a memo
-- restating them; launch issues are real CAPAs, not a paragraph
-- pretending to track them.
--
-- Everything else - Voice of Customer, Feasibility, Charter, Design
-- Reviews, Special Characteristics, Drawings/Specs, Work
-- Instructions status, MSA, Capability, Run-at-Rate, Lessons
-- Learned, Launch Metrics - stays exactly as it was: one-time program
-- inputs and study results, not living documents, correctly modelled
-- as fields already.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce(prev.version, 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               -- Phase 1: Plan & Define Program
               jsonb_build_object('key', 'voc_customer_requirements', 'label', 'Voice of customer / customer requirements', 'type', 'memo', 'section', 'Phase 1 - Voice of Customer'),
               jsonb_build_object('key', 'voc_source', 'label', 'VOC source', 'type', 'select', 'section', 'Phase 1 - Voice of Customer',
                                   'options', jsonb_build_array('Customer specification', 'Survey', 'Warranty / field data', 'Benchmarking', 'Sales / marketing input', 'Other')),
               jsonb_build_object('key', 'voc_special_requirements', 'label', 'Customer special requirements (CSRs)', 'type', 'memo', 'section', 'Phase 1 - Voice of Customer'),

               jsonb_build_object('key', 'feasibility_status', 'label', 'Feasibility status', 'type', 'select', 'section', 'Phase 1 - Feasibility Review',
                                   'options', jsonb_build_array('Not started', 'In progress', 'Feasible', 'Feasible with conditions', 'Not feasible')),
               jsonb_build_object('key', 'feasibility_notes', 'label', 'Feasibility notes', 'type', 'memo', 'section', 'Phase 1 - Feasibility Review'),
               jsonb_build_object('key', 'feasibility_reviewed_by', 'label', 'Reviewed by', 'type', 'user', 'section', 'Phase 1 - Feasibility Review'),
               jsonb_build_object('key', 'feasibility_review_date', 'label', 'Review date', 'type', 'date', 'section', 'Phase 1 - Feasibility Review'),

               jsonb_build_object('key', 'customer', 'label', 'Customer', 'type', 'text', 'required', true, 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'part_number', 'label', 'Part number', 'type', 'text', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'target_sop', 'label', 'Target start of production', 'type', 'date', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_scope', 'label', 'Program scope', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_objectives', 'label', 'Program objectives', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_team_members', 'label', 'Cross-functional team', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_approved_by', 'label', 'Charter approved by', 'type', 'signature', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_approval_date', 'label', 'Charter approval date', 'type', 'date', 'section', 'Phase 1 - Program Charter'),

               -- Phase 2: Product Design & Development (DFMEA is now a linked `fmea` record - see "Linked records")
               jsonb_build_object('key', 'design_review_date', 'label', 'Design review date', 'type', 'date', 'section', 'Phase 2 - Design Reviews'),
               jsonb_build_object('key', 'design_review_attendees', 'label', 'Attendees', 'type', 'memo', 'section', 'Phase 2 - Design Reviews'),
               jsonb_build_object('key', 'design_review_outcome', 'label', 'Outcome', 'type', 'select', 'section', 'Phase 2 - Design Reviews',
                                   'options', jsonb_build_array('Approved', 'Approved with actions', 'Not approved')),
               jsonb_build_object('key', 'design_review_notes', 'label', 'Notes', 'type', 'memo', 'section', 'Phase 2 - Design Reviews'),

               jsonb_build_object('key', 'special_characteristics', 'label', 'Special characteristics (critical / significant)', 'type', 'memo', 'section', 'Phase 2 - Special Characteristics'),
               jsonb_build_object('key', 'special_characteristics_legend', 'label', 'Symbol legend used', 'type', 'text', 'section', 'Phase 2 - Special Characteristics'),

               jsonb_build_object('key', 'drawing_number', 'label', 'Drawing number', 'type', 'text', 'section', 'Phase 2 - Drawings / Specs'),
               jsonb_build_object('key', 'drawing_revision', 'label', 'Revision', 'type', 'text', 'section', 'Phase 2 - Drawings / Specs'),
               jsonb_build_object('key', 'drawing_evidence', 'label', 'Drawing / spec evidence', 'type', 'file', 'section', 'Phase 2 - Drawings / Specs'),

               -- Phase 3: Process Design & Development (PFMEA, Process Flow, Control Plan are now linked records)
               jsonb_build_object('key', 'work_instructions_status', 'label', 'Work instructions status', 'type', 'select', 'section', 'Phase 3 - Work Instructions',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Released')),
               jsonb_build_object('key', 'work_instructions_evidence', 'label', 'Work instructions evidence', 'type', 'file', 'section', 'Phase 3 - Work Instructions'),

               -- Phase 4: Product & Process Validation (PPAP is now a linked record)
               jsonb_build_object('key', 'msa_status', 'label', 'MSA status', 'type', 'select', 'section', 'Phase 4 - MSA Studies',
                                   'options', jsonb_build_array('Not started', 'In progress', 'Acceptable', 'Marginal', 'Unacceptable')),
               jsonb_build_object('key', 'msa_summary', 'label', 'MSA summary (Gage R&R results)', 'type', 'memo', 'section', 'Phase 4 - MSA Studies'),
               jsonb_build_object('key', 'msa_evidence', 'label', 'MSA evidence', 'type', 'file', 'section', 'Phase 4 - MSA Studies'),

               jsonb_build_object('key', 'capability_status', 'label', 'Capability status', 'type', 'select', 'section', 'Phase 4 - Capability Studies',
                                   'options', jsonb_build_array('Not started', 'In progress', 'Capable', 'Not capable')),
               jsonb_build_object('key', 'capability_cpk', 'label', 'Cpk achieved', 'type', 'number', 'section', 'Phase 4 - Capability Studies'),
               jsonb_build_object('key', 'capability_evidence', 'label', 'Capability study evidence', 'type', 'file', 'section', 'Phase 4 - Capability Studies'),

               jsonb_build_object('key', 'run_at_rate_status', 'label', 'Run-at-rate status', 'type', 'select', 'section', 'Phase 4 - Run-at-Rate',
                                   'options', jsonb_build_array('Not scheduled', 'Scheduled', 'Passed', 'Failed')),
               jsonb_build_object('key', 'run_at_rate_target_rate', 'label', 'Target rate (parts/hour)', 'type', 'number', 'min', 0, 'section', 'Phase 4 - Run-at-Rate'),
               jsonb_build_object('key', 'run_at_rate_rate_achieved', 'label', 'Rate achieved (parts/hour)', 'type', 'number', 'min', 0, 'section', 'Phase 4 - Run-at-Rate'),
               jsonb_build_object('key', 'run_at_rate_evidence', 'label', 'Run-at-rate evidence', 'type', 'file', 'section', 'Phase 4 - Run-at-Rate'),

               -- Phase 5: Launch, Feedback, Assessment, Corrective Action (corrective actions are now linked CAPAs)
               jsonb_build_object('key', 'lessons_learned', 'label', 'Lessons learned', 'type', 'memo', 'section', 'Phase 5 - Lessons Learned'),

               jsonb_build_object('key', 'launch_metrics_summary', 'label', 'Launch metrics summary', 'type', 'memo', 'section', 'Phase 5 - Launch Metrics'),
               jsonb_build_object('key', 'launch_metrics_ppm', 'label', 'Initial PPM at launch', 'type', 'number', 'min', 0, 'section', 'Phase 5 - Launch Metrics'),
               jsonb_build_object('key', 'launch_metrics_evidence', 'label', 'Launch metrics evidence', 'type', 'file', 'section', 'Phase 5 - Launch Metrics')
           ),
           'rules', coalesce(prev.schema->'rules', '[]'::jsonb)
       ),
       now()
  from record_types rt
  left join lateral (
        select fv.version, fv.schema
          from form_versions fv
         where fv.record_type_id = rt.id
         order by fv.version desc
         limit 1
       ) prev on true
 where rt.key = 'apqp';
