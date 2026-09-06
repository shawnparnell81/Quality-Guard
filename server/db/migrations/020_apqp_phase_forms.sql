-- ============================================================
-- APQP: a full form per phase deliverable, replacing the seven-field
-- form that stayed identical no matter which of the five phases a
-- program was actually in.
--
-- Mapped to the AIAG APQP manual's own five phases and IATF 16949
-- 8.3's design-and-development-planning requirements, not
-- invented: every deliverable named in the standard phase structure
-- (Voice of Customer, Feasibility, Risk Assessment, Charter / DFMEA,
-- Design Reviews, Special Characteristics, Drawings / PFMEA, Process
-- Flow, Control Plan, Work Instructions / MSA, Capability, PPAP,
-- Run-at-Rate / Lessons Learned, Corrective Actions, Launch Metrics)
-- gets its own section, in phase order.
--
-- DFMEA, PFMEA and the Control Plan are each real, structured,
-- many-row tables in the standard (a DFMEA line has roughly a dozen
-- columns: item/function, failure mode, effect, severity, cause,
-- occurrence, current controls, detection, RPN, recommended action,
-- owner, target date). This app's form engine has no repeating-row
-- field type yet - only flat fields - so reproducing one as hand-
-- typed pseudo-table text would be worse than not having it: a
-- fabricated stand-in for a controlled document, in a system built
-- to help a plant pass an audit. Each of those three deliverables is
-- instead status + a one-line summary + the highest RPN + a required
-- evidence attachment (the real, controlled table lives in the
-- team's FMEA/control-plan tool and is attached here as proof of
-- record) + sign-off where the standard calls for one - honest about
-- what this form captures without pretending to replace the document
-- itself.
--
-- Every new field is optional at the form level - see the note on
-- the transition endpoint in this same commit for why: records.js's
-- required-field check runs once, at creation, against every field a
-- type's form has. A multi-month program cannot be required to have
-- typed its launch metrics before anyone is allowed to open the
-- record at all. Real completion enforcement - "Phase 1 cannot be
-- left until its deliverables are done" - is a workflow-transition
-- gate instead, the same idea already built for CAPA's attachment
-- requirement and audit independence.
--
-- The seven fields this form already had (customer, part_number,
-- target_sop, ppap_level, psw_status, program_risk_summary,
-- lessons_learned) keep their exact key, label, type and options -
-- only a section is added - so every existing bound value keeps
-- working under the new layout.
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

               jsonb_build_object('key', 'program_risk_summary', 'label', 'Top program risks', 'type', 'memo', 'section', 'Phase 1 - Risk Assessment'),
               jsonb_build_object('key', 'risk_assessment_method', 'label', 'Risk assessment method', 'type', 'select', 'section', 'Phase 1 - Risk Assessment',
                                   'options', jsonb_build_array('FMEA', 'Risk matrix', 'Lessons-learned review', 'Other')),
               jsonb_build_object('key', 'risk_assessment_evidence', 'label', 'Risk assessment evidence', 'type', 'file', 'section', 'Phase 1 - Risk Assessment'),

               jsonb_build_object('key', 'customer', 'label', 'Customer', 'type', 'text', 'required', true, 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'part_number', 'label', 'Part number', 'type', 'text', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'target_sop', 'label', 'Target start of production', 'type', 'date', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_scope', 'label', 'Program scope', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_objectives', 'label', 'Program objectives', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_team_members', 'label', 'Cross-functional team', 'type', 'memo', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_approved_by', 'label', 'Charter approved by', 'type', 'signature', 'section', 'Phase 1 - Program Charter'),
               jsonb_build_object('key', 'charter_approval_date', 'label', 'Charter approval date', 'type', 'date', 'section', 'Phase 1 - Program Charter'),

               -- Phase 2: Product Design & Development
               jsonb_build_object('key', 'dfmea_status', 'label', 'DFMEA status', 'type', 'select', 'section', 'Phase 2 - DFMEA',
                                   'options', jsonb_build_array('Not started', 'Draft', 'In review', 'Approved')),
               jsonb_build_object('key', 'dfmea_summary', 'label', 'DFMEA summary (highest-risk failure modes)', 'type', 'memo', 'section', 'Phase 2 - DFMEA'),
               jsonb_build_object('key', 'dfmea_highest_rpn', 'label', 'Highest RPN identified', 'type', 'number', 'min', 1, 'section', 'Phase 2 - DFMEA'),
               jsonb_build_object('key', 'dfmea_evidence', 'label', 'DFMEA evidence (controlled document)', 'type', 'file', 'section', 'Phase 2 - DFMEA'),
               jsonb_build_object('key', 'dfmea_approved_by', 'label', 'DFMEA approved by', 'type', 'signature', 'section', 'Phase 2 - DFMEA'),

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

               -- Phase 3: Process Design & Development
               jsonb_build_object('key', 'pfmea_status', 'label', 'PFMEA status', 'type', 'select', 'section', 'Phase 3 - PFMEA',
                                   'options', jsonb_build_array('Not started', 'Draft', 'In review', 'Approved')),
               jsonb_build_object('key', 'pfmea_summary', 'label', 'PFMEA summary (highest-risk failure modes)', 'type', 'memo', 'section', 'Phase 3 - PFMEA'),
               jsonb_build_object('key', 'pfmea_highest_rpn', 'label', 'Highest RPN identified', 'type', 'number', 'min', 1, 'section', 'Phase 3 - PFMEA'),
               jsonb_build_object('key', 'pfmea_evidence', 'label', 'PFMEA evidence (controlled document)', 'type', 'file', 'section', 'Phase 3 - PFMEA'),
               jsonb_build_object('key', 'pfmea_approved_by', 'label', 'PFMEA approved by', 'type', 'signature', 'section', 'Phase 3 - PFMEA'),

               jsonb_build_object('key', 'process_flow_status', 'label', 'Process flow diagram status', 'type', 'select', 'section', 'Phase 3 - Process Flow Diagram',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Approved')),
               jsonb_build_object('key', 'process_flow_evidence', 'label', 'Process flow evidence', 'type', 'file', 'section', 'Phase 3 - Process Flow Diagram'),

               jsonb_build_object('key', 'control_plan_status', 'label', 'Control plan status', 'type', 'select', 'section', 'Phase 3 - Control Plan',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Approved')),
               jsonb_build_object('key', 'control_plan_summary', 'label', 'Control plan summary', 'type', 'memo', 'section', 'Phase 3 - Control Plan'),
               jsonb_build_object('key', 'control_plan_evidence', 'label', 'Control plan evidence (controlled document)', 'type', 'file', 'section', 'Phase 3 - Control Plan'),
               jsonb_build_object('key', 'control_plan_approved_by', 'label', 'Control plan approved by', 'type', 'signature', 'section', 'Phase 3 - Control Plan'),

               jsonb_build_object('key', 'work_instructions_status', 'label', 'Work instructions status', 'type', 'select', 'section', 'Phase 3 - Work Instructions',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Released')),
               jsonb_build_object('key', 'work_instructions_evidence', 'label', 'Work instructions evidence', 'type', 'file', 'section', 'Phase 3 - Work Instructions'),

               -- Phase 4: Product & Process Validation
               jsonb_build_object('key', 'msa_status', 'label', 'MSA status', 'type', 'select', 'section', 'Phase 4 - MSA Studies',
                                   'options', jsonb_build_array('Not started', 'In progress', 'Acceptable', 'Marginal', 'Unacceptable')),
               jsonb_build_object('key', 'msa_summary', 'label', 'MSA summary (Gage R&R results)', 'type', 'memo', 'section', 'Phase 4 - MSA Studies'),
               jsonb_build_object('key', 'msa_evidence', 'label', 'MSA evidence', 'type', 'file', 'section', 'Phase 4 - MSA Studies'),

               jsonb_build_object('key', 'capability_status', 'label', 'Capability status', 'type', 'select', 'section', 'Phase 4 - Capability Studies',
                                   'options', jsonb_build_array('Not started', 'In progress', 'Capable', 'Not capable')),
               jsonb_build_object('key', 'capability_cpk', 'label', 'Cpk achieved', 'type', 'number', 'section', 'Phase 4 - Capability Studies'),
               jsonb_build_object('key', 'capability_evidence', 'label', 'Capability study evidence', 'type', 'file', 'section', 'Phase 4 - Capability Studies'),

               jsonb_build_object('key', 'ppap_level', 'label', 'PPAP submission level', 'type', 'select', 'section', 'Phase 4 - PPAP Evidence',
                                   'options', jsonb_build_array('Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5')),
               jsonb_build_object('key', 'psw_status', 'label', 'PSW status', 'type', 'select', 'section', 'Phase 4 - PPAP Evidence',
                                   'options', jsonb_build_array('Not submitted', 'Submitted', 'Interim Approval', 'Approved', 'Rejected')),
               jsonb_build_object('key', 'ppap_submitted_date', 'label', 'PPAP submitted date', 'type', 'date', 'section', 'Phase 4 - PPAP Evidence'),
               jsonb_build_object('key', 'ppap_evidence', 'label', 'PPAP package evidence', 'type', 'file', 'section', 'Phase 4 - PPAP Evidence'),

               jsonb_build_object('key', 'run_at_rate_status', 'label', 'Run-at-rate status', 'type', 'select', 'section', 'Phase 4 - Run-at-Rate',
                                   'options', jsonb_build_array('Not scheduled', 'Scheduled', 'Passed', 'Failed')),
               jsonb_build_object('key', 'run_at_rate_target_rate', 'label', 'Target rate (parts/hour)', 'type', 'number', 'min', 0, 'section', 'Phase 4 - Run-at-Rate'),
               jsonb_build_object('key', 'run_at_rate_rate_achieved', 'label', 'Rate achieved (parts/hour)', 'type', 'number', 'min', 0, 'section', 'Phase 4 - Run-at-Rate'),
               jsonb_build_object('key', 'run_at_rate_evidence', 'label', 'Run-at-rate evidence', 'type', 'file', 'section', 'Phase 4 - Run-at-Rate'),

               -- Phase 5: Launch, Feedback, Assessment, Corrective Action
               jsonb_build_object('key', 'lessons_learned', 'label', 'Lessons learned', 'type', 'memo', 'section', 'Phase 5 - Lessons Learned'),

               jsonb_build_object('key', 'corrective_actions_summary', 'label', 'Corrective actions summary', 'type', 'memo', 'section', 'Phase 5 - Corrective Actions'),

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
