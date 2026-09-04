-- ============================================================
-- Ostrand Grinding had no onboarding stages.
--
-- Migration 006 inserted the stages before it inserted the vendor
-- row they join to, so every Ostrand line silently matched nothing.
-- No error, no rows: the join simply had nothing on the other side.
--
-- 006 has been corrected for a fresh build. This repairs the
-- databases that already ran it.
-- ============================================================

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
        ('questionnaire', 'Questionnaire returned',        'Self assessment, scored 76',        'complete',    'FO', '2026-08-26 11:20', 1),
        ('certification', 'Certification verified',        'Awaiting registrar confirmation',   'in_progress', null::text, null::text, 2),
        ('financial',     'Financial and capacity check',  null::text,                          'pending',     null::text, null::text, 3),
        ('audit',         'On-site audit',                 'Special process, audit mandatory',  'pending',     null::text, null::text, 4),
        ('first_article', 'First article approval',        null::text,                          'pending',     null::text, null::text, 5),
        ('avl',           'Added to approved vendor list', null::text,                          'pending',     null::text, null::text, 6)
     ) as v(key, name, detail, status, who, at, pos)
join vendors ve on ve.name = 'Ostrand Grinding'
  and ve.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;
