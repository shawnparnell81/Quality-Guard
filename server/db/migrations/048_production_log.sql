-- ============================================================
-- Customer Service: the production log.
--
-- Work orders (work_orders) are a thin floor record - part, lot, qty,
-- cell, traveller. They carry nothing about the order behind the job:
-- which customer, their PO, the date it was promised, how many came
-- out good, how many were scrapped, how many shipped. The person who
-- writes the work orders (the CSR) keeps that ledger, and until now
-- had nowhere in the app to keep it.
--
-- One thin row per tracked job - a number, the work order it follows,
-- the customer, a status, the quantities and dates that matter, a
-- free-text note - with a `data jsonb` column for whatever the
-- finessed form adds later (setup time, quality sign-off, NCR hold
-- reference, fulfilment status). Same shape the purchase order and
-- purchase request logs took in migration 030.
--
-- Access: viewing is open to any signed-in user, the same as the
-- other Customer Service logs. Creating and editing entries reuses
-- wo.log - the permission the work-order author already holds - so
-- the CSR and the General Manager (who holds every permission) are
-- the only people who can change a row. No new permission or role.
--
-- Idempotent.
-- ============================================================

create table if not exists production_logs (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations(id) on delete cascade,
    pl_number       text not null,
    wo_number       text,                       -- the work order this row follows; work_orders stays the source of truth
    customer        text,
    customer_po     text,
    part_number     text,
    revision        text,
    status          text not null default 'scheduled' check (status in (
                        'scheduled', 'in_production', 'hold', 'shipped', 'closed', 'cancelled'
                    )),
    order_date      date,                        -- date the order was confirmed
    promised_date   date,                        -- promised ship date
    qty_ordered     integer,
    qty_completed   integer,
    qty_scrapped    integer,
    qty_shipped     integer,
    line            text,                        -- production line / work centre
    notes           text,
    data            jsonb not null default '{}'::jsonb,
    created_by      uuid references users(id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (org_id, pl_number)
);

create index if not exists idx_production_logs_org
    on production_logs (org_id, status, order_date desc);

create index if not exists idx_production_logs_wo
    on production_logs (org_id, wo_number);
