-- ============================================================
-- Customer Service: purchase order and purchase request logs.
--
-- The app tracked work orders on the floor but had nowhere to record
-- what was ordered from suppliers, or what the shop asked to be
-- ordered. These two tables are the logs. They are deliberately thin
-- - a number, who it involves, a status, the dates that matter, a
-- free-text note - with a `data jsonb` column for the fields we will
-- add once the forms are finessed. Same shape receipts took in
-- migration 028.
--
-- Work orders already have a table (work_orders) and a register; the
-- work order log is a view onto that, plus a new POST route, no new
-- table here.
-- Idempotent.
-- ============================================================

create table if not exists purchase_orders (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    po_number     text not null,
    vendor_id     uuid references vendors(id) on delete set null,
    vendor_name   text,                       -- free-text when the supplier is not on the AVL
    status        text not null default 'open' check (status in (
                      'draft', 'open', 'partially_received', 'received', 'closed', 'cancelled'
                  )),
    order_date    date,
    need_by_date  date,
    total_amount  numeric(14, 2),
    currency      text not null default 'USD',
    buyer_id      uuid references users(id) on delete set null,
    notes         text,
    data          jsonb not null default '{}'::jsonb,
    created_by    uuid references users(id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    unique (org_id, po_number)
);

create index if not exists idx_purchase_orders_org
    on purchase_orders (org_id, status, order_date desc);

create table if not exists purchase_requests (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations(id) on delete cascade,
    pr_number       text not null,
    requested_by    uuid references users(id) on delete set null,
    department      text,
    status          text not null default 'submitted' check (status in (
                        'draft', 'submitted', 'approved', 'rejected', 'ordered', 'closed'
                    )),
    needed_by_date  date,
    estimated_cost  numeric(14, 2),
    description     text,
    po_number       text,                     -- filled once a PO is raised against it
    notes           text,
    data            jsonb not null default '{}'::jsonb,
    created_by      uuid references users(id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (org_id, pr_number)
);

create index if not exists idx_purchase_requests_org
    on purchase_requests (org_id, status, created_at desc);

-- ------------------------------------------------------------
-- Permissions. Viewing a log is open to any signed-in user (same as
-- the receiving register); creating and editing entries is gated.
-- ------------------------------------------------------------

insert into permissions (key, resource, action, description, clause)
values
    ('purchasing.log', 'purchasing', 'log',
     'Create and edit purchase order and purchase request log entries', '8.4.1'),
    ('wo.log', 'work_order', 'log',
     'Create and edit work order log entries', '8.5.1')
on conflict (key) do nothing;

-- Grant to every org's own copy of the roles that do this work.
-- general_manager already holds every permission, computed at
-- provisioning; this covers orgs provisioned before today.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'purchasing.log'
  from roles r
 where r.key in ('purchasing_manager', 'production_manager', 'quality_manager', 'general_manager')
 on conflict do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'wo.log'
  from roles r
 where r.key in ('production_manager', 'manufacturing_engineer', 'quality_manager', 'general_manager')
 on conflict do nothing;
