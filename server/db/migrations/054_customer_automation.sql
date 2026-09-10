-- ============================================================
-- Customer onboarding automation.
--
-- On top of the Sales & Marketing tables (053): a numbered folder
-- structure per customer, a 1:1 metadata / profile snapshot, and an
-- append-only automation_logs trail. An engine
-- (server/src/customer-automation.js) runs the steps automatically on
-- customer creation and each is also a manual button.
--
-- The seven numbered folders replace the six free-form document
-- categories from 053 - customer_documents now attaches to a stage OR
-- a folder. Any stray category document is remapped to 01_Admin.
--
-- Idempotent. Written over every organization.
-- ============================================================

-- ---------- folder structure ----------

create table if not exists customer_folders (
    id           uuid primary key default gen_random_uuid(),
    customer_id  uuid not null references customers(id) on delete cascade,
    folder_key   text not null check (folder_key in (
                     'admin', 'quality', 'engineering', 'production',
                     'supply_chain', 'orders', 'projects'
                 )),
    name         text not null,
    position     integer not null,
    path         text,
    storage_path text,
    status       text not null default 'pending' check (status in ('pending', 'created')),
    created_at   timestamptz not null default now(),
    unique (customer_id, folder_key)
);

create index if not exists idx_customer_folders_customer
    on customer_folders (customer_id, position);

-- ---------- metadata + profiles (1:1 with a customer) ----------

create table if not exists customer_metadata (
    id                       uuid primary key default gen_random_uuid(),
    customer_id              uuid not null unique references customers(id) on delete cascade,
    billing_address          text,
    shipping_address         text,
    contacts                 jsonb not null default '[]'::jsonb,
    quality_requirements     jsonb not null default '{}'::jsonb,
    engineering_requirements  jsonb not null default '{}'::jsonb,
    folder_root              text,
    synced_at                timestamptz,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

-- ---------- automation trail (append-only) ----------

create table if not exists automation_logs (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    customer_id uuid not null references customers(id) on delete cascade,
    step        text not null,
    status      text not null check (status in ('running', 'done', 'failed', 'skipped')),
    run_source  text not null check (run_source in ('auto', 'manual')),
    detail      text,
    error       text,
    started_at  timestamptz,
    finished_at timestamptz,
    created_at  timestamptz not null default now()
);

create index if not exists idx_automation_logs_customer
    on automation_logs (customer_id, step, created_at desc);

-- ---------- customer_documents: file into a folder, not a category ----------

alter table customer_documents
    add column if not exists folder_id uuid references customer_folders(id) on delete set null;

-- Any document filed under a legacy category (none in practice) moves
-- into that customer's 01_Admin folder so the new constraint holds.
do $$
begin
    insert into customer_folders (customer_id, folder_key, name, position, status)
    select distinct cd.customer_id, 'admin', '01_Admin', 0, 'pending'
      from customer_documents cd
     where cd.category is not null and cd.stage_id is null
    on conflict (customer_id, folder_key) do nothing;

    update customer_documents cd
       set folder_id = f.id, category = null
      from customer_folders f
     where f.customer_id = cd.customer_id and f.folder_key = 'admin'
       and cd.category is not null and cd.stage_id is null;
end $$;

alter table customer_documents
    drop constraint if exists customer_documents_stage_xor_category;
alter table customer_documents
    add constraint customer_documents_target_one
    check ((stage_id is not null)::int + (folder_id is not null)::int = 1);

-- ---------- seed the folder set for the demo customers ----------
-- So the Sales & Marketing screens are populated before any automation
-- run in a dev database. Guarded to the seed org, idempotent.

do $$
declare
    seed_org uuid := '11111111-1111-1111-1111-111111111111';
    folders  text[][] := array[
        array['admin',        '01_Admin',       '0'],
        array['quality',      '02_Quality',     '1'],
        array['engineering',  '03_Engineering', '2'],
        array['production',   '04_Production',  '3'],
        array['supply_chain', '05_SupplyChain', '4'],
        array['orders',       '06_Orders',      '5'],
        array['projects',     '07_Projects',    '6']
    ];
    cust record;
    i    int;
begin
    if not exists (select 1 from organizations where id = seed_org) then
        return;
    end if;

    for cust in
        select id from customers
         where org_id = seed_org and name in ('Cedar Ridge Automotive', 'Northlake Hydraulics')
    loop
        for i in 1 .. array_length(folders, 1) loop
            insert into customer_folders (customer_id, folder_key, name, position, status)
            values (cust.id, folders[i][1], folders[i][2], (folders[i][3])::int, 'pending')
            on conflict (customer_id, folder_key) do nothing;
        end loop;

        insert into customer_metadata (customer_id)
        values (cust.id)
        on conflict (customer_id) do nothing;
    end loop;
end $$;
