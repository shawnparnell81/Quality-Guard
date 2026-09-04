-- ============================================================
-- Workflows for CAPA, Complaint, SCAR, Audit and Risk.
--
-- Only ncr, eightd and ecn ever got a workflow_states/
-- workflow_transitions definition. The other five record types have
-- none at all, anywhere in schema.sql, seed.sql or migrations 002
-- through 008 — confirmed by grepping every insert against those
-- tables. Combined with records.js always creating a new record at
-- status 'draft', a CAPA, Complaint, SCAR, Audit or Risk raised
-- through the UI today has no defined transition out of 'draft' and
-- can never be moved or closed.
--
-- The state keys chosen here are exactly the status values already
-- sitting in the seeded records for these types (root_cause,
-- investigating, awaiting_8d, scheduled, unmitigated, and so on), so
-- no existing record needs its data touched — they simply become
-- reachable positions in a real workflow instead of orphaned strings.
--
-- Every required_permission used already exists in the permissions
-- catalog seeded in seed.sql; nothing new was invented here.
-- ============================================================

-- ------------------------------------------------------------
-- CAPA, clause 10.2
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',         'Draft',                    1, false),
        ('investigation', 'Investigation',            2, false),
        ('root_cause',    'Root cause',                3, false),
        ('eightd_linked', 'Linked to 8D',              4, false),
        ('action_plan',   'Action plan',               5, false),
        ('verify',        'Verify implementation',     6, false),
        ('effectiveness', 'Effectiveness check',       7, false),
        ('closed',        'Closed',                    8, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'capa' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',         'investigation', 'capa.create'),
        ('investigation', 'root_cause',    'capa.create'),
        ('investigation', 'eightd_linked', 'capa.create'),
        ('eightd_linked', 'action_plan',   'capa.create'),
        ('root_cause',    'action_plan',   'capa.create'),
        ('action_plan',   'verify',        'capa.create'),
        ('verify',        'effectiveness', 'capa.create'),
        ('effectiveness', 'closed',        'capa.close')
     ) as v(from_key, to_key, permission)
where rt.key = 'capa' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Customer complaints, clause 8.2.1
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',             'Draft',                1, false),
        ('investigating',     'Investigating',        2, false),
        ('with_logistics',    'With logistics',       3, false),
        ('response_drafted',  'Response drafted',     4, false),
        ('response_received', 'Customer response in', 5, false),
        ('closed',            'Closed',               6, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'complaint' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',             'investigating',     'complaint.create'),
        ('investigating',     'with_logistics',    'complaint.create'),
        ('investigating',     'response_drafted',  'complaint.respond'),
        ('with_logistics',    'response_drafted',  'complaint.respond'),
        ('response_drafted',  'response_received', 'complaint.respond'),
        ('response_received', 'closed',            'complaint.respond')
     ) as v(from_key, to_key, permission)
where rt.key = 'complaint' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Supplier corrective action, clause 8.4
--
-- The catalog only ever defined scar.issue - there is no scar.close.
-- Every step here, closing included, is gated on the one authority
-- that exists rather than inventing a permission nothing else uses.
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',             'Draft',                1, false),
        ('awaiting_8d',       'Awaiting supplier 8D', 2, false),
        ('response_received', 'Response received',    3, false),
        ('closed',            'Closed',                4, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'scar' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',             'awaiting_8d',       'scar.issue'),
        ('awaiting_8d',       'response_received', 'scar.issue'),
        ('response_received', 'closed',            'scar.issue')
     ) as v(from_key, to_key, permission)
where rt.key = 'scar' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Internal audit, clause 9.2
--
-- 'overdue' is kept as a real, manually-entered state here because
-- that is how the seeded data already uses it (a literal status, not
-- one derived from due_at the way NCR/CAPA/complaint overdue counts
-- are). Making audits compute overdue live instead is a real
-- improvement, but a separate change from giving this type a
-- workflow at all.
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',     'Draft',     1, false),
        ('scheduled', 'Scheduled', 2, false),
        ('overdue',   'Overdue',   3, false),
        ('closed',    'Closed',    4, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'audit' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',     'scheduled', 'audit.schedule'),
        ('scheduled', 'overdue',   'audit.schedule'),
        ('scheduled', 'closed',    'audit.close'),
        ('overdue',   'closed',    'audit.close')
     ) as v(from_key, to_key, permission)
where rt.key = 'audit' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;


-- ------------------------------------------------------------
-- Risk register, clause 6.1
--
-- This table also holds opportunities (O-numbers), which start on a
-- separate branch from risks (unmitigated) rather than passing
-- through it - an opportunity was never a risk that got mitigated.
-- ------------------------------------------------------------

insert into workflow_states (record_type_id, key, name, position, is_terminal)
select rt.id, v.key, v.name, v.pos, v.terminal
from record_types rt,
     (values
        ('draft',       'Draft',       1, false),
        ('unmitigated', 'Unmitigated', 2, false),
        ('opportunity', 'Opportunity', 3, false),
        ('in_progress', 'In progress', 4, false),
        ('controlled',  'Controlled',  5, true)
     ) as v(key, name, pos, terminal)
where rt.key = 'risk' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;

insert into workflow_transitions (record_type_id, from_state, to_state, required_permission)
select rt.id, v.from_key, v.to_key, v.permission
from record_types rt,
     (values
        ('draft',       'unmitigated', 'risk.manage'),
        ('draft',       'opportunity', 'risk.manage'),
        ('unmitigated', 'in_progress', 'risk.manage'),
        ('opportunity', 'in_progress', 'risk.manage'),
        ('in_progress', 'controlled',  'risk.manage')
     ) as v(from_key, to_key, permission)
where rt.key = 'risk' and rt.org_id = '11111111-1111-1111-1111-111111111111'
on conflict do nothing;
