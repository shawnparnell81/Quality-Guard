-- ============================================================
-- Publish a form for every record type that never had one.
--
-- seed.sql only ever inserted a form_versions row for ncr. Every
-- other type - capa, eightd, complaint, scar, audit, ecn, risk - has
-- had zero published forms since the project began. The API is
-- correct to 404 "No published form" when asked for one that does
-- not exist; the bug was that one was never created, which meant
-- "Raise a CAPA", "Raise an 8D" and so on never worked at all.
--
-- These are the same plain, generic default fields a newly
-- provisioned company gets from scripts/provision-org.js, published
-- immediately so the existing screens stop 404ing today. A company
-- can still change any of this once the Form Builder supports
-- editing, not only viewing.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id, 1, v.schema::jsonb, now()
from record_types rt
join (values
    ('capa', '{
        "fields": [
            {"key":"source",                  "label":"Source",                     "type":"text"},
            {"key":"problem_statement",        "label":"Problem statement",          "type":"memo", "required":true},
            {"key":"root_cause",               "label":"Root cause",                 "type":"memo"},
            {"key":"corrective_action",        "label":"Corrective action",          "type":"memo"},
            {"key":"effectiveness_criterion",  "label":"How effectiveness is judged","type":"memo"}
        ],
        "rules": []
    }'),

    ('eightd', '{
        "fields": [
            {"key":"customer", "label":"Customer", "type":"text"},
            {"key":"summary",  "label":"Summary",  "type":"memo"}
        ],
        "rules": []
    }'),

    ('complaint', '{
        "fields": [
            {"key":"customer",    "label":"Customer",    "type":"text", "required":true},
            {"key":"contact",     "label":"Contact",     "type":"text"},
            {"key":"part_number", "label":"Part number", "type":"text"},
            {"key":"qty",         "label":"Quantity",    "type":"number", "min":0},
            {"key":"description", "label":"Description", "type":"memo", "required":true}
        ],
        "rules": []
    }'),

    ('scar', '{
        "fields": [
            {"key":"vendor",  "label":"Vendor",  "type":"text", "required":true},
            {"key":"process", "label":"Process", "type":"text"},
            {"key":"issue",   "label":"Issue",   "type":"memo", "required":true}
        ],
        "rules": []
    }'),

    ('audit', '{
        "fields": [
            {"key":"scope",   "label":"Scope",       "type":"text", "required":true},
            {"key":"auditor", "label":"Auditor",     "type":"text"},
            {"key":"planned", "label":"Planned date","type":"date"}
        ],
        "rules": []
    }'),

    ('ecn', '{
        "fields": [
            {"key":"part_number", "label":"Part number",     "type":"text", "required":true},
            {"key":"from_rev",    "label":"From revision",   "type":"text"},
            {"key":"to_rev",      "label":"To revision",     "type":"text"},
            {"key":"reason",      "label":"Reason for change","type":"memo", "required":true}
        ],
        "rules": []
    }'),

    ('risk', '{
        "fields": [
            {"key":"process",    "label":"Process",          "type":"text"},
            {"key":"severity",   "label":"Severity (1-10)",  "type":"number", "min":1},
            {"key":"occurrence", "label":"Occurrence (1-10)","type":"number", "min":1},
            {"key":"detection",  "label":"Detection (1-10)", "type":"number", "min":1},
            {"key":"action",     "label":"Planned action",   "type":"memo"}
        ],
        "rules": []
    }')
) as v(key, schema) on v.key = rt.key
where not exists (
    select 1 from form_versions fv where fv.record_type_id = rt.id
);
