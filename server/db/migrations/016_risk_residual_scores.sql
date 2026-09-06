-- Publishes an updated risk form adding residual (post-mitigation)
-- scoring alongside the existing initial severity/occurrence/
-- detection - a risk record has tracked only one snapshot until now,
-- with no way to record what the priority number looked like *after*
-- the planned action was actually verified effective. rpn and the new
-- residual_rpn are both computed server-side (records.js), never
-- entered directly, so neither can drift from the scores behind it.
insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, coalesce(max(fv.version), 0) + 1,
       jsonb_build_object(
           'fields', jsonb_build_array(
               jsonb_build_object('key', 'process', 'label', 'Process', 'type', 'text'),
               jsonb_build_object('key', 'severity', 'label', 'Severity (1-10)', 'type', 'number', 'min', 1),
               jsonb_build_object('key', 'occurrence', 'label', 'Occurrence (1-10)', 'type', 'number', 'min', 1),
               jsonb_build_object('key', 'detection', 'label', 'Detection (1-10)', 'type', 'number', 'min', 1),
               jsonb_build_object('key', 'action', 'label', 'Planned action', 'type', 'memo'),
               jsonb_build_object('key', 'residual_severity', 'label', 'Residual severity, after mitigation (1-10)', 'type', 'number', 'min', 1),
               jsonb_build_object('key', 'residual_occurrence', 'label', 'Residual occurrence, after mitigation (1-10)', 'type', 'number', 'min', 1),
               jsonb_build_object('key', 'residual_detection', 'label', 'Residual detection, after mitigation (1-10)', 'type', 'number', 'min', 1)
           ),
           'rules', '[]'::jsonb
       ),
       now()
  from record_types rt
  left join form_versions fv on fv.record_type_id = rt.id
 where rt.key = 'risk'
 group by rt.id;
