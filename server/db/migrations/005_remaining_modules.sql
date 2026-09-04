-- ============================================================
-- Tables for the last seven screens.
--
-- Drawings, receiving, shipping, vendor onboarding, management
-- review and quality objectives. Each one existed as invented numbers
-- on a screen; this gives them somewhere real to live.
--
-- The pattern throughout: a header row for the thing, and a child
-- table for the lines somebody signs. Sign-offs are rows, never
-- fields overwritten in place, because who signed and when is the
-- part an auditor asks for.
-- ============================================================

-- ------------------------------------------------------------
-- Drawings, clause 8.3
-- ------------------------------------------------------------

create table if not exists drawings (
    id               uuid primary key default gen_random_uuid(),
    org_id           uuid not null references organizations(id) on delete cascade,
    drawing_number   text not null,
    title            text not null,
    part_id          uuid references parts(id) on delete set null,
    customer         text,
    current_revision text,
    status           text not null default 'released' check (status in (
                         'draft', 'in_review', 'released', 'obsolete'
                     )),
    -- Production reads the current revision and nothing else. Anything
    -- still in work stays with engineering until it is released.
    access_level     text not null default 'eng_qa' check (access_level in (
                         'all_plant', 'eng_qa', 'eng_only'
                     )),
    owner_id         uuid references users(id) on delete set null,
    created_at       timestamptz not null default now(),
    unique (org_id, drawing_number)
);

create table if not exists drawing_revisions (
    id             uuid primary key default gen_random_uuid(),
    drawing_id     uuid not null references drawings(id) on delete cascade,
    revision       text not null,
    change_summary text not null,
    ecn_number     text,
    status         text not null default 'draft' check (status in (
                       'draft', 'in_review', 'released', 'superseded'
                   )),
    released_by    uuid references users(id) on delete set null,
    released_at    timestamptz,
    unique (drawing_id, revision)
);

-- ------------------------------------------------------------
-- Receiving inspection, clause 8.4.2
-- ------------------------------------------------------------

create table if not exists receipts (
    id             uuid primary key default gen_random_uuid(),
    org_id         uuid not null references organizations(id) on delete cascade,
    receipt_number text not null,
    po_number      text,
    vendor_id      uuid references vendors(id) on delete set null,
    part_number    text,
    lot_id         uuid references lots(id) on delete set null,
    qty_received   integer not null default 0,
    received_at    timestamptz not null default now(),
    -- The sampling plan follows the vendor's grade: a grade D supplier
    -- goes to 100 percent until they earn their way back.
    sample_plan    text,
    status         text not null default 'pending' check (status in (
                       'pending', 'accept', 'reject'
                   )),
    inspected_by   uuid references users(id) on delete set null,
    inspected_at   timestamptz,
    notes          text,
    unique (org_id, receipt_number)
);

create table if not exists receipt_measurements (
    id             uuid primary key default gen_random_uuid(),
    receipt_id     uuid not null references receipts(id) on delete cascade,
    characteristic text not null,
    specification  text,
    actual         text,
    result         text check (result in ('pass', 'fail')),
    gage_id        text,
    position       integer not null
);

-- ------------------------------------------------------------
-- Shipping, clause 8.6
-- ------------------------------------------------------------

create table if not exists shipments (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations(id) on delete cascade,
    shipment_number text not null,
    customer        text not null,
    part_number     text,
    lot_id          uuid references lots(id) on delete set null,
    qty             integer not null default 0,
    ship_date       date,
    carrier         text,
    status          text not null default 'preparing' check (status in (
                        'preparing', 'awaiting_release', 'shipped', 'blocked'
                    )),
    released_by     uuid references users(id) on delete set null,
    released_at     timestamptz,
    unique (org_id, shipment_number)
);

-- Nothing ships until every line here passes. That is clause 8.6.
create table if not exists shipment_checks (
    id          uuid primary key default gen_random_uuid(),
    shipment_id uuid not null references shipments(id) on delete cascade,
    description text not null,
    evidence    text,
    status      text not null default 'pending' check (status in (
                    'pending', 'pass', 'fail'
                )),
    position    integer not null
);

-- ------------------------------------------------------------
-- Vendor onboarding, clause 8.4.1
-- ------------------------------------------------------------

create table if not exists vendor_onboarding_stages (
    id           uuid primary key default gen_random_uuid(),
    vendor_id    uuid not null references vendors(id) on delete cascade,
    stage_key    text not null,
    name         text not null,
    detail       text,
    status       text not null default 'pending' check (status in (
                     'pending', 'in_progress', 'complete', 'skipped'
                 )),
    completed_by uuid references users(id) on delete set null,
    completed_at timestamptz,
    position     integer not null,
    unique (vendor_id, stage_key)
);

-- ------------------------------------------------------------
-- Management review, clause 9.3
-- ------------------------------------------------------------

create table if not exists management_reviews (
    id         uuid primary key default gen_random_uuid(),
    org_id     uuid not null references organizations(id) on delete cascade,
    reference  text not null,
    period     text not null,
    held_on    date,
    chair_id   uuid references users(id) on delete set null,
    status     text not null default 'planned' check (status in (
                   'planned', 'in_progress', 'closed'
               )),
    notes      text,
    unique (org_id, reference)
);

-- Clause 9.3.3 says a review produces decisions and actions. These are
-- them, and they are what makes the next review's first input real.
create table if not exists management_review_actions (
    id         uuid primary key default gen_random_uuid(),
    review_id  uuid not null references management_reviews(id) on delete cascade,
    decision   text not null,
    owner_id   uuid references users(id) on delete set null,
    due_on     date,
    status     text not null default 'open' check (status in (
                   'open', 'in_progress', 'done', 'dropped'
               )),
    position   integer not null
);

-- ------------------------------------------------------------
-- Quality objectives, clause 6.2
-- ------------------------------------------------------------

create table if not exists quality_objectives (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    name          text not null,
    clause        text,
    target_value  numeric(12,2) not null,
    unit          text,
    -- Whether higher is better. On-time delivery wants a floor, defect
    -- rate wants a ceiling, and a single "on target" test cannot serve
    -- both without knowing which.
    direction     text not null check (direction in ('min', 'max')),
    -- Where the actual comes from. A key the API knows how to compute
    -- means the number cannot go stale; anything else falls back to
    -- stored_actual and is honest about being entered by hand.
    source        text,
    stored_actual numeric(12,2),
    owner_id      uuid references users(id) on delete set null,
    period        text,
    position      integer not null,
    unique (org_id, name)
);

create index if not exists idx_drawing_revs on drawing_revisions (drawing_id);
create index if not exists idx_receipt_meas on receipt_measurements (receipt_id, position);
create index if not exists idx_ship_checks  on shipment_checks (shipment_id, position);
create index if not exists idx_onboarding   on vendor_onboarding_stages (vendor_id, position);
create index if not exists idx_review_acts  on management_review_actions (review_id, position);
