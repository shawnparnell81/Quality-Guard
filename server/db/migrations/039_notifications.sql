-- ============================================================
-- In-app notifications (P3.4).
--
-- One row per (person, thing that wants their attention). Four kinds
-- so far:
--   assigned  - a record you own and it is still open
--   overdue   - a record you own that is past its due date
--   approval  - a record whose next workflow step needs a permission
--               you hold (someone did the work, you sign off)
--   finding   - an audit you own that turned up a warn/crit finding
--
-- The feed is kept in sync lazily on GET /api/notifications (the same
-- "compute on read" pattern as the LPA roll-forward), and pushed live
-- when a record you own is created or transitioned. dedupe_key keeps
-- one row per underlying condition per person; when the condition
-- clears, the sync deletes the still-unread row.
--
-- Generic over every organization - no per-org seed.
-- ============================================================

create table if not exists notifications (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    user_id     uuid not null references users(id) on delete cascade,
    kind        text not null check (kind in ('assigned', 'overdue', 'approval', 'finding')),
    title       text not null,
    body        text,
    link_type   text,              -- record type key, e.g. 'ncr' (drives the deep-link)
    link_number text,              -- e.g. 'NCR-2026-0142'
    dedupe_key  text,              -- one unread row per (user, dedupe_key)
    read_at     timestamptz,
    created_at  timestamptz not null default now()
);

-- One live row per condition per person. Partial so that once a row
-- is read, a fresh occurrence of the same condition can be raised
-- again later.
create unique index if not exists notifications_dedupe
    on notifications (user_id, dedupe_key)
    where dedupe_key is not null and read_at is null;

create index if not exists notifications_user_feed
    on notifications (user_id, read_at, created_at desc);
