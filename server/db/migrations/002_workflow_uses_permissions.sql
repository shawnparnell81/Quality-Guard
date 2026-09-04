-- ============================================================
-- Workflow steps gate on a permission, not on a role.
--
-- required_role matched exactly, which meant a Quality Manager could
-- not move a record through a step "owned by" a Quality Tech, even
-- though the manager holds every authority the tech does. Two
-- competing models of who may act, and they disagreed.
--
-- There is one model now: permissions. A role carries permissions,
-- and a step asks for a permission. Seniority falls out of the grid
-- instead of having to be special-cased.
-- ============================================================

alter table workflow_transitions
    add column if not exists required_permission text;

update workflow_transitions wt
   set required_permission = m.permission
  from (values
        ('draft',       'containment', 'ncr.contain'),
        ('containment', 'mrb',         'ncr.disposition'),
        ('mrb',         'disposition', 'ncr.disposition'),
        ('disposition', 'verify',      'ncr.contain'),
        ('verify',      'closed',      'ncr.close')
       ) as m(from_state, to_state, permission)
 where wt.from_state = m.from_state
   and wt.to_state   = m.to_state;

-- required_role stays for now, unused by the application. Dropping a
-- column is the one migration that cannot be undone from a backup
-- taken afterwards, so it goes in its own change once this one has
-- been running for a while.
comment on column workflow_transitions.required_role is
    'Superseded by required_permission. Retained until 003 drops it.';

comment on column workflow_transitions.required_permission is
    'Permission key the actor must hold to make this move.';
