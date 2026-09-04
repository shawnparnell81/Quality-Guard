-- ============================================================
-- QUALITYGUARD SEED DATA
--
-- Ridgeline Precision, a fictional machining shop. The numbers here
-- match the ones on the prototype screens, so when the front end is
-- wired to this API nothing on the dashboard changes.
--
-- Safe to re-run: schema.sql drops everything first.
-- ============================================================

-- A fixed organization id keeps the rest of this file readable.
insert into organizations (id, name) values
    ('11111111-1111-1111-1111-111111111111', 'Ridgeline Precision');

insert into sites (org_id, code, name) values
    ('11111111-1111-1111-1111-111111111111', 'P2', 'Plant 2 - Cedar Falls');

-- The certification the header countdown reads from. Two standards,
-- because a real machining shop serving aerospace usually carries both
-- and they fall due at different times.
insert into certifications
    (org_id, site_id, standard, registrar, certificate_number,
     issued_on, expires_on, next_audit_on, audit_type, scope)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       v.standard, v.registrar, v.number,
       v.issued, v.expires, v.next_audit, v.audit_type, v.scope
from (values
        ('ISO 9001:2015', 'Bergstrom Certification', 'FM-884210',
         '2024-10-21'::date, '2027-10-20'::date, '2026-10-21'::date, 'surveillance',
         'Precision machining of metallic components'),
        ('AS9100D',       'Bergstrom Certification', 'AS-884211',
         '2025-03-14'::date, '2028-03-13'::date, '2027-03-16'::date, 'surveillance',
         'Precision machining of aerospace components')
     ) as v(standard, registrar, number, issued, expires, next_audit, audit_type, scope);


-- ============================================================
-- Roles, permissions, and who may do what
--
-- This grid is the clause 5.3 record. An auditor asking "who is
-- authorised to approve a use-as-is disposition" is answered from
-- these three tables, not from someone's memory.
-- ============================================================

insert into roles (key, name, description, position) values
    ('operator',              'Operator',               'Runs production. Raises problems, does not decide their fate.',        1),
    ('quality_inspector',     'Quality Inspector',      'Verifies product against the drawing. Reads widely, writes narrowly.', 2),
    ('quality_tech',          'Quality Tech',           'Investigates, dispositions routine nonconformance, calibrates.',       3),
    ('quality_engineer',      'Quality Engineer',       'Owns quality tooling and MRB. Signs off dispositions.',                4),
    ('design_engineer',       'Design Engineer',        'Creates and edits product drawings. Cannot release them.',             5),
    ('manufacturing_engineer','Manufacturing Engineer', 'Owns process, tooling and work instructions.',                         6),
    ('document_controller',   'Document Controller',    'Custodian of controlled documents and the revision record.',           7),
    ('purchasing_manager',    'Purchasing Manager',     'Owns the supply base and supplier corrective action.',                 8),
    ('production_manager',    'Production Manager',     'Owns the schedule, the floor, and production holds.',                  9),
    ('engineering_manager',   'Engineering Manager',    'Releases drawings and changes. Signs MRB for design intent.',         10),
    ('quality_manager',       'Quality Manager',        'Final quality authority. Approves use-as-is, closes CAPA.',           11),
    ('general_manager',       'General Manager',        'Accountable for the whole QMS. Holds every authority.',               12),
    ('admin',                 'Administrator',          'Manages users and access. Deliberately holds no quality authority.',  13);

-- Read and write are separate permissions throughout. That split is
-- what lets drawings be restricted to engineering while everyone can
-- see the nonconformance that references them.
insert into permissions (key, resource, action, description, clause) values
    ('ncr.read',           'ncr',       'read',        'View nonconformances',                        '8.7'),
    ('ncr.create',         'ncr',       'create',      'Raise a nonconformance',                      '8.7'),
    ('ncr.contain',        'ncr',       'contain',     'Confirm containment and segregation',         '8.7'),
    ('ncr.disposition',    'ncr',       'disposition', 'Select a routine disposition',                '8.7'),
    ('ncr.use_as_is',      'ncr',       'use_as_is',   'Approve a use-as-is disposition',             '8.7'),
    ('ncr.close',          'ncr',       'close',       'Close a nonconformance',                      '8.7'),
    ('mrb.signoff',        'mrb',       'signoff',     'Sign off a material review board decision',   '8.7'),

    ('capa.read',          'capa',      'read',        'View corrective actions',                     '10.2'),
    ('capa.create',        'capa',      'create',      'Raise a corrective action',                   '10.2'),
    ('capa.close',         'capa',      'close',       'Close a CAPA after effectiveness check',      '10.2'),

    ('complaint.read',     'complaint', 'read',        'View customer complaints',                    '8.2.1'),
    ('complaint.create',   'complaint', 'create',      'Log a customer complaint',                    '8.2.1'),
    ('complaint.respond',  'complaint', 'respond',     'Send a formal response to a customer',        '8.2.1'),

    ('document.read',      'document',  'read',        'View controlled documents',                   '7.5'),
    ('document.create',    'document',  'create',      'Draft a controlled document',                 '7.5'),
    ('document.approve',   'document',  'approve',     'Approve a document revision',                 '7.5'),
    ('document.release',   'document',  'release',     'Release a revision to the shop floor',        '7.5'),
    ('document.obsolete',  'document',  'obsolete',    'Withdraw a document from use',                '7.5'),

    ('drawing.read',       'drawing',   'read',        'View engineering drawings',                   '8.3'),
    ('drawing.create',     'drawing',   'create',      'Create a new drawing',                        '8.3'),
    ('drawing.edit',       'drawing',   'edit',        'Edit a drawing in work',                      '8.3'),
    ('drawing.release',    'drawing',   'release',     'Release a drawing revision to production',    '8.3'),

    ('change.create',      'change',    'create',      'Raise an engineering change notice',          '8.5.6'),
    ('change.approve',     'change',    'approve',     'Approve an engineering change notice',        '8.5.6'),

    ('vendor.read',        'vendor',    'read',        'View the approved vendor list',               '8.4'),
    ('vendor.approve',     'vendor',    'approve',     'Add a vendor to the approved list',           '8.4'),
    ('vendor.suspend',     'vendor',    'suspend',     'Suspend or remove an approved vendor',        '8.4'),
    ('scar.issue',         'scar',      'issue',       'Issue a supplier corrective action request',  '8.4'),

    ('production.read',    'production','read',        'View work orders and travellers',             '8.5.1'),
    ('production.hold',    'production','hold',        'Place a work order on quality hold',          '8.5.1'),
    ('production.release', 'production','release',     'Release a work order back to the floor',      '8.5.1'),

    ('shipping.read',      'shipping',  'read',        'View shipments',                              '8.6'),
    ('shipping.release',   'shipping',  'release',     'Authorise release of product to a customer',  '8.6'),

    ('gage.read',          'gage',      'read',        'View the gage register',                      '7.1.5'),
    ('gage.calibrate',     'gage',      'calibrate',   'Record a calibration result',                 '7.1.5'),
    ('gage.retire',        'gage',      'retire',      'Remove a gage from service',                  '7.1.5'),

    ('training.read',      'training',  'read',        'View the competency matrix',                  '7.2'),
    ('training.record',    'training',  'record',      'Record that someone has been trained',        '7.2'),

    ('audit.read',         'audit',     'read',        'View audits and findings',                    '9.2'),
    ('audit.schedule',     'audit',     'schedule',    'Schedule an internal audit',                  '9.2'),
    ('audit.close',        'audit',     'close',       'Close an audit and its findings',             '9.2'),

    ('risk.read',          'risk',      'read',        'View the risk register',                      '6.1'),
    ('risk.manage',        'risk',      'manage',      'Add or accept a risk on the register',        '6.1'),

    ('user.read',          'user',      'read',        'View people and their roles',                 '5.3'),
    ('user.create',        'user',      'create',      'Add a person to the system',                  '5.3'),
    ('user.edit',          'user',      'edit',        'Change a person''s role or details',          '5.3'),
    ('user.deactivate',    'user',      'deactivate',  'Remove a person''s access',                   '5.3'),
    ('user.reset_password','user',      'reset_password','Issue someone a new temporary password',    '5.3'),
    ('roles.manage',       'roles',     'manage',      'Change which role carries which authority',   '5.3');


-- Grants, written as one row per role with its list. unnest expands
-- them, which keeps the intent readable instead of 200 near-identical
-- lines.
insert into role_permissions (role_key, permission_key)
select v.role, unnest(v.perms)
from (values
    -- Raises problems, reads what is needed to do the job. Separating
    -- who finds a defect from who decides its fate is the whole point
    -- of clause 8.7.
    ('operator', array[
        'ncr.read','ncr.create','production.read','document.read',
        'drawing.read','training.read']),

    -- Wide read, narrow write. Verifies and releases, does not decide.
    ('quality_inspector', array[
        'ncr.read','ncr.create','ncr.contain','capa.read','complaint.read',
        'document.read','drawing.read','production.read','shipping.read',
        'shipping.release','gage.read','training.read','audit.read']),

    ('quality_tech', array[
        'ncr.read','ncr.create','ncr.contain','ncr.disposition',
        'capa.read','capa.create','complaint.read','complaint.create',
        'document.read','drawing.read','production.read','production.hold',
        'shipping.read','gage.read','gage.calibrate','training.read',
        'training.record','audit.read','risk.read','vendor.read','scar.issue']),

    ('quality_engineer', array[
        'ncr.read','ncr.create','ncr.contain','ncr.disposition','mrb.signoff',
        'capa.read','capa.create','complaint.read','complaint.create',
        'document.read','document.create','drawing.read',
        'production.read','production.hold','shipping.read',
        'gage.read','gage.calibrate','training.read','training.record',
        'audit.read','audit.schedule','risk.read','risk.manage',
        'vendor.read','scar.issue']),

    -- Draws. Deliberately cannot release its own work: clause 8.3
    -- expects design output to be verified by someone else.
    ('design_engineer', array[
        'ncr.read','ncr.create','capa.read',
        'document.read','document.create',
        'drawing.read','drawing.create','drawing.edit',
        'change.create','production.read','training.read']),

    ('manufacturing_engineer', array[
        'ncr.read','ncr.create','capa.read','capa.create',
        'document.read','document.create','drawing.read',
        'change.create','production.read','production.hold','production.release',
        'gage.read','training.read','training.record']),

    ('document_controller', array[
        'ncr.read','document.read','document.create','document.approve',
        'document.release','document.obsolete','drawing.read',
        'training.read','training.record','audit.read']),

    ('purchasing_manager', array[
        'ncr.read','capa.read','document.read',
        'vendor.read','vendor.approve','vendor.suspend','scar.issue',
        'production.read','audit.read','risk.read']),

    ('production_manager', array[
        'ncr.read','ncr.create','ncr.contain','capa.read',
        'document.read','drawing.read',
        'production.read','production.hold','production.release',
        'shipping.read','training.read','training.record','risk.read']),

    -- Releases design output and signs MRB for design intent, which is
    -- the authority a design engineer is missing.
    ('engineering_manager', array[
        'ncr.read','ncr.create','ncr.disposition','mrb.signoff',
        'capa.read','capa.create',
        'document.read','document.create','document.approve',
        'drawing.read','drawing.create','drawing.edit','drawing.release',
        'change.create','change.approve',
        'production.read','production.release','training.read',
        'audit.read','risk.read','risk.manage','user.read']),

    ('quality_manager', array[
        'ncr.read','ncr.create','ncr.contain','ncr.disposition','ncr.use_as_is',
        'ncr.close','mrb.signoff',
        'capa.read','capa.create','capa.close',
        'complaint.read','complaint.create','complaint.respond',
        'document.read','document.create','document.approve','document.release',
        'document.obsolete','drawing.read','change.create','change.approve',
        'vendor.read','vendor.approve','vendor.suspend','scar.issue',
        'production.read','production.hold','production.release',
        'shipping.read','shipping.release',
        'gage.read','gage.calibrate','gage.retire',
        'training.read','training.record',
        'audit.read','audit.schedule','audit.close',
        'risk.read','risk.manage','user.read'])
) as v(role, perms);

-- The general manager is accountable for the QMS under clause 5.1, so
-- the grant is written as "everything" rather than a list somebody has
-- to remember to extend when a permission is added.
insert into role_permissions (role_key, permission_key)
select 'general_manager', key from permissions;

-- The administrator can see everything and change nobody's product.
-- Expressed as a rule rather than a hand-typed list, because the
-- separation is the point: an auditor checks that whoever administers
-- the system cannot also disposition parts.
insert into role_permissions (role_key, permission_key)
select 'admin', key from permissions
 where action = 'read' or resource in ('user', 'roles');


-- ============================================================
-- People
-- ============================================================

insert into users (org_id, email, full_name, initials, role, discipline, job_title) values
    ('11111111-1111-1111-1111-111111111111', 'r.sandoval@ridgeline.example',   'R. Sandoval',    'RS', 'general_manager',        null,            'General Manager'),
    ('11111111-1111-1111-1111-111111111111', 'i.brannigan@ridgeline.example',  'I. Brannigan',   'IB', 'admin',                  'IT',            'Systems Administrator'),

    ('11111111-1111-1111-1111-111111111111', 's.parnell@ridgeline.example',    'S. Parnell',     'SP', 'quality_manager',        'Quality',       'Quality Manager'),
    ('11111111-1111-1111-1111-111111111111', 'm.okonkwo@ridgeline.example',    'M. Okonkwo',     'MO', 'quality_engineer',       'Quality',       'Quality Engineer'),
    ('11111111-1111-1111-1111-111111111111', 't.alvarez@ridgeline.example',    'T. Alvarez',     'TA', 'quality_tech',           'Quality',       'Quality Technician'),
    ('11111111-1111-1111-1111-111111111111', 'd.whitfield@ridgeline.example',  'D. Whitfield',   'DW', 'quality_tech',           'Quality',       'Calibration Technician'),
    ('11111111-1111-1111-1111-111111111111', 'j.ferreira@ridgeline.example',   'J. Ferreira',    'JF', 'quality_inspector',      'Quality',       'Final Inspector'),
    ('11111111-1111-1111-1111-111111111111', 'l.castellanos@ridgeline.example','L. Castellanos', 'LC', 'quality_inspector',      'Quality',       'Receiving Inspector'),

    ('11111111-1111-1111-1111-111111111111', 'r.vandermeer@ridgeline.example', 'R. Vandermeer',  'RV', 'engineering_manager',    'Engineering',   'Engineering Manager'),
    ('11111111-1111-1111-1111-111111111111', 'h.okafor@ridgeline.example',     'H. Okafor',      'HO', 'design_engineer',        'Mechanical',    'Design Engineer'),
    ('11111111-1111-1111-1111-111111111111', 'n.petrov@ridgeline.example',     'N. Petrov',      'NP', 'design_engineer',        'Electrical',    'Design Engineer'),
    ('11111111-1111-1111-1111-111111111111', 'c.bergstrom@ridgeline.example',  'C. Bergstrom',   'CB', 'manufacturing_engineer', 'Manufacturing', 'Manufacturing Engineer'),

    ('11111111-1111-1111-1111-111111111111', 'g.halloway@ridgeline.example',   'G. Halloway',    'GH', 'production_manager',     'Production',    'Production Manager'),
    ('11111111-1111-1111-1111-111111111111', 'k.reyes@ridgeline.example',      'K. Reyes',       'KR', 'operator',               'Production',    'Shipping Lead'),
    ('11111111-1111-1111-1111-111111111111', 'r.delacroix@ridgeline.example',  'R. Delacroix',   'RD', 'operator',               'Production',    'CNC Operator'),
    ('11111111-1111-1111-1111-111111111111', 'p.nakamura@ridgeline.example',   'P. Nakamura',    'PN', 'operator',               'Production',    'CNC Operator'),

    ('11111111-1111-1111-1111-111111111111', 'a.moreau@ridgeline.example',     'A. Moreau',      'AM', 'document_controller',    'Quality',       'Document Controller'),
    ('11111111-1111-1111-1111-111111111111', 'f.osei@ridgeline.example',       'F. Osei',        'FO', 'purchasing_manager',     'Purchasing',    'Purchasing Manager');


-- ============================================================
-- Record types, one per quality event module
-- ============================================================

insert into record_types (org_id, key, name, prefix, clause) values
    ('11111111-1111-1111-1111-111111111111', 'ncr',       'Nonconformance',        'NCR',  '8.7'),
    ('11111111-1111-1111-1111-111111111111', 'capa',      'Corrective Action',     'CAPA', '10.2'),
    ('11111111-1111-1111-1111-111111111111', 'eightd',    '8D Investigation',      '8D',   '10.2'),
    ('11111111-1111-1111-1111-111111111111', 'complaint', 'Customer Complaint',    'COMP', '8.2.1'),
    ('11111111-1111-1111-1111-111111111111', 'scar',      'Supplier Corrective',   'SCAR', '8.4'),
    ('11111111-1111-1111-1111-111111111111', 'audit',     'Internal Audit',        'AUD',  '9.2'),
    ('11111111-1111-1111-1111-111111111111', 'ecn',       'Engineering Change',    'ECN',  '8.5.6'),
    ('11111111-1111-1111-1111-111111111111', 'risk',      'Risk or Opportunity',   'R',    '6.1');


-- NCR workflow, matching the state machine on the Workflows screen.
insert into workflow_states (record_type_id, key, name, position, is_terminal)
select id, s.key, s.name, s.pos, s.terminal
from record_types,
     (values
        ('draft',       'Draft',                1, false),
        ('containment', 'Containment',          2, false),
        ('mrb',         'MRB review',           3, false),
        ('disposition', 'Disposition executed', 4, false),
        ('verify',      'Verification',         5, false),
        ('closed',      'Closed',               6, true)
     ) as s(key, name, pos, terminal)
where record_types.key = 'ncr'
  and record_types.org_id = '11111111-1111-1111-1111-111111111111';

insert into workflow_transitions (record_type_id, from_state, to_state, required_role)
select id, tr.from_key, tr.to_key, tr.role
from record_types,
     (values
        ('draft',       'containment', 'quality_tech'),
        ('containment', 'mrb',         'quality_tech'),
        ('mrb',         'disposition', 'quality_manager'),
        ('disposition', 'verify',      'quality_inspector'),
        ('verify',      'closed',      'quality_manager')
     ) as tr(from_key, to_key, role)
where record_types.key = 'ncr'
  and record_types.org_id = '11111111-1111-1111-1111-111111111111';


-- The NCR form, version 4. This is the payload the Form Builder edits.
insert into form_versions (record_type_id, version, schema, published_at, published_by)
select rt.id, 4,
       '{
          "fields": [
            {"key":"part_number",   "label":"Part number",       "type":"link",   "target":"parts",  "required":true},
            {"key":"lot_number",    "label":"Lot or serial",     "type":"text",   "required":true, "pattern":"^L-[0-9]{5}$"},
            {"key":"qty_affected",  "label":"Quantity affected", "type":"number", "required":true, "min":1},
            {"key":"characteristic","label":"Characteristic",    "type":"text"},
            {"key":"measured",      "label":"Measured value",    "type":"number"},
            {"key":"gage_id",       "label":"Gage used",         "type":"link",   "target":"gages",  "required":true},
            {"key":"disposition",   "label":"Disposition",       "type":"select", "required":true,
             "options":["Rework","Scrap","Use-as-is","Return to supplier","Regrade"]},
            {"key":"photos",        "label":"Photo evidence",    "type":"file",   "max":5},
            {"key":"raised_by",     "label":"Raised by",         "type":"signature","required":true}
          ],
          "rules": [
            {"when":"disposition == ''Use-as-is''", "then":"require_approval", "role":"quality_manager"},
            {"when":"qty_affected > 500",           "then":"notify",          "role":"quality_manager"},
            {"when":"gage_cal_expired",             "then":"block_submit"},
            {"when":"disposition == ''Scrap''",     "then":"require_field",   "field":"photos"}
          ]
        }'::jsonb,
       now(),
       (select id from users where initials = 'SP')
from record_types rt
where rt.key = 'ncr' and rt.org_id = '11111111-1111-1111-1111-111111111111';


-- ============================================================
-- Parts
-- ============================================================

insert into parts (org_id, part_number, description, revision, customer) values
    ('11111111-1111-1111-1111-111111111111', 'RP-4471-A', 'Housing, hydraulic manifold', 'D', 'Voss Automotive'),
    ('11111111-1111-1111-1111-111111111111', 'RP-2210-C', 'Shaft, drive spline',         'G', 'Kestrel Aerospace'),
    ('11111111-1111-1111-1111-111111111111', 'RP-9004-B', 'Bracket, mounting',           'C', 'Voss Automotive'),
    ('11111111-1111-1111-1111-111111111111', 'RP-8890-D', 'Cap, end closure',            'B', 'Dunmore Industrial'),
    ('11111111-1111-1111-1111-111111111111', 'RP-6612-E', 'Retainer ring',               'A', 'Halberd Motion');


-- ============================================================
-- Lots. The parent chain is what draws the genealogy tree.
-- ============================================================

insert into lots (org_id, lot_number, part_id, heat_number, qty, location, status) values
    ('11111111-1111-1111-1111-111111111111', 'RM-1018-HR-55340', null, 'HEAT-4471982', 3200, 'Raw stock A', 'released');

insert into lots (org_id, lot_number, part_id, parent_lot_id, heat_number, qty, location, status)
select '11111111-1111-1111-1111-111111111111', v.lot,
       (select id from parts where part_number = v.part),
       (select id from lots  where lot_number  = 'RM-1018-HR-55340'),
       'HEAT-4471982', v.qty, v.loc, v.st
from (values
        ('L-88213', 'RP-4471-A',  400, 'Red-tag cage 2', 'on_hold'),
        ('L-88221', 'RP-6612-E',  880, 'Shipped',        'shipped')
     ) as v(lot, part, qty, loc, st);

insert into lots (org_id, lot_number, part_id, heat_number, qty, location, status)
select '11111111-1111-1111-1111-111111111111', v.lot,
       (select id from parts where part_number = v.part),
       v.heat, v.qty, v.loc, v.st
from (values
        ('L-88190', 'RP-2210-C', 'HEAT-4471760',  150, 'Red-tag cage 1',       'on_hold'),
        ('L-88240', 'RP-9004-B', 'HEAT-4472104', 2000, 'Finished goods',       'released'),
        ('L-88102', 'RP-4471-A', 'HEAT-4471655',   96, 'Bin A-14-03',          'released'),
        ('L-87944', 'RP-9004-B', 'HEAT-4471402', 1200, 'Shipped',              'shipped'),
        ('L-88244', 'RP-8890-D', 'HEAT-4472180',  640, 'WIP cell 3',           'released')
     ) as v(lot, part, heat, qty, loc, st);


-- ============================================================
-- Vendors
-- ============================================================

insert into vendors (org_id, name, scope, cert_type, cert_expires, otd_pct, ppm, grade, status) values
    ('11111111-1111-1111-1111-111111111111', 'Halstead Steel',     'Bar stock 1018 / 4140',      'ISO 9001', '2027-04-14', 99.10,  180, 'A', 'approved'),
    ('11111111-1111-1111-1111-111111111111', 'Corveil Coatings',   'Black oxide, passivation',   'ISO 9001', '2027-02-03', 94.60, 2140, 'C', 'on_watch'),
    ('11111111-1111-1111-1111-111111111111', 'Ainsley Tool',       'Perishable tooling',          null,       null,        98.80,    0, 'A', 'approved'),
    ('11111111-1111-1111-1111-111111111111', 'Nordvik Heat Treat', 'Stress relief, carburize',   'AS9100',   '2026-10-28', 91.20, 3900, 'D', 'scar_open'),
    ('11111111-1111-1111-1111-111111111111', 'Brightline Plating', 'Zinc, electroless nickel',   'ISO 9001', '2027-07-19', 97.90,  410, 'A', 'approved'),
    ('11111111-1111-1111-1111-111111111111', 'Merrow Fasteners',   'Class 10.9 hardware',        'ISO 9001',  null,         null, null, null, 'onboarding');


-- ============================================================
-- Gages
-- ============================================================

insert into gages (org_id, gage_id, description, range_text, interval_months, last_cal, next_due) values
    ('11111111-1111-1111-1111-111111111111', 'MIC-114',  'Outside micrometer',          '0-1 in',       12, '2025-08-31', '2026-08-31'),
    ('11111111-1111-1111-1111-111111111111', 'CMM-002',  'Zeiss Contura G2',            '700x1000x600', 12, '2025-09-11', '2026-09-11'),
    ('11111111-1111-1111-1111-111111111111', 'TG-0440',  'Thread ring gage 1/2-13 UNC', null,            6, '2026-03-14', '2026-09-14'),
    ('11111111-1111-1111-1111-111111111111', 'BG-0221',  'Bore gage, dial',             '12-14 mm',      6, '2026-06-02', '2026-12-02'),
    ('11111111-1111-1111-1111-111111111111', 'HG-018',   'Rockwell hardness tester',    'HRC 20-70',    12, '2025-09-22', '2026-09-22'),
    ('11111111-1111-1111-1111-111111111111', 'SG-0071',  'Granite surface plate, A',    '24x36 in',     24, '2024-09-28', '2026-09-28');


-- ============================================================
-- Documents
-- ============================================================

insert into documents (org_id, doc_number, title, owner_id, current_revision, status)
select '11111111-1111-1111-1111-111111111111', v.num, v.title,
       (select id from users where initials = v.owner), v.rev, v.st
from (values
        ('QM-001',   'Quality Manual',                    'SP', 'H', 'released'),
        ('SOP-0102', 'Control of Nonconforming Output',   'MO', 'F', 'released'),
        -- Rev C is the released revision. Rev D is sitting in approval,
        -- which is why status is in_approval but current_revision is
        -- still C: a draft supersedes nothing until it is released.
        ('WI-0412',  'Pack-out and Lot Identification',   'KR', 'C', 'in_approval'),
        ('SOP-0220', 'Calibration System',                'DW', 'C', 'released'),
        ('FRM-0031', '8D Report Template',                'SP', 'B', 'released'),
        ('SOP-0088', 'Supplier Approval and Monitoring',  'TA', null, 'draft'),
        ('WI-0388',  'Finish Bore Operation',             'MO', 'B', 'released')
     ) as v(num, title, owner, rev, st);

insert into document_revisions (document_id, revision, change_summary, author_id, approved_by, effective_date)
select (select id from documents where doc_number = 'WI-0412'), v.rev, v.summary,
       (select id from users where initials = 'KR'),
       case when v.approver is null then null else (select id from users where initials = v.approver) end,
       v.eff
from (values
        ('D', 'Require new traveler on any partial lot merge', null, null::date),
        ('C', 'Added label revision check at pack-out',        'SP', '2026-04-18'::date),
        ('B', 'Clarified pallet stacking limits',              'SP', '2025-11-07'::date),
        ('A', 'Initial release',                               'SP', '2025-02-15'::date)
     ) as v(rev, summary, approver, eff);


-- ============================================================
-- Training. A gap is the ABSENCE of a row at the current revision.
-- ============================================================

insert into training_records (org_id, user_id, document_id, revision_trained, trained_on, next_review)
select '11111111-1111-1111-1111-111111111111',
       (select id from users where initials = v.who),
       (select id from documents where doc_number = v.doc),
       v.rev, v.trained, v.review
from (values
        ('MO', 'WI-0412',  'C', '2026-04-20'::date, '2027-03-01'::date),
        ('MO', 'WI-0388',  'B', '2026-01-15'::date, '2027-03-01'::date),
        ('MO', 'SOP-0102', 'F', '2026-03-18'::date, '2027-03-01'::date),
        ('MO', 'SOP-0220', 'C', '2025-11-12'::date, '2027-03-01'::date),
        ('RD', 'WI-0388',  'B', '2026-01-15'::date, '2026-11-01'::date),
        ('RD', 'SOP-0102', 'F', '2026-03-18'::date, '2026-11-01'::date),
        ('PN', 'WI-0412',  'C', '2026-04-22'::date, '2027-01-01'::date),
        ('PN', 'SOP-0102', 'F', '2026-03-18'::date, '2027-01-01'::date),
        ('JF', 'WI-0412',  'C', '2026-04-22'::date, '2027-08-01'::date),
        ('JF', 'WI-0388',  'B', '2026-01-15'::date, '2027-08-01'::date),
        ('JF', 'SOP-0220', 'C', '2025-11-12'::date, '2027-08-01'::date),
        ('KR', 'WI-0412',  'C', '2026-04-20'::date, '2027-05-01'::date),
        ('KR', 'SOP-0102', 'F', '2026-03-18'::date, '2027-05-01'::date),
        ('DW', 'WI-0412',  'C', '2026-04-20'::date, '2027-02-01'::date),
        ('DW', 'WI-0388',  'B', '2026-01-15'::date, '2027-02-01'::date),
        ('DW', 'SOP-0102', 'F', '2026-03-18'::date, '2027-02-01'::date),
        ('DW', 'SOP-0220', 'C', '2025-11-12'::date, '2027-02-01'::date),
        ('TA', 'WI-0412',  'C', '2026-04-20'::date, '2027-06-01'::date),
        ('TA', 'WI-0388',  'B', '2026-01-15'::date, '2027-06-01'::date),
        ('TA', 'SOP-0102', 'F', '2026-03-18'::date, '2027-06-01'::date),
        ('TA', 'SOP-0220', 'C', '2025-11-12'::date, '2027-06-01'::date)
     ) as v(who, doc, rev, trained, review);


-- Which documents each shop-floor role must be trained on. Quality
-- managers and above are not listed, so they generate no gaps.
insert into document_requirements (org_id, role, document_id)
select '11111111-1111-1111-1111-111111111111', v.role,
       (select id from documents where doc_number = v.doc)
from (values
        ('operator',              'WI-0412'),
        ('operator',              'WI-0388'),
        ('operator',              'SOP-0102'),
        ('quality_inspector',     'WI-0412'),
        ('quality_inspector',     'WI-0388'),
        ('quality_inspector',     'SOP-0102'),
        ('quality_inspector',     'SOP-0220'),
        ('quality_tech',          'WI-0412'),
        ('quality_tech',          'WI-0388'),
        ('quality_tech',          'SOP-0102'),
        ('quality_tech',          'SOP-0220'),
        ('quality_engineer',      'SOP-0102'),
        ('quality_engineer',      'FRM-0031'),
        ('manufacturing_engineer','WI-0388'),
        ('manufacturing_engineer','SOP-0102'),
        ('production_manager',    'WI-0412'),
        ('production_manager',    'SOP-0102'),
        ('document_controller',   'QM-001'),
        ('purchasing_manager',    'SOP-0088')
     ) as v(role, doc);


-- ============================================================
-- Work orders
-- ============================================================

insert into work_orders (org_id, wo_number, part_id, lot_id, qty, current_op, total_ops, cell, status)
select '11111111-1111-1111-1111-111111111111', v.wo,
       (select id from parts where part_number = v.part),
       (select id from lots  where lot_number  = v.lot),
       v.qty, v.op, v.total, v.cell, v.st
from (values
        ('WO-31882', 'RP-4471-A', 'L-88213',  400, '30', '70', 'Cell 4', 'quality_hold'),
        ('WO-31879', 'RP-2210-C', 'L-88190',  150, '40', '60', 'Cell 2', 'mrb_hold'),
        ('WO-31890', 'RP-9004-B', 'L-88240', 2000, '20', '50', 'Cell 1', 'running'),
        ('WO-31891', 'RP-8890-D', 'L-88244',  640, '10', '60', 'Cell 3', 'running'),
        ('WO-31885', 'RP-6612-E', 'L-88221',  880, '50', '50', 'Cell 2', 'complete')
     ) as v(wo, part, lot, qty, op, total, cell, st);


-- ============================================================
-- Quality events. All of these live in ONE table.
-- ============================================================

-- Nonconformance
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, form_version, opened_at, due_at, closed_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'ncr' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, 4, v.opened::timestamptz, v.due::timestamptz, v.closed::timestamptz
from (values
        ('NCR-2026-0142', 'Bore DIA 12.70 measured 12.719, over high limit', 'containment', 'crit', 'MO',
         '{"part_number":"RP-4471-A","lot_number":"L-88213","qty_affected":340,"characteristic":"DIA 12.70 +0.013/-0.000","measured":12.719,"gage_id":"BG-0221","disposition":"Rework","work_order":"WO-31882","operation":"Op 30, finish bore","detected_at":"Final inspection","containment":"Lot segregated to red-tag cage 2, WIP hold applied"}',
         '2026-09-01 16:05', '2026-09-15', null),

        ('NCR-2026-0141', 'Surface finish 3.2 Ra spec, measured 5.1 Ra at op 40', 'mrb', 'crit', 'TA',
         '{"part_number":"RP-2210-C","lot_number":"L-88190","qty_affected":88,"characteristic":"3.2 Ra max","measured":5.1,"gage_id":"SG-0071","disposition":"MRB","work_order":"WO-31879","operation":"Op 40"}',
         '2026-08-30 11:20', '2026-09-13', null),

        ('NCR-2026-0140', 'Burr at op 60', 'closed', 'warn', 'JF',
         '{"part_number":"RP-8890-D","lot_number":"L-88244","qty_affected":12,"disposition":"Rework"}',
         '2026-08-19 08:40', '2026-09-02', '2026-08-28 15:10'),

        ('NCR-2026-0138', 'Incoming bar stock cert missing heat number', 'containment', 'warn', 'DW',
         '{"part_number":"RM-1018-HR","lot_number":"L-88102","qty_affected":2400,"disposition":"Return to supplier","purchase_order":"PO-55401"}',
         '2026-08-26 09:15', '2026-09-09', null),

        ('NCR-2026-0135', 'Packaging label revision not applied at pack-out', 'verify', 'ok', 'KR',
         '{"part_number":"RP-4471-A","lot_number":"L-88102","qty_affected":96,"disposition":"Use-as-is"}',
         '2026-08-23 13:50', '2026-09-06', null),

        ('NCR-2026-0143', 'Case hardness below spec on carburized parts', 'containment', 'crit', 'DW',
         '{"part_number":"RP-2210-C","lot_number":"L-88190","qty_affected":150,"characteristic":"HRC 58-62 case","measured":54.2,"gage_id":"HG-018","disposition":"Return to supplier"}',
         '2026-09-02 10:30', '2026-09-16', null),

        ('NCR-2026-0136', 'Thread gage reject, 1/2-13 UNC', 'mrb', 'warn', 'JF',
         '{"part_number":"RP-6612-E","lot_number":"L-88221","qty_affected":22,"gage_id":"TG-0440","disposition":"Rework"}',
         '2026-08-24 14:00', '2026-09-07', null),

        ('NCR-2026-0137', 'True position out of tolerance, 0.08 against 0.05 MMC', 'containment', 'warn', 'MO',
         '{"part_number":"RP-4471-A","lot_number":"L-88102","qty_affected":18,"gage_id":"CMM-002","disposition":"Scrap"}',
         '2026-08-25 07:45', '2026-09-08', null),

        ('NCR-2026-0139', 'Mixed lot identified at pack-out', 'mrb', 'crit', 'KR',
         '{"part_number":"RP-9004-B","lot_number":"L-87944","qty_affected":1200,"disposition":"Use-as-is"}',
         '2026-08-28 16:30', '2026-09-11', null),

        ('NCR-2026-0144', 'Coating thickness under minimum', 'containment', 'warn', 'TA',
         '{"part_number":"RP-9004-B","lot_number":"L-88240","qty_affected":64,"disposition":"Rework"}',
         '2026-09-02 15:10', '2026-09-16', null),

        ('NCR-2026-0145', 'Chamfer missing, op 50', 'containment', 'ok', 'JF',
         '{"part_number":"RP-8890-D","lot_number":"L-88244","qty_affected":8,"disposition":"Rework"}',
         '2026-09-03 08:05', '2026-09-17', null),

        ('NCR-2026-0146', 'Traveler signature missing at op 20', 'containment', 'ok', 'MO',
         '{"part_number":"RP-9004-B","lot_number":"L-88240","qty_affected":0,"disposition":"Use-as-is"}',
         '2026-09-03 09:20', '2026-09-17', null),

        ('NCR-2026-0147', 'Shelf-life expired adhesive found in use', 'containment', 'warn', 'DW',
         '{"part_number":"RP-4471-A","lot_number":"L-88213","qty_affected":40,"disposition":"Scrap"}',
         '2026-09-03 10:40', '2026-09-17', null),

        ('NCR-2026-0148', 'Wrong packaging spec applied', 'containment', 'ok', 'KR',
         '{"part_number":"RP-6612-E","lot_number":"L-88221","qty_affected":30,"disposition":"Rework"}',
         '2026-09-03 11:55', '2026-09-17', null)
     ) as v(num, title, status, sev, owner, data, opened, due, closed);


-- Corrective action
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at, due_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'capa' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.due::timestamptz
from (values
        ('CAPA-2026-0031', 'Recurring thread gage failures', 'root_cause', 'crit', 'SP',
         '{"type":"Corrective","source":"Trend, 4 NCRs in 60 days","method":"5-why plus gage R and R","effectiveness_criterion":"Zero thread gage NCRs for 90 days after implementation"}',
         '2026-08-16', '2026-08-28'),
        ('CAPA-2026-0029', 'Audit finding, lot merge without re-identification', 'action_plan', 'crit', 'DW',
         '{"type":"Corrective","source":"AUD-2026-009 major finding","method":"Process review"}',
         '2026-07-14', '2026-09-01'),
        ('CAPA-2026-0034', 'Bore oversize on RP-4471-A', 'investigation', 'warn', 'MO',
         '{"type":"Corrective","source":"NCR-2026-0142","method":"5-why"}',
         '2026-09-01', '2026-09-19'),
        ('CAPA-2026-0033', 'Mixed lot shipped to customer', 'eightd_linked', 'warn', 'SP',
         '{"type":"Corrective","source":"COMP-2026-0009","method":"8D"}',
         '2026-08-28', '2026-09-24'),
        ('CAPA-2026-0027', 'Nordvik heat treat PPM above threshold', 'effectiveness', 'ok', 'TA',
         '{"type":"Corrective","source":"Supplier scorecard","method":"SCAR plus 100 percent incoming"}',
         '2026-06-11', '2026-10-11'),
        ('CAPA-2026-0022', 'Preventive, tool life trend approaching limit', 'verify', 'ok', 'MO',
         '{"type":"Preventive","source":"Tool life monitoring","method":"Trend analysis"}',
         '2026-05-30', '2026-10-30')
     ) as v(num, title, status, sev, owner, data, opened, due);


-- 8D
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at, due_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'eightd' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.due::timestamptz
from (values
        ('8D-2026-0004', 'Mixed lot shipped to Voss Automotive', 'd4', 'crit', 'SP',
         '{"customer":"Voss Automotive","current_discipline":"D4","disciplines":{"d1":"2026-08-28","d2":"2026-08-28","d3":"2026-08-29","d4":"in_progress"},"five_why":["Two lots on one pallet at pack-out","Traveler showed one lot number only","Partial lot merged at op 70 without new traveler","WI-0412 permits merge, does not require re-ID","Work instruction gap, clause 8.5.2"]}',
         '2026-08-28', '2026-09-08'),
        ('8D-2026-0003', 'Coating thickness variation, Corveil', 'd7', 'warn', 'TA',
         '{"customer":"Internal","current_discipline":"D7","disciplines":{"d1":"2026-07-02","d2":"2026-07-03","d3":"2026-07-05","d4":"2026-07-19","d5":"2026-08-01","d6":"2026-08-20"}}',
         '2026-07-02', '2026-09-30')
     ) as v(num, title, status, sev, owner, data, opened, due);


-- Customer complaints
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at, due_at, closed_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'complaint' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.due::timestamptz, v.closed::timestamptz
from (values
        ('COMP-2026-0009', 'Mixed lot in shipment', 'investigating', 'crit', 'SP',
         '{"customer":"Voss Automotive","contact":"A. Brandt, SQE","part_number":"RP-9004-B","lot_number":"L-87944","qty":1200,"shipment":"SHIP-20260821-04","cost_to_date_usd":14280,"containment":"100 percent sort at customer site, Ridgeline funded"}',
         '2026-08-28', '2026-09-04', null),
        ('COMP-2026-0008', 'Cert of conformance missing heat lot', 'response_drafted', 'warn', 'MO',
         '{"customer":"Kestrel Aerospace","part_number":"RP-6612-E","qty":460}',
         '2026-08-26', '2026-09-09', null),
        ('COMP-2026-0007', 'Late delivery, 6 days', 'with_logistics', 'warn', 'KR',
         '{"customer":"Dunmore Industrial","days_late":6}',
         '2026-08-29', '2026-09-12', null),
        ('COMP-2026-0006', 'Packaging damage in transit', 'closed', 'ok', 'KR',
         '{"customer":"Voss Automotive","qty":24}',
         '2026-07-11', '2026-07-25', '2026-07-22'),
        ('COMP-2026-0005', 'Burr on thread relief', 'closed', 'ok', 'JF',
         '{"customer":"Halberd Motion","qty":70}',
         '2026-06-18', '2026-07-02', '2026-06-30')
     ) as v(num, title, status, sev, owner, data, opened, due, closed);


-- Supplier corrective actions
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at, due_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'scar' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.due::timestamptz
from (values
        ('SCAR-2026-0004', 'Case hardness below spec, 2 of 3 samples', 'awaiting_8d', 'crit', 'TA',
         '{"vendor":"Nordvik Heat Treat","process":"Carburize and temper","spec":"HRC 58-62 case","samples":[54.2,55.1,58.4]}',
         '2026-09-02', '2026-09-16'),
        ('SCAR-2026-0003', 'Coating thickness variation', 'response_received', 'warn', 'TA',
         '{"vendor":"Corveil Coatings"}',
         '2026-08-11', '2026-08-25')
     ) as v(num, title, status, sev, owner, data, opened, due);


-- Internal audits
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at, due_at, closed_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'audit' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.due::timestamptz, v.closed::timestamptz
from (values
        ('AUD-2026-011', 'Clause 9, performance evaluation', 'overdue', 'crit', 'SP',
         '{"scope":"Clause 9","auditor":"External, Bergstrom","planned":"2026-08-15"}',
         '2026-08-15', '2026-08-15', null),
        ('AUD-2026-012', 'Clause 8.4, purchasing', 'overdue', 'crit', 'TA',
         '{"scope":"Clause 8.4","auditor":"T. Alvarez","planned":"2026-08-29"}',
         '2026-08-29', '2026-08-29', null),
        ('AUD-2026-013', 'Clause 7.5, documented information', 'scheduled', 'warn', 'MO',
         '{"scope":"Clause 7.5","auditor":"M. Okonkwo","planned":"2026-09-19"}',
         '2026-09-19', '2026-09-19', null),
        ('AUD-2026-009', 'Clause 8.5, production', 'closed', 'ok', 'TA',
         '{"scope":"Clause 8.5","auditor":"T. Alvarez","findings":[{"grade":"major","clause":"8.5.2","text":"Partial lot merges observed at op 70 with no re-identification"},{"grade":"minor","clause":"7.2","text":"Three operators running work instructions they are not recorded as trained on"},{"grade":"ofi","clause":"8.5.1","text":"Traveler sign-offs handwritten, electronic sign-off would reduce transcription risk"}]}',
         '2026-06-27', '2026-06-27', '2026-08-04'),
        ('AUD-2026-008', 'Clause 7.1.5, calibration', 'closed', 'ok', 'MO',
         '{"scope":"Clause 7.1.5","auditor":"M. Okonkwo"}',
         '2026-05-22', '2026-05-22', '2026-06-30')
     ) as v(num, title, status, sev, owner, data, opened, due, closed);


-- Risks and opportunities
insert into records (org_id, site_id, record_type_id, number, title, status, severity, owner_id, data, opened_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types where key = 'risk' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.num, v.title, v.status, v.sev,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz
from (values
        ('R-014', 'Single source for heat treat',              'unmitigated', 'crit', 'TA',
         '{"process":"Purchasing","severity":8,"occurrence":6,"detection":4,"rpn":192,"action":"Qualify second supplier"}', '2026-02-10'),
        ('R-009', 'Lot traceability broken on partial merge',  'in_progress', 'crit', 'SP',
         '{"process":"Production","severity":9,"occurrence":4,"detection":5,"rpn":180,"action":"WI-0412 rev D"}', '2026-01-22'),
        ('R-017', 'Key operator retirement in 2027',           'unmitigated', 'warn', 'RS',
         '{"process":"Resources","severity":6,"occurrence":7,"detection":3,"rpn":126,"action":"Cross-train two operators"}', '2026-05-04'),
        ('R-006', 'CMM downtime blocks release',               'in_progress', 'warn', 'MO',
         '{"process":"Quality","severity":7,"occurrence":4,"detection":4,"rpn":112,"action":"Second CMM approved Q2"}', '2025-11-18'),
        ('O-003', 'Opportunity, automate traveler sign-off',   'opportunity', 'ok', 'RS',
         '{"process":"Production","action":"Scoping study"}', '2026-06-02'),
        ('R-002', 'Raw material price volatility',             'controlled',  'ok', 'RS',
         '{"process":"Purchasing","severity":4,"occurrence":6,"detection":2,"rpn":48,"action":"Quarterly index review"}', '2025-09-30')
     ) as v(num, title, status, sev, owner, data, opened);


-- ============================================================
-- The link graph. This is what lets the demo trace one problem
-- across five modules.
-- ============================================================

insert into record_links (from_record_id, to_record_id, link_type)
select (select id from records where number = v.a),
       (select id from records where number = v.b),
       v.kind
from (values
        ('NCR-2026-0142', 'CAPA-2026-0034', 'corrects'),
        ('COMP-2026-0009', '8D-2026-0004',  'corrects'),
        ('COMP-2026-0009', 'NCR-2026-0139', 'caused_by'),
        ('8D-2026-0004',   'CAPA-2026-0033', 'related'),
        ('8D-2026-0004',   'NCR-2026-0139', 'caused_by'),
        ('AUD-2026-009',   'CAPA-2026-0029', 'corrects'),
        ('NCR-2026-0143',  'SCAR-2026-0004', 'corrects'),
        ('SCAR-2026-0004', 'CAPA-2026-0027', 'related'),
        ('R-009',          'CAPA-2026-0029', 'related'),
        ('NCR-2026-0136',  'CAPA-2026-0031', 'corrects')
     ) as v(a, b, kind);


-- ============================================================
-- A few audit trail rows so the history panel is not empty
-- ============================================================

insert into audit_log (org_id, record_id, entity, entity_id, field, old_value, new_value, changed_by, changed_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from records where number = 'NCR-2026-0142'),
       'records',
       (select id from records where number = 'NCR-2026-0142'),
       v.field, v.old, v.new,
       (select id from users where initials = v.who),
       v.at::timestamptz
from (values
        ('created',     null::text, 'NCR-2026-0142', 'PN', '2026-09-01 16:05'),
        ('measured',    null::text, '12.719',        'PN', '2026-09-02 09:40'),
        ('disposition', null::text, 'Rework',        'MO', '2026-09-02 14:22'),
        ('status',      'draft',    'containment',   'MO', '2026-09-02 14:23')
     ) as v(field, old, new, who, at);
