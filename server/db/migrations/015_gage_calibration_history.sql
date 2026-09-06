-- Calibration was read-only before this: gages.next_due/last_cal held
-- whatever seed data put there, with no way to actually record a
-- result and no history of past ones. This adds both.

alter table gages add column if not exists availability text not null default 'available'
    check (availability in ('available', 'hold'));

-- "status" in the gages API response already means something else
-- (past_due / due_soon / current, derived from the due date, never
-- stored) - availability is a genuinely separate fact: whether the
-- gage failed its last calibration, which no due date can tell you.

create table if not exists gage_calibrations (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    gage_id      uuid not null references gages(id) on delete cascade,
    performed_at timestamptz not null default now(),
    performed_by uuid references users(id) on delete set null,
    result       text not null check (result in ('pass', 'fail')),
    reading      text,
    notes        text,
    created_at   timestamptz not null default now()
);

create index if not exists idx_gage_calibrations_gage
    on gage_calibrations (gage_id, performed_at desc);
