-- ============================================================
-- 8D and Change Control.
--
-- Neither needs a new record type: both already exist and already
-- accept records. What they lacked is a workflow, and in both cases
-- the steps ARE a workflow, so they reuse the existing engine rather
-- than growing a second mechanism beside it.
--
-- The eight disciplines are sequential and each one has an owner.
-- That is a state machine, and modelling it as one means the audit
-- trail, the permission gate and the UI buttons all come for free.
-- ============================================================

-- ------------------------------------------------------------
-- 8D: the eight disciplines as states
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('d1',     'D1 Team formed',            1, false),
        ('d2',     'D2 Problem described',      2, false),
        ('d3',     'D3 Interim containment',    3, false),
        ('d4',     'D4 Root cause',             4, false),
        ('d5',     'D5 Corrective action',      5, false),
        ('d6',     'D6 Implement and validate', 6, false),
        ('d7',     'D7 Prevent recurrence',     7, false),
        ('d8',     'D8 Recognise the team',     8, false),
        ('closed', 'Closed',                    9, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'eightd'
  and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions
    (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('d1', 'd2', 'capa.create'),
        ('d2', 'd3', 'ncr.contain'),
        ('d3', 'd4', 'capa.create'),
        ('d4', 'd5', 'capa.create'),
        ('d5', 'd6', 'capa.create'),
        ('d6', 'd7', 'capa.create'),
        ('d7', 'd8', 'capa.create'),
        -- Closing an 8D is the same authority as closing the CAPA it
        -- belongs to, which is the quality manager.
        ('d8', 'closed', 'capa.close')
     ) as v(from_key, to_key, permission)
where rt.key = 'eightd'
  and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Change control: draft to implemented
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',       'Draft',             1, false),
        ('impact',      'Impact assessment', 2, false),
        ('review',      'In review',         3, false),
        ('approved',    'Approved',          4, false),
        ('implemented', 'Implemented',       5, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'ecn'
  and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions
    (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',    'impact',      'change.create'),
        ('impact',   'review',      'change.create'),
        ('review',   'approved',    'change.approve'),
        ('approved', 'implemented', 'change.approve')
     ) as v(from_key, to_key, permission)
where rt.key = 'ecn'
  and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Impact assessment sign-offs.
--
-- A table rather than a field on the change, because each line is a
-- named person accepting an impact on their own area. Who signed and
-- when is the record an auditor asks for; a JSONB blob overwritten in
-- place would lose it.
-- ------------------------------------------------------------

create table if not exists change_impact_assessments (
    id          uuid primary key default gen_random_uuid(),
    record_id   uuid not null references records(id) on delete cascade,
    area        text not null,
    impact      text not null,
    status      text not null default 'pending' check (status in (
                    'pending', 'signed', 'not_applicable'
                )),
    signed_by   uuid references users(id) on delete set null,
    signed_at   timestamptz,
    position    integer not null,
    unique (record_id, area)
);

create index if not exists idx_impact_record
    on change_impact_assessments (record_id, position);


-- ------------------------------------------------------------
-- Seed the engineering change notices the static screen showed.
-- ------------------------------------------------------------

insert into records
    (org_id, site_id, record_type_id, number, title, status, severity,
     owner_id, data, opened_at, due_at, closed_at)
select '11111111-1111-1111-1111-111111111111',
       (select id from sites where code = 'P2'),
       (select id from record_types
         where key = 'ecn' and org_id = '11111111-1111-1111-1111-111111111111'),
       v.number, v.title, v.status, v.severity,
       (select id from users where initials = v.owner),
       v.data::jsonb, v.opened::timestamptz, v.effectivity::timestamptz, v.closed::timestamptz
from (values
        ('ECN-2026-0118', 'Spline tolerance tightened to 0.02', 'review', 'warn', 'RV',
         '{"part_number":"RP-2210-C","reason":"Customer request, Kestrel","from_rev":"F","to_rev":"G"}',
         '2026-08-14', '2026-10-01', null::text),

        ('ECN-2026-0121', 'Material change 302 to 316 stainless', 'impact', 'warn', 'HO',
         '{"part_number":"RP-6612-E","reason":"Corrosion performance in service","from_rev":"A","to_rev":"B"}',
         '2026-08-28', '2026-10-15', null::text),

        ('ECN-2026-0114', 'Added deburr operation after op 60', 'implemented', 'ok', 'CB',
         '{"part_number":"RP-8890-D","reason":"Recurring burr nonconformance","from_rev":"A","to_rev":"B"}',
         '2026-06-30', '2026-08-04', '2026-08-04'),

        ('ECN-2026-0109', 'Packaging specification revision', 'implemented', 'ok', 'KR',
         '{"part_number":"RP-4471-A","reason":"Customer packaging standard update","from_rev":"C","to_rev":"D"}',
         '2026-06-12', '2026-07-12', '2026-07-12')
     ) as v(number, title, status, severity, owner, data, opened, effectivity, closed)
on conflict (org_id, number) do nothing;


-- Impact lines for the change still being assessed.
insert into change_impact_assessments (record_id, area, impact, status, signed_by, signed_at, position)
select r.id, v.area, v.impact, v.status,
       case when v.who is null then null else (select id from users where initials = v.who) end,
       v.signed::timestamptz, v.pos
from records r,
     (values
        ('Engineering', 'Drawing revision A to B, material note updated',      'signed',  'HO',  '2026-08-29 09:20', 1),
        ('Purchasing',  'New raw material purchase order, six week lead time', 'signed',  'FO',  '2026-08-30 14:05', 2),
        ('Production',  'Feeds and speeds change, tool life impact expected',  'pending', null::text, null::text, 3),
        ('Quality',     'New first article required, PPAP resubmission',       'pending', null::text, null::text, 4),
        ('Warehouse',   'Segregate remaining 302 stock',                       'pending', null::text, null::text, 5),
        ('Customer',    'Halberd approval required before shipment',           'pending', null::text, null::text, 6)
     ) as v(area, impact, status, who, signed, pos)
where r.number = 'ECN-2026-0121'
  and r.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into change_impact_assessments (record_id, area, impact, status, signed_by, signed_at, position)
select r.id, v.area, v.impact, v.status,
       (select id from users where initials = v.who), v.signed::timestamptz, v.pos
from records r,
     (values
        ('Engineering', 'Drawing revision F to G, spline detail',        'signed', 'RV', '2026-08-15 11:00', 1),
        ('Production',  'Hob change required, cycle time up 12 percent', 'signed', 'CB', '2026-08-18 08:40', 2),
        ('Quality',     'Gage R and R on new tolerance band',            'signed', 'MO', '2026-08-20 15:30', 3)
     ) as v(area, impact, status, who, signed, pos)
where r.number = 'ECN-2026-0118'
  and r.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- Link the changes to the records that caused them.
insert into record_links (from_record_id, to_record_id, link_type)
select (select id from records where number = v.a
         and org_id = '11111111-1111-1111-1111-111111111111'),
       (select id from records where number = v.b
         and org_id = '11111111-1111-1111-1111-111111111111'),
       v.kind
from (values
        ('NCR-2026-0140', 'ECN-2026-0114', 'corrects'),
        ('NCR-2026-0135', 'ECN-2026-0109', 'corrects')
     ) as v(a, b, kind)
where exists (select 1 from records where number = v.a
               and org_id = '11111111-1111-1111-1111-111111111111')
on conflict do nothing;
