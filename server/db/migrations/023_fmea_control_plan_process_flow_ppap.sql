-- ============================================================
-- Four new record types: fmea, control_plan, process_flow, ppap -
-- real controlled documents, each with its own identity, workflow,
-- and approval sign-off, linked to an APQP Program (or raised on
-- their own) via record_links rather than living as fields on one
-- giant record.
--
-- Column structure for fmea/control_plan/process_flow is copied
-- directly from the org's own real templates (fmea.xlsx,
-- Control-Plan-.xlsx, Process-Flow-Diagram.xlsx), not the AIAG
-- generic guess the previous two attempts used. One deliberate
-- departure from a literal copy: the Process Flow template's ten
-- operation-type checkbox columns (Administration / Packaging /
-- Lift / ... ) collapse to one `operation_type` select, since a step
-- is one type in practice, not several at once, and this field-type
-- vocabulary has no independent-checkbox-group column type.
--
-- fmea covers both DFMEA and PFMEA with one type: the template's own
-- header ("Process Step/Input") does not differ by discipline, so a
-- `discipline` select (Design/Process) is the only thing that
-- actually changes, driving which APQP phase gate it satisfies and
-- which other documents it makes sense to link - not a different
-- column set. It is a *closed-loop* FMEA: severity/occurrence/
-- detection/RPN before an action, and the same four re-scored after
-- one, both computed server-side (never hand-typed - see
-- withComputedTableRowRpn's generalization to any same-prefixed
-- triplet, same commit).
--
-- Workflow for all three document types: draft -> in_review ->
-- approved, gated by a `*.approve` permission distinct from
-- `*.create` - a real sign-off nobody can grant themselves just by
-- being able to edit the document, the separation of duties clause
-- 8.3.4's design-review requirement is actually asking for.
-- `superseded` exists as a named terminal state but has no workflow_
-- transitions row into it: it is reached only as a side effect of a
-- *newer* revision's approval (records.js, the `supersedes` link
-- type already sitting in record_links' check constraint), never a
-- move a user picks directly.
-- ============================================================

-- ---------- permissions ----------

insert into permissions (key, resource, action, description, clause)
values
    ('fmea.create',         'fmea',         'create',  'Author or edit an FMEA',                           '8.3.4'),
    ('fmea.approve',        'fmea',         'approve', 'Approve an FMEA',                                  '8.3.4'),
    ('control_plan.create', 'control_plan', 'create',  'Author or edit a control plan',                    '8.5.1.1'),
    ('control_plan.approve','control_plan', 'approve', 'Approve a control plan',                           '8.5.1.1'),
    ('process_flow.create', 'process_flow', 'create',  'Author or edit a process flow diagram',            '8.3.4'),
    ('process_flow.approve','process_flow', 'approve', 'Approve a process flow diagram',                   '8.3.4'),
    ('ppap.create',         'ppap',         'create',  'Prepare a PPAP submission',                        '8.3.4.4'),
    ('ppap.approve',        'ppap',         'approve', 'Record a PPAP submission''s customer disposition',  '8.3.4.4')
on conflict (key) do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, p.permission_key
  from roles r
  cross join (values
        ('quality_engineer', 'fmea.create'), ('design_engineer', 'fmea.create'),
        ('manufacturing_engineer', 'fmea.create'), ('engineering_manager', 'fmea.create'),
        ('quality_manager', 'fmea.create'), ('general_manager', 'fmea.create'), ('admin', 'fmea.create'),
        ('engineering_manager', 'fmea.approve'), ('quality_manager', 'fmea.approve'),
        ('general_manager', 'fmea.approve'), ('admin', 'fmea.approve'),

        ('quality_engineer', 'control_plan.create'), ('manufacturing_engineer', 'control_plan.create'),
        ('engineering_manager', 'control_plan.create'), ('quality_manager', 'control_plan.create'),
        ('general_manager', 'control_plan.create'), ('admin', 'control_plan.create'),
        ('engineering_manager', 'control_plan.approve'), ('quality_manager', 'control_plan.approve'),
        ('general_manager', 'control_plan.approve'), ('admin', 'control_plan.approve'),

        ('quality_engineer', 'process_flow.create'), ('manufacturing_engineer', 'process_flow.create'),
        ('engineering_manager', 'process_flow.create'), ('quality_manager', 'process_flow.create'),
        ('general_manager', 'process_flow.create'), ('admin', 'process_flow.create'),
        ('engineering_manager', 'process_flow.approve'), ('quality_manager', 'process_flow.approve'),
        ('general_manager', 'process_flow.approve'), ('admin', 'process_flow.approve'),

        ('quality_engineer', 'ppap.create'), ('quality_manager', 'ppap.create'),
        ('general_manager', 'ppap.create'), ('admin', 'ppap.create'),
        ('quality_manager', 'ppap.approve'), ('engineering_manager', 'ppap.approve'),
        ('general_manager', 'ppap.approve'), ('admin', 'ppap.approve')
    ) as p(role_key, permission_key)
 where r.key = p.role_key
 on conflict do nothing;

-- ---------- record types ----------

insert into record_types (org_id, key, name, prefix, clause)
select o.id, v.key, v.name, v.prefix, v.clause
  from organizations o
  cross join (values
        ('fmea',         'FMEA',                 'FMEA', '8.3.4'),
        ('control_plan', 'Control Plan',         'CP',   '8.5.1.1'),
        ('process_flow', 'Process Flow Diagram', 'PFD',  '8.3.4'),
        ('ppap',         'PPAP Submission',      'PPAP', '8.3.4.4')
     ) as v(key, name, prefix, clause)
 where not exists (
     select 1 from record_types rt where rt.org_id = o.id and rt.key = v.key
 );

-- ---------- workflows ----------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
  from record_types rt
  cross join (values
        ('draft',      'Draft',       1, false),
        ('in_review',  'In Review',   2, false),
        ('approved',   'Approved',    3, true),
        ('superseded', 'Superseded',  4, true)
     ) as v(key, name, pos, terminal)
 where rt.key in ('fmea', 'control_plan', 'process_flow')
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, rt.key || '.' || v.permission_suffix
  from record_types rt
  cross join (values
        ('draft', 'in_review', 'create'),
        ('in_review', 'approved', 'approve')
     ) as v(from_key, to_key, permission_suffix)
 where rt.key in ('fmea', 'control_plan', 'process_flow')
on conflict do nothing;

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
  from record_types rt
  cross join (values
        ('draft',             'Draft',              1, false),
        ('submitted',         'Submitted',          2, false),
        ('interim_approval',  'Interim Approval',   3, false),
        ('approved',          'Approved',           4, true),
        ('rejected',          'Rejected',           5, true)
     ) as v(key, name, pos, terminal)
 where rt.key = 'ppap'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
  from record_types rt
  cross join (values
        ('draft', 'submitted', 'ppap.create'),
        ('submitted', 'interim_approval', 'ppap.approve'),
        ('submitted', 'approved', 'ppap.approve'),
        ('submitted', 'rejected', 'ppap.approve'),
        ('interim_approval', 'approved', 'ppap.approve'),
        ('interim_approval', 'rejected', 'ppap.approve')
     ) as v(from_key, to_key, permission)
 where rt.key = 'ppap'
on conflict do nothing;

-- ---------- forms ----------

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'discipline', 'label', 'Discipline', 'type', 'select', 'required', true, 'section', 'Identification',
                                   'options', jsonb_build_array('Design', 'Process')),
               jsonb_build_object('key', 'process_product_name', 'label', 'Process / Product Name', 'type', 'text', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'responsible', 'label', 'Responsible', 'type', 'user', 'section', 'Identification'),
               jsonb_build_object('key', 'prepared_by', 'label', 'Prepared By', 'type', 'signature', 'section', 'Identification'),
               jsonb_build_object('key', 'fmea_date', 'label', 'FMEA Date (Orig.)', 'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'revision', 'label', 'Rev.', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object(
                   'key', 'fmea_table', 'label', 'FMEA', 'type', 'table', 'section', 'FMEA',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'process_step',       'label', 'Process Step / Input',      'type', 'text',   'width', 62),
                       jsonb_build_object('key', 'failure_mode',       'label', 'Potential Failure Mode',    'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'effect',             'label', 'Potential Failure Effects', 'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'severity',           'label', 'Severity',                  'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'cause',              'label', 'Potential Causes',          'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'occurrence',         'label', 'Occurrence',                'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'current_controls',   'label', 'Current Controls',          'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'detection',          'label', 'Detection',                 'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'rpn',                'label', 'RPN',                       'type', 'number', 'width', 26),
                       jsonb_build_object('key', 'action_recommended', 'label', 'Action Recommended',        'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'responsible',        'label', 'Resp.',                     'type', 'text',   'width', 40),
                       jsonb_build_object('key', 'actions_taken',      'label', 'Actions Taken',             'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'result_severity',    'label', 'Severity (Result)',         'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'result_occurrence',  'label', 'Occurrence (Result)',       'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'result_detection',   'label', 'Detection (Result)',        'type', 'number', 'width', 28),
                       jsonb_build_object('key', 'result_rpn',         'label', 'RPN (Result)',              'type', 'number', 'width', 28)
                   )
               )
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
 where rt.key = 'fmea';

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'process',        'label', 'Process',       'type', 'text', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'customer',       'label', 'Customer',      'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'stakeholder',    'label', 'Stakeholder',   'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'business',       'label', 'Business',      'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'preparer',       'label', 'Preparer',      'type', 'user', 'section', 'Identification'),
               jsonb_build_object('key', 'email',          'label', 'Email',         'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'phone',          'label', 'Phone',         'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'owner',          'label', 'Owner',         'type', 'user', 'section', 'Identification'),
               jsonb_build_object('key', 'reference_no',   'label', 'Reference No.', 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'revision_date',  'label', 'Revision Date', 'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'approval',       'label', 'Approval',      'type', 'signature', 'section', 'Identification'),
               jsonb_build_object(
                   'key', 'control_plan_table', 'label', 'Control Plan', 'type', 'table', 'section', 'Control Plan',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'process',             'label', 'Process',                  'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'process_step',        'label', 'Process Step',             'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'ctq_metric',          'label', 'CTQ / Metric',             'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'spec_lsl',            'label', 'Spec. LSL',                'type', 'text',   'width', 40),
                       jsonb_build_object('key', 'spec_usl',            'label', 'Spec. USL',                'type', 'text',   'width', 40),
                       jsonb_build_object('key', 'measurement_method',  'label', 'Measurement Method',       'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'sample_size',         'label', 'Sample Size',              'type', 'text',   'width', 40),
                       jsonb_build_object('key', 'measure_frequency',   'label', 'Measure Frequency',        'type', 'text',   'width', 50),
                       jsonb_build_object('key', 'responsible_metric',  'label', 'Responsible for Metric',   'type', 'text',   'width', 55),
                       jsonb_build_object('key', 'corrective_action',   'label', 'Corrective Action',        'type', 'text',   'width', 60),
                       jsonb_build_object('key', 'responsible_action',  'label', 'Responsible for Action',   'type', 'text',   'width', 55)
                   )
               )
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
 where rt.key = 'control_plan';

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'part_numbers',             'label', 'Part Number/s',                'type', 'text', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'part_family_description',  'label', 'Part / Family Description',    'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'prepared_by',              'label', 'Prepared By',                  'type', 'user', 'section', 'Identification'),
               jsonb_build_object('key', 'date',                     'label', 'Date',                         'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'eng_change_level',         'label', 'Eng. Change Level',            'type', 'text', 'section', 'Identification'),
               jsonb_build_object(
                   'key', 'process_flow_table', 'label', 'Process Flow', 'type', 'table', 'section', 'Process Flow',
                   'columns', jsonb_build_array(
                       jsonb_build_object('key', 'step',                          'label', 'Step',                                    'type', 'number', 'width', 35),
                       jsonb_build_object('key', 'operation_type',                'label', 'Operation Type',                          'type', 'text',   'width', 90),
                       jsonb_build_object('key', 'operation_description',        'label', 'Operation Description',                   'type', 'text',   'width', 110),
                       jsonb_build_object('key', 'key_product_characteristics',  'label', 'Key Product Characteristics (Outputs)',   'type', 'text',   'width', 110),
                       jsonb_build_object('key', 'key_control_characteristics',  'label', 'Key Control Characteristics (Inputs)',    'type', 'text',   'width', 110),
                       jsonb_build_object('key', 'control_methods',              'label', 'Control Methods',                          'type', 'text',   'width', 105)
                   )
               )
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
 where rt.key = 'process_flow';

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'customer',            'label', 'Customer',              'type', 'text', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'part_number',         'label', 'Part number',           'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'ppap_level',          'label', 'PPAP submission level', 'type', 'select', 'section', 'Identification',
                                   'options', jsonb_build_array('Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5')),
               jsonb_build_object('key', 'submitted_date',      'label', 'Submitted date',        'type', 'date', 'section', 'Identification'),
               jsonb_build_object('key', 'submitted_by',        'label', 'Submitted by',          'type', 'signature', 'section', 'Identification'),
               jsonb_build_object('key', 'customer_disposition','label', 'Customer disposition notes', 'type', 'memo', 'section', 'Identification'),
               jsonb_build_object('key', 'evidence',            'label', 'PSW / package evidence','type', 'file', 'section', 'Identification')
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
 where rt.key = 'ppap';
