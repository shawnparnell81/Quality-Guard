-- Two new computed objectives (the SQL that actually measures them
-- lives in evaluate.js's COMPUTED map, not here - this just gives
-- Ridgeline's scorecard a row that points at each one, the same
-- pattern every other computed objective already uses.
insert into quality_objectives
    (org_id, name, clause, target_value, unit, direction, source,
     stored_actual, owner_id, period, position)
select '11111111-1111-1111-1111-111111111111', v.name, v.clause, v.target, v.unit,
       v.direction, v.source, v.stored,
       (select id from users where initials = v.who), '2026', v.pos
from (values
        ('First-pass yield',              '8.7',   98.00, 'percent', 'min', 'first_pass_yield'::text,       null::numeric, 'MO', 10),
        ('CAPA average time to close',    '10.2',  21.00, 'days',    'max', 'capa_avg_days_to_close'::text, null::numeric, 'SP', 11)
     ) as v(name, clause, target, unit, direction, source, stored, who, pos)
on conflict do nothing;
