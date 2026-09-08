-- ============================================================
-- SCAR form expansion.
--
-- SCAR (Supplier Corrective Action Request) has been a real record
-- type since the beginning - a four-state workflow (draft ->
-- awaiting supplier 8D -> response received -> closed), the
-- scar.issue permission, seeded records - but its form has only ever
-- carried three fields (vendor / process / issue, from migration
-- 011). That is enough to name a problem, not enough to run a
-- supplier 8D and sign it off.
--
-- This publishes a new form version, per org, laid out as an 8D:
-- supplier & part identification, the problem, D3 interim
-- containment, D4 root cause, D5-D6 corrective action, D7 prevent
-- recurrence, and verification / closure. Only field types the
-- renderer already supports (text, memo, number, date, select,
-- signature). "triggered_by" takes the NCR or receiving record that
-- raised the SCAR; POST /api/records links it automatically.
--
-- Same "never overwrite, always publish forward" rule as every other
-- form-schema migration: existing SCAR records keep rendering under
-- whichever version they were raised on.
-- ============================================================

insert into form_versions (record_type_id, version, schema, published_at)
select rt.id,
       coalesce((select max(version) from form_versions fv where fv.record_type_id = rt.id), 0) + 1,
       '{
         "fields": [
           {"key":"supplier",          "label":"Supplier",                       "type":"text",   "required":true, "section":"Supplier & part"},
           {"key":"supplier_contact",  "label":"Supplier contact",               "type":"text",   "section":"Supplier & part"},
           {"key":"supplier_code",     "label":"Supplier code",                  "type":"text",   "section":"Supplier & part"},
           {"key":"part_number",       "label":"Part number",                    "type":"text",   "required":true, "section":"Supplier & part"},
           {"key":"po_or_lot",         "label":"PO / lot / shipment",            "type":"text",   "section":"Supplier & part"},
           {"key":"receiving_report",  "label":"Receiving report no.",           "type":"text",   "section":"Supplier & part"},

           {"key":"defect_description","label":"Defect description",             "type":"memo",   "required":true, "section":"Problem (D2)"},
           {"key":"qty_received",      "label":"Quantity received",              "type":"number", "min":0, "section":"Problem (D2)"},
           {"key":"qty_rejected",     "label":"Quantity rejected",              "type":"number", "min":0, "section":"Problem (D2)"},
           {"key":"detection_point",  "label":"Detection point",                "type":"select", "section":"Problem (D2)",
            "options":["Incoming inspection","In-process","Final inspection","Customer return","Line down"]},
           {"key":"triggered_by",     "label":"Triggered by (NCR / record no.)","type":"text",   "section":"Problem (D2)"},

           {"key":"containment_action","label":"Interim containment action",     "type":"memo",   "section":"Interim containment (D3)"},
           {"key":"containment_scope", "label":"Containment scope",              "type":"select", "section":"Interim containment (D3)",
            "options":["Supplier stock","In-transit","Your stock","All of the above","Not required"]},
           {"key":"containment_date",  "label":"Containment date",               "type":"date",   "section":"Interim containment (D3)"},

           {"key":"root_cause",        "label":"Root cause",                     "type":"memo",   "section":"Root cause (D4)"},
           {"key":"root_cause_method", "label":"Analysis method",               "type":"select", "section":"Root cause (D4)",
            "options":["5 Why","Fishbone / Ishikawa","Full 8D","Other"]},
           {"key":"escape_point",      "label":"Escape point (why it was not caught)","type":"memo","section":"Root cause (D4)"},

           {"key":"corrective_action",     "label":"Corrective action",         "type":"memo",   "section":"Corrective action (D5-D6)"},
           {"key":"corrective_action_owner","label":"Owner at supplier",        "type":"text",   "section":"Corrective action (D5-D6)"},
           {"key":"corrective_action_date","label":"Implementation date",       "type":"date",   "section":"Corrective action (D5-D6)"},
           {"key":"effectiveness",         "label":"% effective",               "type":"number", "min":0, "section":"Corrective action (D5-D6)"},

           {"key":"systemic_action",   "label":"Read-across to similar parts / processes","type":"memo","section":"Prevent recurrence (D7)"},
           {"key":"control_plan_updated","label":"Control plan updated",        "type":"select", "section":"Prevent recurrence (D7)",
            "options":["Yes","No","N/A"]},
           {"key":"pfmea_updated",     "label":"PFMEA updated",                 "type":"select", "section":"Prevent recurrence (D7)",
            "options":["Yes","No","N/A"]},

           {"key":"response_due",      "label":"Supplier response due",         "type":"date",   "section":"Verification & closure"},
           {"key":"verification_method","label":"Verification method",          "type":"select", "section":"Verification & closure",
            "options":["Next-lot inspection","On-site audit","Data review","Layout / dimensional"]},
           {"key":"verified_by",      "label":"Verified by",                   "type":"signature","section":"Verification & closure"},
           {"key":"verification_date", "label":"Verified date",                 "type":"date",   "section":"Verification & closure"},
           {"key":"reject_disposition","label":"Disposition of rejects",        "type":"select", "section":"Verification & closure",
            "options":["Return to supplier","Sort","Rework","Scrap at supplier cost","Use-as-is (concession)"]},
           {"key":"cost_recovered",   "label":"Cost recovered from supplier",   "type":"select", "section":"Verification & closure",
            "options":["Yes","No","Waived"]}
         ],
         "rules": []
       }'::jsonb,
       now()
  from record_types rt
 where rt.key = 'scar';
