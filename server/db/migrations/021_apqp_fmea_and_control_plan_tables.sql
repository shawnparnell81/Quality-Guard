-- ============================================================
-- APQP: real DFMEA, PFMEA, control plan and process flow diagram
-- tables, replacing the status + one-line-summary + hand-typed-
-- highest-RPN version of those four deliverables from migration 020.
--
-- That version was an explicit, documented simplification - flagged
-- to the user before it was built, alongside the two larger
-- alternatives (a new repeating-row field type across the whole
-- form engine, or FMEA/control-plan lines as their own linked record
-- type) - because at the time this form's field-type vocabulary had
-- no way to represent a repeating row at all. It was correctly
-- rejected: a DFMEA, PFMEA and control plan are not optional table-
-- shaped extras on this form, they are the actual point, and ISO
-- 9001 / IATF 16949 do not treat "we wrote a paragraph about our
-- FMEA" as equivalent to having one.
--
-- This migration is why "table" now exists as a real field type
-- (masterdata.js's FIELD_TYPES, forms.js's buildTableField,
-- records.js's PDF drawTableField) - a field whose value is an array
-- of row objects against a declared column schema, rendered as an
-- actual add/remove-row grid on screen and an actual bordered table
-- in the PDF export, not a fixed-shape special case for APQP alone.
-- Any current or future field on any record type can use it.
--
-- Column choice: the core AIAG-aligned FMEA columns (item/function,
-- failure mode, effect, severity, cause, occurrence, current
-- controls, detection, RPN, recommended action, responsibility,
-- target date) and the core AIAG control-plan columns (process step,
-- characteristic, specification, measurement method, sample size,
-- sample frequency, control method, reaction plan) - the complete,
-- universally-recognised working set every FMEA/control-plan
-- template built to the standard carries, not a cut-down list. RPN
-- is entered nowhere: records.js recomputes severity x occurrence x
-- detection into every row on save (withComputedTableRowRpn), and
-- rolls the highest one up into dfmea_highest_rpn / pfmea_highest_rpn
-- the same way (withComputedTableSummaries) - a hand-typed row RPN
-- disagreeing with its own three scores is exactly the failure mode
-- risk.js's top-level RPN computation already exists to prevent, now
-- applied inside a table row instead of only at a field's top level.
--
-- dfmea_summary, pfmea_summary and control_plan_summary are dropped
-- here, not carried forward: a paragraph that used to stand in for
-- the table is redundant once the table itself exists, and keeping
-- both invites the two disagreeing. status, evidence and sign-off
-- fields are unaffected - a table is what the deliverable IS, not a
-- replacement for having reviewed and approved it.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce(prev.version, 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               -- Phase 1: Plan & Define Program (unchanged from v2)
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
               jsonb_build_object(
                   'key', 'dfmea_table', 'label', 'DFMEA', 'type', 'table', 'section', 'Phase 2 - DFMEA',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'item_function',       'label', 'Item / Function',        'type', 'text',   'width', 78),
                       jsonb_build_object('key', 'failure_mode',        'label', 'Potential Failure Mode',  'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'effect',              'label', 'Potential Effect',        'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'severity',            'label', 'Sev',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'cause',               'label', 'Potential Cause',         'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'occurrence',          'label', 'Occ',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'current_controls',    'label', 'Current Controls',        'type', 'text',   'width', 74),
                       jsonb_build_object('key', 'detection',           'label', 'Det',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'rpn',                 'label', 'RPN',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'recommended_action',  'label', 'Recommended Action',      'type', 'text',   'width', 78),
                       jsonb_build_object('key', 'responsibility',      'label', 'Responsibility',          'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'target_date',         'label', 'Target Date',             'type', 'date',   'width', 45)
                   )
               ),
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
               jsonb_build_object(
                   'key', 'pfmea_table', 'label', 'PFMEA', 'type', 'table', 'section', 'Phase 3 - PFMEA',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'process_step',        'label', 'Process Step / Function', 'type', 'text',   'width', 78),
                       jsonb_build_object('key', 'failure_mode',        'label', 'Potential Failure Mode',  'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'effect',              'label', 'Potential Effect',        'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'severity',            'label', 'Sev',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'cause',               'label', 'Potential Cause',         'type', 'text',   'width', 68),
                       jsonb_build_object('key', 'occurrence',          'label', 'Occ',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'current_controls',    'label', 'Current Controls',        'type', 'text',   'width', 74),
                       jsonb_build_object('key', 'detection',           'label', 'Det',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'rpn',                 'label', 'RPN',                     'type', 'number', 'width', 30),
                       jsonb_build_object('key', 'recommended_action',  'label', 'Recommended Action',      'type', 'text',   'width', 78),
                       jsonb_build_object('key', 'responsibility',      'label', 'Responsibility',          'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'target_date',         'label', 'Target Date',             'type', 'date',   'width', 45)
                   )
               ),
               jsonb_build_object('key', 'pfmea_highest_rpn', 'label', 'Highest RPN identified', 'type', 'number', 'min', 1, 'section', 'Phase 3 - PFMEA'),
               jsonb_build_object('key', 'pfmea_evidence', 'label', 'PFMEA evidence (controlled document)', 'type', 'file', 'section', 'Phase 3 - PFMEA'),
               jsonb_build_object('key', 'pfmea_approved_by', 'label', 'PFMEA approved by', 'type', 'signature', 'section', 'Phase 3 - PFMEA'),

               jsonb_build_object('key', 'process_flow_status', 'label', 'Process flow diagram status', 'type', 'select', 'section', 'Phase 3 - Process Flow Diagram',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Approved')),
               jsonb_build_object(
                   'key', 'process_flow_table', 'label', 'Process flow', 'type', 'table', 'section', 'Phase 3 - Process Flow Diagram',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'step_number',   'label', 'Step #',                   'type', 'number', 'width', 40),
                       jsonb_build_object('key', 'process_step',  'label', 'Process Step Description',  'type', 'text',   'width', 130),
                       jsonb_build_object('key', 'inputs',        'label', 'Inputs / Materials',        'type', 'text',   'width', 110),
                       jsonb_build_object('key', 'outputs',       'label', 'Outputs / Characteristics',  'type', 'text',   'width', 110),
                       jsonb_build_object('key', 'equipment',     'label', 'Equipment / Gage',           'type', 'text',   'width', 110)
                   )
               ),
               jsonb_build_object('key', 'process_flow_evidence', 'label', 'Process flow evidence', 'type', 'file', 'section', 'Phase 3 - Process Flow Diagram'),

               jsonb_build_object('key', 'control_plan_status', 'label', 'Control plan status', 'type', 'select', 'section', 'Phase 3 - Control Plan',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Approved')),
               jsonb_build_object(
                   'key', 'control_plan_table', 'label', 'Control plan', 'type', 'table', 'section', 'Phase 3 - Control Plan',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'process_step',        'label', 'Process Step',                        'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'characteristic',      'label', 'Product / Process Characteristic',    'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'specification',       'label', 'Specification / Tolerance',           'type', 'text', 'width', 60),
                       jsonb_build_object('key', 'measurement_method',  'label', 'Evaluation / Measurement Technique',  'type', 'text', 'width', 70),
                       jsonb_build_object('key', 'sample_size',         'label', 'Sample Size',                         'type', 'text', 'width', 45),
                       jsonb_build_object('key', 'sample_frequency',    'label', 'Sample Frequency',                    'type', 'text', 'width', 55),
                       jsonb_build_object('key', 'control_method',      'label', 'Control Method',                      'type', 'text', 'width', 65),
                       jsonb_build_object('key', 'reaction_plan',       'label', 'Reaction Plan',                       'type', 'text', 'width', 75)
                   )
               ),
               jsonb_build_object('key', 'control_plan_evidence', 'label', 'Control plan evidence (controlled document)', 'type', 'file', 'section', 'Phase 3 - Control Plan'),
               jsonb_build_object('key', 'control_plan_approved_by', 'label', 'Control plan approved by', 'type', 'signature', 'section', 'Phase 3 - Control Plan'),

               jsonb_build_object('key', 'work_instructions_status', 'label', 'Work instructions status', 'type', 'select', 'section', 'Phase 3 - Work Instructions',
                                   'options', jsonb_build_array('Not started', 'Draft', 'Released')),
               jsonb_build_object('key', 'work_instructions_evidence', 'label', 'Work instructions evidence', 'type', 'file', 'section', 'Phase 3 - Work Instructions'),

               -- Phase 4: Product & Process Validation (unchanged from v2)
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

               -- Phase 5: Launch, Feedback, Assessment, Corrective Action (unchanged from v2)
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
