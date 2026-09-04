-- ============================================================
-- A permission for editing a record type's form.
--
-- Nothing gated this before because nothing needed to: the Form
-- Builder screen was read-only. Now that fields can be added, removed
-- and reordered, changing what a company's own NCR or CAPA form
-- collects is itself an authority - the same way changing the
-- permission matrix is - and it needs its own key rather than
-- riding along on an unrelated one.
--
-- Written generically over every organization that exists, not just
-- the demo one: roles are per-org now, so a fresh grant has to reach
-- each company's own copy of general_manager, admin and
-- quality_manager, not a single hard-coded org.
-- ============================================================

insert into permissions (key, resource, action, description, clause)
values ('forms.manage', 'forms', 'manage', 'Add, remove or reorder the fields on a record type''s form', '7.5')
on conflict (key) do nothing;

-- general_manager already holds "every permission that exists," but
-- that was computed once at provisioning time - it does not retroactively
-- pick up a permission invented afterward. admin and quality_manager get
-- it explicitly, matching how provision-org.js grants new companies going
-- forward (see the widened admin rule and the addition to quality_manager
-- there).
insert into role_permissions (org_id, role_key, permission_key)
select o.id, r.role_key, 'forms.manage'
  from organizations o
  cross join (values ('general_manager'), ('admin'), ('quality_manager')) as r(role_key)
 where exists (select 1 from roles where org_id = o.id and key = r.role_key)
on conflict do nothing;
