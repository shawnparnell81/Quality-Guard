-- ============================================================
-- Clause 8.4.2: authority to log a new receiving inspection.
--
-- Viewing receipts and dispositioning a pending one already had
-- homes (no permission gate, and ncr.disposition, respectively).
-- Recording that a shipment arrived in the first place - the thing
-- POST /api/receipts now does - had no permission to require, because
-- the route did not exist yet. Granted to the same quality-floor
-- roles that already touch receiving in practice: seed.sql's own
-- l.castellanos is literally titled "Receiving Inspector" and holds
-- quality_inspector, which did not carry a single receiving
-- permission before this.
-- ============================================================

insert into permissions (key, resource, action, description, clause)
values ('receiving.log', 'receiving', 'log', 'Log a new receiving inspection', '8.4.2')
on conflict (key) do nothing;

-- roles (and its grants) are per-organization since migration 009, so
-- this grants the new permission to every org's own copy of each role
-- rather than a global role_key that no longer exists on its own.
--
-- general_manager is documented as holding "every permission that
-- exists," but that was computed once at provisioning time and does
-- not retroactively pick up a permission invented afterward - see
-- migration 012 for the same note. admin gets it explicitly for the
-- same reason.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'receiving.log'
  from roles r
 where r.key in (
     'quality_inspector', 'quality_tech', 'quality_engineer', 'quality_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;
