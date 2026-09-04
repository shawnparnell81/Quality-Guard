-- ============================================================
-- Data for the seven screens wired in 005.
--
-- Kept in its own migration so the shape and the contents can be
-- reasoned about separately: 005 is safe to keep, this one is the
-- part you would drop when real data arrives.
-- ============================================================

-- ------------------------------------------------------------
-- Drawings
-- ------------------------------------------------------------

insert into drawings
    (org_id, drawing_number, title, part_id, customer,
     current_revision, status, access_level, owner_id)
select '11111111-1111-1111-1111-111111111111', v.number, v.title,
       (select id from parts where part_number = v.number),
       v.customer, v.rev, v.status, v.access,
       (select id from users where initials = v.owner)
from (values
        ('RP-4471-A', 'Housing, hydraulic manifold', 'Voss Automotive',    'D', 'released',  'eng_qa',    'HO'),
        ('RP-2210-C', 'Shaft, drive spline',         'Kestrel Aerospace',  'G', 'in_review', 'eng_qa',    'HO'),
        ('RP-9004-B', 'Bracket, mounting',           'Voss Automotive',    'C', 'released',  'all_plant', 'NP'),
        ('RP-8890-D', 'Cap, end closure',            'Dunmore Industrial', 'B', 'released',  'eng_qa',    'NP'),
        ('RP-6612-E', 'Retainer ring',               'Halberd Motion',     'A', 'in_review', 'eng_only',  'HO')
     ) as v(number, title, customer, rev, status, access, owner)
on conflict do nothing;

insert into drawing_revisions
    (drawing_id, revision, change_summary, ecn_number, status, released_by, released_at)
select d.id, v.rev, v.summary, v.ecn, v.status,
       case when v.who is null then null else (select id from users where initials = v.who) end,
       v.at::timestamptz
from (values
        ('RP-4471-A', 'D', 'Bore tolerance restated to +0.013/-0.000', null,            'released',   'RV', '2026-02-11 09:00'),
        ('RP-4471-A', 'C', 'Datum scheme clarified',                   null,            'superseded', 'RV', '2025-08-04 10:30'),
        ('RP-2210-C', 'G', 'Spline tolerance tightened to 0.02',       'ECN-2026-0118', 'in_review',  null::text, null::text),
        ('RP-2210-C', 'F', 'Surface finish note added',                null,            'released',   'RV', '2025-11-19 14:20'),
        ('RP-9004-B', 'C', 'Hole pattern revised',                     null,            'released',   'RV', '2026-01-22 11:10'),
        ('RP-8890-D', 'B', 'Deburr operation added after op 60',       'ECN-2026-0114', 'released',   'RV', '2026-08-04 08:45'),
        ('RP-6612-E', 'B', 'Material 302 to 316 stainless',            'ECN-2026-0121', 'draft',      null::text, null::text),
        ('RP-6612-E', 'A', 'Initial release',                          null,            'released',   'RV', '2025-06-02 13:00')
     ) as v(drawing, rev, summary, ecn, status, who, at)
join drawings d on d.drawing_number = v.drawing
on conflict do nothing;


-- ------------------------------------------------------------
-- Receiving
-- ------------------------------------------------------------

insert into receipts
    (org_id, receipt_number, po_number, vendor_id, part_number,
     qty_received, received_at, sample_plan, status, inspected_by, inspected_at, notes)
select '11111111-1111-1111-1111-111111111111', v.number, v.po,
       (select id from vendors where name = v.vendor),
       v.part, v.qty, v.at::timestamptz, v.plan, v.status,
       case when v.who is null then null else (select id from users where initials = v.who) end,
       case when v.who is null then null else v.at::timestamptz end,
       v.notes
from (values
        ('RCV-20260901-3', 'PO-55401', 'Halstead Steel',     'RM-1018-HR', 2400, '2026-09-01 08:20', 'Skip-lot', 'reject',  'LC', 'Mill certificate missing the heat number'),
        ('RCV-20260902-1', 'PO-55418', 'Ainsley Tool',       'TL-CARB-38',   60, '2026-09-02 09:05', 'Skip-lot', 'accept',  'LC', null::text),
        ('RCV-20260902-2', 'PO-55390', 'Nordvik Heat Treat', 'RP-2210-C',   150, '2026-09-02 13:40', '100%',     'reject',  'JF', 'Case hardness below specification on 2 of 3 samples'),
        ('RCV-20260903-1', 'PO-55422', 'Brightline Plating', 'RP-9004-B',  1200, '2026-09-03 10:15', 'AQL 1.0',  'accept',  'LC', null::text),
        ('RCV-20260904-1', 'PO-55430', 'Halstead Steel',     'RM-4140-HR', 1800, '2026-09-04 07:50', 'Skip-lot', 'pending', null::text, null::text)
     ) as v(number, po, vendor, part, qty, at, plan, status, who, notes)
on conflict do nothing;

insert into receipt_measurements
    (receipt_id, characteristic, specification, actual, result, gage_id, position)
select r.id, v.characteristic, v.spec, v.actual, v.result, v.gage, v.pos
from (values
        ('RCV-20260902-2', 'Case hardness, sample 1', 'HRC 58-62', '54.2', 'fail', 'HG-018', 1),
        ('RCV-20260902-2', 'Case hardness, sample 2', 'HRC 58-62', '55.1', 'fail', 'HG-018', 2),
        ('RCV-20260902-2', 'Case hardness, sample 3', 'HRC 58-62', '58.4', 'pass', 'HG-018', 3),
        ('RCV-20260903-1', 'Coating thickness',       '8-15 um',   '11.2', 'pass', 'MIC-114', 1),
        ('RCV-20260903-1', 'Adhesion, tape test',     'No lift',   'Pass', 'pass', null::text, 2),
        ('RCV-20260902-1', 'Flute count',             '4',         '4',    'pass', null::text, 1)
     ) as v(receipt, characteristic, spec, actual, result, gage, pos)
join receipts r on r.receipt_number = v.receipt
on conflict do nothing;


-- ------------------------------------------------------------
-- Shipping
-- ------------------------------------------------------------

insert into shipments
    (org_id, shipment_number, customer, part_number, lot_id, qty,
     ship_date, carrier, status, released_by, released_at)
select '11111111-1111-1111-1111-111111111111', v.number, v.customer, v.part,
       (select id from lots where lot_number = v.lot),
       v.qty, v.ship_date::date, v.carrier, v.status,
       case when v.who is null then null else (select id from users where initials = v.who) end,
       case when v.who is null then null else (v.ship_date || ' 15:00')::timestamptz end
from (values
        ('SHIP-20260903-01', 'Kestrel Aerospace',  'RP-6612-E', 'L-88221',  880, '2026-09-03', 'Ridgeline fleet', 'shipped',          'MO'),
        ('SHIP-20260903-02', 'Voss Automotive',    'RP-9004-B', 'L-88240', 2000, '2026-09-05', 'Cotswold Freight', 'awaiting_release', null::text),
        ('SHIP-20260904-01', 'Dunmore Industrial', 'RP-4471-A', 'L-88213',  400, '2026-09-06', 'Cotswold Freight', 'blocked',          null::text),
        ('SHIP-20260828-02', 'Halberd Motion',     'RP-6612-E', 'L-88221',  880, '2026-08-28', 'Ridgeline fleet', 'shipped',          'MO')
     ) as v(number, customer, part, lot, qty, ship_date, carrier, status, who)
on conflict do nothing;

insert into shipment_checks (shipment_id, description, evidence, status, position)
select s.id, v.description, v.evidence, v.status, v.pos
from (values
        ('SHIP-20260903-02', 'Final inspection complete',      'IP-9004, 2000 pieces',  'pass',    1),
        ('SHIP-20260903-02', 'All operations signed',          'WO-31890',              'pass',    2),
        ('SHIP-20260903-02', 'No open nonconformance on lot',  'L-88240',               'pass',    3),
        ('SHIP-20260903-02', 'Certificate of conformance',     'C of C 20260903-02',    'pass',    4),
        ('SHIP-20260903-02', 'Customer specific labels',       'Voss spec VS-114',      'pending', 5),
        ('SHIP-20260903-02', 'Authorised release signature',   null::text,              'pending', 6),

        ('SHIP-20260904-01', 'Final inspection complete',      'IP-4471',               'fail',    1),
        ('SHIP-20260904-01', 'No open nonconformance on lot',  'NCR-2026-0142 open',    'fail',    2),
        ('SHIP-20260904-01', 'Certificate of conformance',     null::text,              'pending', 3),
        ('SHIP-20260904-01', 'Authorised release signature',   null::text,              'pending', 4)
     ) as v(shipment, description, evidence, status, pos)
join shipments s on s.shipment_number = v.shipment
on conflict do nothing;


-- ------------------------------------------------------------
-- Vendor onboarding
-- ------------------------------------------------------------

-- Ostrand is a candidate, not yet approved.
insert into vendors (org_id, name, scope, status)
values ('11111111-1111-1111-1111-111111111111', 'Ostrand Grinding',
        'Centreless grinding', 'onboarding')
on conflict (org_id, name) do nothing;

insert into vendor_onboarding_stages
    (vendor_id, stage_key, name, detail, status, completed_by, completed_at, position)
select ve.id, v.key, v.name, v.detail, v.status,
       case when v.who is null then null else (select id from users where initials = v.who) end,
       v.at::timestamptz, v.pos
from (values
        ('Merrow Fasteners', 'questionnaire', 'Questionnaire returned',       'Self assessment, 42 questions, scored 88', 'complete',    'FO', '2026-08-12 10:00', 1),
        ('Merrow Fasteners', 'certification', 'Certification verified',       'ISO 9001 confirmed with registrar, expires 2028', 'complete', 'FO', '2026-08-15 14:30', 2),
        ('Merrow Fasteners', 'financial',     'Financial and capacity check', 'Capacity confirmed for 40k pieces a year', 'complete',    'FO', '2026-08-21 09:15', 3),
        ('Merrow Fasteners', 'audit',         'On-site audit',                'Scheduled 12 Sep, auditor T. Alvarez',     'in_progress', null::text, null::text, 4),
        ('Merrow Fasteners', 'first_article', 'First article approval',       'PPAP level 3 required',                    'pending',     null::text, null::text, 5),
        ('Merrow Fasteners', 'avl',           'Added to approved vendor list','Quality manager signature required',       'pending',     null::text, null::text, 6),

        ('Ostrand Grinding', 'questionnaire', 'Questionnaire returned',       'Self assessment, scored 76',               'complete',    'FO', '2026-08-26 11:20', 1),
        ('Ostrand Grinding', 'certification', 'Certification verified',       'Awaiting registrar confirmation',          'in_progress', null::text, null::text, 2),
        ('Ostrand Grinding', 'financial',     'Financial and capacity check', null::text,                                 'pending',     null::text, null::text, 3),
        ('Ostrand Grinding', 'audit',         'On-site audit',                'Special process, audit mandatory',         'pending',     null::text, null::text, 4),
        ('Ostrand Grinding', 'first_article', 'First article approval',       null::text,                                 'pending',     null::text, null::text, 5),
        ('Ostrand Grinding', 'avl',           'Added to approved vendor list',null::text,                                 'pending',     null::text, null::text, 6)
     ) as v(vendor, key, name, detail, status, who, at, pos)
join vendors ve on ve.name = v.vendor
on conflict do nothing;



-- ------------------------------------------------------------
-- Management review
-- ------------------------------------------------------------

insert into management_reviews (org_id, reference, period, held_on, chair_id, status)
select '11111111-1111-1111-1111-111111111111', v.ref, v.period, v.held::date,
       (select id from users where initials = 'RS'), v.status
from (values
        ('MR-2026-Q3', 'Q3 2026', null::text,     'planned'),
        ('MR-2026-Q2', 'Q2 2026', '2026-06-28',   'closed'),
        ('MR-2026-Q1', 'Q1 2026', '2026-03-29',   'closed'),
        ('MR-2025-Q4', 'Q4 2025', '2025-12-18',   'closed')
     ) as v(ref, period, held, status)
on conflict do nothing;

insert into management_review_actions (review_id, decision, owner_id, due_on, status, position)
select m.id, v.decision,
       (select id from users where initials = v.who),
       v.due::date, v.status, v.pos
from (values
        ('MR-2026-Q2', 'Add a second CMM to relieve the inspection queue', 'RS', '2026-12-31', 'in_progress', 1),
        ('MR-2026-Q2', 'Move Nordvik Heat Treat to 100 percent incoming',  'TA', '2026-07-31', 'done',        2),
        ('MR-2026-Q2', 'Revise the internal PPM objective to 700',         'SP', '2026-09-30', 'in_progress', 3),
        ('MR-2026-Q2', 'Recruit a second quality technician',              'RS', '2026-11-30', 'open',        4),
        ('MR-2026-Q1', 'Introduce a calibration reminder at 30 days',      'DW', '2026-04-30', 'done',        1),
        ('MR-2026-Q1', 'Quarterly supplier scorecard review with sales',   'FO', '2026-06-30', 'done',        2)
     ) as v(review, decision, who, due, status, pos)
join management_reviews m on m.reference = v.review
on conflict do nothing;


-- ------------------------------------------------------------
-- Quality objectives
-- ------------------------------------------------------------

insert into quality_objectives
    (org_id, name, clause, target_value, unit, direction, source,
     stored_actual, owner_id, period, position)
select '11111111-1111-1111-1111-111111111111', v.name, v.clause, v.target, v.unit,
       v.direction, v.source, v.stored,
       (select id from users where initials = v.who), '2026', v.pos
from (values
        ('Internal defect rate',          '6.2',   700.00, 'PPM',     'max', null::text,             842.00, 'SP', 1),
        ('On-time delivery',              '6.2',    96.00, 'percent', 'min', null::text,              97.40, 'GH', 2),
        ('CAPA closed within 30 days',    '10.2',   90.00, 'percent', 'min', 'capa_on_time',          null::numeric, 'SP', 3),
        ('Calibration on time',           '7.1.5', 100.00, 'percent', 'min', 'calibration_on_time',   null::numeric, 'DW', 4),
        ('Supplier PPM, all vendors',     '8.4',  1500.00, 'PPM',     'max', 'supplier_ppm',          null::numeric, 'FO', 5),
        ('Customer satisfaction',         '9.1.2',  85.00, 'score',   'min', null::text,              86.00, 'SP', 6),
        ('Training compliance',           '7.2',    98.00, 'percent', 'min', 'training_compliance',   null::numeric, 'SP', 7),
        ('Internal audits on schedule',   '9.2',   100.00, 'percent', 'min', 'audits_on_time',        null::numeric, 'SP', 8),
        ('Scrap cost as percent of sales','6.2',     1.20, 'percent', 'max', null::text,               0.94, 'RS', 9)
     ) as v(name, clause, target, unit, direction, source, stored, who, pos)
on conflict do nothing;
