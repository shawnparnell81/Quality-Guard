-- ============================================================
-- NCR form expansion.
--
-- The NCR form has carried nine fields since the schema-driven form
-- system was introduced: enough to raise and disposition a
-- nonconformance, not enough to capture identification, containment
-- and customer-notification detail a real NCR record calls for. This
-- publishes a new form version, per org, adding that detail using
-- only field types the form renderer already supports.
--
-- Deliberately NOT reproduced here, because the field-type vocabulary
-- (text, memo, number, date, select, link, file, signature, user)
-- has no multi-select or repeating-row type yet: checkbox groups
-- (collapsed to single-choice "select" fields below), containment/
-- corrective-action/verification/approval tables (a table field type
-- does not exist for any record type), and a multi-person signature
-- grid (signature is one auto-signed field, not a block). Root cause
-- analysis, corrective action tracking and effectiveness verification
-- are also not duplicated here - they already exist on the CAPA
-- record type (see 013_audit_independence_and_capa_structure.sql),
-- which this app deliberately keeps as a separate linked record
-- rather than one combined NCR/CAPA form, matching the 8.7/10.2
-- clause split. Likewise "NCR classification" is not repeated as a
-- field - severity (ok/warn/crit) already exists on every record
-- type for exactly that purpose - and closure date/final-disposition-
-- confirmation are not repeated either, since records.closed_at and
-- the close transition itself already carry that fact.
--
-- Same "never overwrite, always publish forward" rule as every other
-- form-schema migration this project has: existing NCR records keep
-- rendering under whichever version they were raised on.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce(prev.version, 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               -- Identification
               jsonb_build_object('key', 'part_number',    'label', 'Part number',                              'type', 'link',   'target', 'parts', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'lot_number',     'label', 'Lot or serial',                             'type', 'text',   'pattern', '^L-[0-9]{5}$', 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'customer_or_supplier', 'label', 'Customer / supplier',                 'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'po_or_job_number',     'label', 'Purchase order / job number',         'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'drawing_reference',    'label', 'Drawing / specification reference',   'type', 'text', 'section', 'Identification'),
               jsonb_build_object('key', 'qty_affected',    'label', 'Quantity nonconforming',                   'type', 'number', 'min', 1, 'required', true, 'section', 'Identification'),
               jsonb_build_object('key', 'qty_inspected',   'label', 'Total quantity inspected',                 'type', 'number', 'min', 0, 'section', 'Identification'),
               jsonb_build_object('key', 'detection_point', 'label', 'Detection point',                          'type', 'select', 'required', true, 'section', 'Identification',
                                   'options', jsonb_build_array('Incoming inspection', 'In-process', 'Final inspection', 'Customer return', 'Internal audit', 'Other')),
               jsonb_build_object('key', 'nonconformance_category', 'label', 'Nonconformance category',          'type', 'select', 'section', 'Identification',
                                   'options', jsonb_build_array('Dimensional', 'Cosmetic / visual', 'Functional', 'Documentation', 'Material', 'Other')),
               jsonb_build_object('key', 'department',      'label', 'Department',                               'type', 'select', 'section', 'Identification',
                                   'options', coalesce(disciplines.options, '[]'::jsonb)),
               jsonb_build_object('key', 'raised_by',        'label', 'Reported by',                             'type', 'signature', 'required', true, 'section', 'Identification'),

               -- Description
               jsonb_build_object('key', 'characteristic',   'label', 'Characteristic',                          'type', 'text', 'section', 'Description'),
               jsonb_build_object('key', 'measured',         'label', 'Measured value',                          'type', 'number', 'section', 'Description'),
               jsonb_build_object('key', 'gage_id',          'label', 'Gage used',                               'type', 'link', 'target', 'gages', 'required', true, 'section', 'Description'),
               jsonb_build_object('key', 'description',      'label', 'Nonconformance description',              'type', 'memo', 'required', true, 'section', 'Description'),
               jsonb_build_object('key', 'reference_standard', 'label', 'Reference standard / requirement violated', 'type', 'text', 'section', 'Description'),
               jsonb_build_object('key', 'photos',           'label', 'Photo evidence',                          'type', 'file', 'max', 5, 'section', 'Description'),

               -- Containment
               jsonb_build_object('key', 'disposition',      'label', 'Disposition',                             'type', 'select', 'required', true, 'section', 'Containment',
                                   'options', jsonb_build_array('Rework', 'Scrap', 'Use-as-is', 'Return to supplier', 'Regrade')),
               jsonb_build_object('key', 'concession_required', 'label', 'Concession / deviation required',      'type', 'select', 'section', 'Containment',
                                   'options', jsonb_build_array('Yes', 'No')),
               jsonb_build_object('key', 'containment_action',   'label', 'Containment action',                  'type', 'memo', 'section', 'Containment'),
               jsonb_build_object('key', 'containment_responsible', 'label', 'Responsible person',               'type', 'user', 'section', 'Containment'),
               jsonb_build_object('key', 'containment_target_date', 'label', 'Target date',                      'type', 'date', 'section', 'Containment'),
               jsonb_build_object('key', 'containment_completion_date', 'label', 'Completion date',              'type', 'date', 'section', 'Containment'),
               jsonb_build_object('key', 'containment_status', 'label', 'Status',                                'type', 'select', 'section', 'Containment',
                                   'options', jsonb_build_array('Open', 'In progress', 'Complete')),
               jsonb_build_object('key', 'containment_verified_by', 'label', 'Containment verified by',          'type', 'signature', 'section', 'Containment'),
               jsonb_build_object('key', 'containment_verified_date', 'label', 'Verified date',                  'type', 'date', 'section', 'Containment'),

               -- Customer & supplier notification
               jsonb_build_object('key', 'customer_notified', 'label', 'Customer / supplier notified',           'type', 'select', 'section', 'Customer & supplier notification',
                                   'options', jsonb_build_array('Yes', 'No')),
               jsonb_build_object('key', 'notification_method', 'label', 'Notification method',                  'type', 'select', 'section', 'Customer & supplier notification',
                                   'options', jsonb_build_array('Email', 'Phone', 'Customer portal', 'Letter', 'Not applicable')),
               jsonb_build_object('key', 'notification_date', 'label', 'Notification date',                      'type', 'date', 'section', 'Customer & supplier notification'),
               jsonb_build_object('key', 'notification_contact', 'label', 'Contact name',                        'type', 'text', 'section', 'Customer & supplier notification'),
               jsonb_build_object('key', 'notification_reference', 'label', 'Reference number',                  'type', 'text', 'section', 'Customer & supplier notification'),
               jsonb_build_object('key', 'customer_approval_required', 'label', 'Customer approval required',    'type', 'select', 'section', 'Customer & supplier notification',
                                   'options', jsonb_build_array('Yes', 'No')),

               -- Closure
               jsonb_build_object('key', 'lessons_learned', 'label', 'Lessons learned / knowledge capture',      'type', 'memo', 'section', 'Closure'),
               jsonb_build_object('key', 'related_documents', 'label', 'Related documents / cross-references',   'type', 'text', 'section', 'Closure')
           ),
           -- Existing conditional rules (use-as-is approval, block on
           -- expired gage cal, required photos on scrap) are display-
           -- only in the Form Builder today - nothing evaluates them -
           -- but they document real intent, so they are carried
           -- forward rather than dropped, same as a Form Builder
           -- republish already does (routes/masterdata.js) when rules
           -- are not the thing being changed.
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
  left join lateral (
        select jsonb_agg(d.discipline order by d.discipline) as options
          from (select distinct discipline from users
                 where org_id = rt.org_id and discipline is not null) d
       ) disciplines on true
 where rt.key = 'ncr';
