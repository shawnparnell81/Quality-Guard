-- ============================================================
-- Per-organization layout for the dashboard and the menu bar.
--
-- The dashboard panels and the department menu are the same for
-- everyone. An org should be able to arrange them to match how it
-- actually works - which panels matter, which menu item lives under
-- which department. This is one row per (org, kind) holding that
-- arrangement as jsonb; the shape is the client's concern.
--
-- Decided with the user: this is set once per organization by an
-- admin, not personalised per user. layout.manage is the authority
-- to change it; everyone else reads it and follows it.
-- Idempotent.
-- ============================================================

create table if not exists org_layouts (
    org_id     uuid not null references organizations(id) on delete cascade,
    kind       text not null check (kind in ('dashboard', 'nav')),
    layout     jsonb not null default '{}'::jsonb,
    updated_by uuid references users(id) on delete set null,
    updated_at timestamptz not null default now(),
    primary key (org_id, kind)
);

insert into permissions (key, resource, action, description, clause)
values ('layout.manage', 'layout', 'manage',
        'Arrange the dashboard and menu layout for the organization', null)
on conflict (key) do nothing;

-- Existing orgs: grant to the roles that set org-wide configuration.
-- general_manager already holds every permission, computed at
-- provisioning; admin owns access and configuration.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'layout.manage'
  from roles r
 where r.key in ('admin', 'quality_manager', 'general_manager')
 on conflict do nothing;
