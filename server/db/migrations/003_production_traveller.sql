-- ============================================================
-- Production: travellers and first article results.
--
-- work_orders already existed and held the WOs shown across other
-- screens. What was missing is what a work order actually carries on
-- the floor: the sequence of operations, who signed each one, and the
-- first article measurements that let the rest of the lot run.
--
-- Clause 8.5.1 wants evidence that production was carried out under
-- controlled conditions. These two tables are that evidence.
-- ============================================================

create table if not exists work_order_operations (
    id             uuid primary key default gen_random_uuid(),
    work_order_id  uuid not null references work_orders(id) on delete cascade,
    op_number      text not null,
    description    text not null,
    operator_id    uuid references users(id) on delete set null,

    -- blocked is not a failure. It means an earlier operation has not
    -- passed, so this one may not start: the traveller enforces
    -- sequence rather than trusting everyone to read it.
    status         text not null default 'planned' check (status in (
                       'planned', 'running', 'pass', 'fail', 'blocked'
                   )),
    completed_at   timestamptz,
    notes          text,
    position       integer not null,
    unique (work_order_id, op_number)
);

create table if not exists first_article_results (
    id                 uuid primary key default gen_random_uuid(),
    work_order_id      uuid not null references work_orders(id) on delete cascade,
    characteristic_no  integer not null,
    specification      text not null,
    actual             text,
    result             text check (result in ('pass', 'fail')),
    gage_id            text,
    measured_by        uuid references users(id) on delete set null,
    measured_at        timestamptz,
    unique (work_order_id, characteristic_no)
);

create index if not exists idx_wo_ops_order on work_order_operations (work_order_id, position);
create index if not exists idx_fai_order    on first_article_results (work_order_id, characteristic_no);

-- Work orders gain a hold reason, because "why is this stopped" is the
-- first question anyone asks when they find one.
alter table work_orders add column if not exists hold_reason text;
alter table work_orders add column if not exists held_by uuid references users(id) on delete set null;
alter table work_orders add column if not exists held_at timestamptz;


-- ------------------------------------------------------------
-- Travellers for the seeded work orders.
-- ------------------------------------------------------------

insert into work_order_operations
    (work_order_id, op_number, description, operator_id, status, position)
select w.id, v.op, v.description,
       (select id from users where initials = v.who),
       v.status, v.pos
from (values
        ('WO-31882', '10', 'Saw to length',           'RD', 'pass',    1),
        ('WO-31882', '20', 'Rough mill',              'RD', 'pass',    2),
        ('WO-31882', '30', 'Finish bore',             'PN', 'fail',    3),
        ('WO-31882', '40', 'Deburr',                  null, 'blocked', 4),
        ('WO-31882', '70', 'Final inspect and pack',  null, 'blocked', 5),

        ('WO-31879', '10', 'Saw to length',           'RD', 'pass',    1),
        ('WO-31879', '20', 'Turn OD',                 'PN', 'pass',    2),
        ('WO-31879', '30', 'Spline hob',              'PN', 'pass',    3),
        ('WO-31879', '40', 'Grind finish',            'RD', 'fail',    4),
        ('WO-31879', '60', 'Final inspect and pack',  null, 'blocked', 5),

        ('WO-31890', '10', 'Blank',                   'RD', 'pass',    1),
        ('WO-31890', '20', 'Form bracket',            'PN', 'running', 2),
        ('WO-31890', '30', 'Drill mounting holes',    null, 'planned', 3),
        ('WO-31890', '50', 'Final inspect and pack',  null, 'planned', 4),

        ('WO-31891', '10', 'Saw to length',           'RD', 'running', 1),
        ('WO-31891', '20', 'Turn profile',            null, 'planned', 2),
        ('WO-31891', '60', 'Final inspect and pack',  null, 'planned', 3),

        ('WO-31885', '10', 'Blank',                   'RD', 'pass',    1),
        ('WO-31885', '20', 'Turn ring',               'PN', 'pass',    2),
        ('WO-31885', '30', 'Part off',                'PN', 'pass',    3),
        ('WO-31885', '50', 'Final inspect and pack',  'JF', 'pass',    4)
     ) as v(wo, op, description, who, status, pos)
join work_orders w on w.wo_number = v.wo
on conflict do nothing;


-- ------------------------------------------------------------
-- First article, WO-31885. Measured before the rest of the lot ran.
-- ------------------------------------------------------------

insert into first_article_results
    (work_order_id, characteristic_no, specification, actual, result, gage_id,
     measured_by, measured_at)
select w.id, v.no, v.spec, v.actual, v.result, v.gage,
       (select id from users where initials = 'JF'),
       '2026-08-27 10:15'::timestamptz
from (values
        (1, 'DIA 8.00 +/-0.05',  '8.012', 'pass', 'MIC-114'),
        (2, 'Thk 2.50 +/-0.10',  '2.488', 'pass', 'MIC-114'),
        (3, 'Ra 1.6 max',        '1.1',   'pass', 'SG-0071'),
        (4, 'Conc 0.03 TIR',     '0.018', 'pass', 'CMM-002')
     ) as v(no, spec, actual, result, gage)
join work_orders w on w.wo_number = 'WO-31885'
on conflict do nothing;


-- The two work orders sitting on hold say why.
update work_orders
   set hold_reason = 'Bore oversize found at final inspection, see NCR-2026-0142',
       held_by = (select id from users where initials = 'MO'),
       held_at = '2026-09-01 16:10'::timestamptz
 where wo_number = 'WO-31882';

update work_orders
   set hold_reason = 'Surface finish out of specification at op 40, awaiting MRB',
       held_by = (select id from users where initials = 'TA'),
       held_at = '2026-08-30 11:25'::timestamptz
 where wo_number = 'WO-31879';
