-- ============================================================
-- Make roles and role_permissions per-organization.
--
-- Both were global tables: one "quality_manager" row shared by every
-- company that will ever use this system, and one grant list under
-- it. That is fine for a single demo tenant and wrong the moment a
-- second real company signs up, because one company editing its
-- permission matrix would silently change what "Quality Manager"
-- means for every other company too.
--
-- permissions itself stays global on purpose: it is the fixed catalog
-- of things the application knows how to gate (ncr.create, capa.close,
-- and so on), defined by the code, not by any one tenant. What needed
-- to become per-tenant is which of those a company's OWN roles carry.
--
-- users.email also becomes globally unique here rather than unique
-- per org. Sign-in is one box for the whole platform with no "which
-- company" step first, so a login lookup has to find at most one row
-- by email alone.
--
-- Drop order matters: the old foreign keys on role_permissions and
-- users both depend on roles' original primary key, so they have to
-- go BEFORE that key changes shape, not after.
-- ============================================================

-- ---------- drop what depends on roles' current primary key ----------

alter table role_permissions drop constraint if exists role_permissions_role_key_fkey;
alter table users drop constraint if exists users_role_fkey;


-- ---------- roles: (org_id, key) instead of a bare key ----------

alter table roles add column if not exists org_id uuid references organizations(id) on delete cascade;

update roles set org_id = '11111111-1111-1111-1111-111111111111' where org_id is null;

alter table roles alter column org_id set not null;

alter table roles drop constraint roles_pkey;
alter table roles add primary key (org_id, key);


-- ---------- role_permissions: gains its own org_id ----------

alter table role_permissions add column if not exists org_id uuid references organizations(id) on delete cascade;

update role_permissions set org_id = '11111111-1111-1111-1111-111111111111' where org_id is null;

alter table role_permissions alter column org_id set not null;

alter table role_permissions drop constraint role_permissions_pkey;
alter table role_permissions add primary key (org_id, role_key, permission_key);

alter table role_permissions
    add constraint role_permissions_role_fkey
    foreign key (org_id, role_key) references roles(org_id, key) on delete cascade;


-- ---------- users.role: same composite reference ----------

alter table users
    add constraint users_role_fkey
    foreign key (org_id, role) references roles(org_id, key);


-- ---------- users.email: globally unique ----------

alter table users drop constraint if exists users_org_id_email_key;
alter table users add constraint users_email_key unique (email);


-- ---------- session lookup no longer needs to know the org up front ----------
-- (no schema change: sessions already key off user_id, and the org now
-- travels with the user row the session resolves to)

comment on column roles.org_id is
    'Each company keeps its own copy of the role list, so changing one
     company''s permission matrix can never affect another''s.';

comment on column role_permissions.org_id is
    'Denormalized from roles.org_id so this table can be queried and
     locked down (org_id = $1) without a join back to roles first.';
