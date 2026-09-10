-- ============================================================
-- Sales & Marketing: the customer master, a customer-onboarding
-- staged workflow, and a per-customer document folder.
--
-- "Customer" was free text everywhere (complaints, APQP, PPAP, the
-- Customer Service logs). This gives it a home, mirroring the Vendor
-- Onboarding tables (005/021/022) for the sell side: customers,
-- customer_onboarding_stages, and customer_documents - which attaches
-- either to an onboarding stage OR to a free-form library category
-- (quotes, specs, drawings, contracts, correspondence).
--
-- Idempotent. Written over every organization, like migrations 010-018.
-- ============================================================

create table if not exists customers (
    id                     uuid primary key default gen_random_uuid(),
    org_id                 uuid not null references organizations(id) on delete cascade,
    name                   text not null,
    code                   text,
    status                 text not null default 'prospect' check (status in (
                               'prospect', 'active', 'inactive'
                           )),
    primary_contact_name   text,
    primary_contact_email  text,
    phone                  text,
    address                text,
    notes                  text,
    data                   jsonb not null default '{}'::jsonb,
    created_by             uuid references users(id) on delete set null,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    unique (org_id, name)
);

create unique index if not exists idx_customers_code
    on customers (org_id, code) where code is not null;
create index if not exists idx_customers_org_status
    on customers (org_id, status);

-- Same shape as vendor_onboarding_stages (005), keyed to a customer.
create table if not exists customer_onboarding_stages (
    id           uuid primary key default gen_random_uuid(),
    customer_id  uuid not null references customers(id) on delete cascade,
    stage_key    text not null,
    name         text not null,
    detail       text,
    status       text not null default 'pending' check (status in (
                     'pending', 'in_progress', 'complete', 'skipped'
                 )),
    completed_by uuid references users(id) on delete set null,
    completed_at timestamptz,
    position     integer not null,
    unique (customer_id, stage_key)
);

create index if not exists idx_customer_stages
    on customer_onboarding_stages (customer_id, position);

-- A document in a customer's folder. Exactly one of stage_id / category
-- is set: stage_id ties it to an onboarding stage, category files it in
-- the free-form library.
create table if not exists customer_documents (
    id                uuid primary key default gen_random_uuid(),
    org_id            uuid not null references organizations(id) on delete cascade,
    customer_id       uuid not null references customers(id) on delete cascade,
    stage_id          uuid references customer_onboarding_stages(id) on delete cascade,
    category          text check (category in (
                          'quote', 'spec', 'drawing', 'contract', 'correspondence', 'other'
                      )),
    kind              text not null check (kind in ('upload', 'link')),
    original_filename text,
    mime_type         text,
    size_bytes        bigint,
    storage_path      text,
    document_id       uuid references documents(id) on delete set null,
    note              text,
    uploaded_by       uuid references users(id) on delete set null,
    uploaded_at       timestamptz not null default now(),
    constraint customer_documents_stage_xor_category
        check ((stage_id is not null) <> (category is not null))
);

create index if not exists idx_customer_documents_customer
    on customer_documents (customer_id);
create index if not exists idx_customer_documents_stage
    on customer_documents (stage_id);

-- ---------- permissions ----------

insert into permissions (key, resource, action, description, clause) values
    ('customer.read',    'customer', 'read',    'View customers and their folders',          '8.2'),
    ('customer.manage',  'customer', 'manage',  'Add and edit customers and their documents', '8.2'),
    ('customer.onboard', 'customer', 'onboard', 'Complete a customer onboarding stage',       '8.2.3')
on conflict (key) do nothing;

-- roles are per-organization since migration 009; grant to each org's
-- own copy of the roles that front customer work. general_manager and
-- admin were snapshotted "every permission" at provisioning time and do
-- not retroactively pick up a new one - granted explicitly here, same
-- as migrations 013/018.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'customer.read'
  from roles r
 where r.key in (
     'quality_engineer', 'purchasing_manager', 'production_manager',
     'engineering_manager', 'quality_manager', 'document_controller',
     'general_manager', 'admin'
 )
 on conflict do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, perm.key
  from roles r
 cross join (values ('customer.manage'), ('customer.onboard')) as perm(key)
 where r.key in (
     'quality_manager', 'engineering_manager', 'purchasing_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;

-- ---------- demo data for the seed org only ----------
-- So the Sales & Marketing screens are not empty in a dev database.
-- Guarded to the seed org id and idempotent.

do $$
declare
    seed_org   uuid := '11111111-1111-1111-1111-111111111111';
    stages     text[][] := array[
        array['nda_terms',     'NDA & terms of business',           'Mutual NDA and agreed commercial terms on file.'],
        array['requirements',  'Requirements & specifications',      'Customer drawings, specs and quality requirements captured.'],
        array['quotation',     'Quotation issued',                   'Priced quote sent and acknowledged.'],
        array['sample_fai',    'Sample / first article approval',    'Samples submitted and signed off by the customer.'],
        array['ppap',          'PPAP / part approval',               'Full submission approved where the customer requires it.'],
        array['account_setup', 'Account & portal setup',             'Payment terms, portal access and shipping accounts set up.']
    ];
    cust       record;
    i          int;
begin
    if not exists (select 1 from organizations where id = seed_org) then
        return;
    end if;

    insert into customers (org_id, name, code, status, primary_contact_name, primary_contact_email)
    values
        (seed_org, 'Cedar Ridge Automotive', 'CRA', 'active',
         'D. Whitfield', 'purchasing@cedarridge.example'),
        (seed_org, 'Northlake Hydraulics', 'NLH', 'prospect',
         'M. Okafor', 'sourcing@northlake.example')
    on conflict (org_id, name) do nothing;

    for cust in
        select id, status from customers
         where org_id = seed_org and name in ('Cedar Ridge Automotive', 'Northlake Hydraulics')
    loop
        for i in 1 .. array_length(stages, 1)
        loop
            insert into customer_onboarding_stages (customer_id, stage_key, name, detail, status, position)
            values (
                cust.id, stages[i][1], stages[i][2], stages[i][3],
                case when cust.status = 'active' then 'complete' else 'pending' end,
                i - 1
            )
            on conflict (customer_id, stage_key) do nothing;
        end loop;
    end loop;
end $$;
