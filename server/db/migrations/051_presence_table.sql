-- ============================================================
-- Concurrent-edit presence, moved out of process memory (audit H8).
--
-- "Who has this record open for editing right now" was a Map in one
-- Node process. Behind a second instance the banners were wrong -
-- each instance only knew its own editors. This table is the shared
-- store; a row is one editor in one record, refreshed by a heartbeat
-- every few seconds and swept ~20s after the last one, so a dropped
-- tab clears itself with no reliable goodbye.
--
-- No history, no audit - it is ephemeral. org_id / user_id cascade
-- so a removed org or person takes its presence rows with it.
-- Idempotent.
-- ============================================================

create table if not exists presence (
    org_id        uuid not null references organizations(id) on delete cascade,
    record_number text not null,
    user_id       uuid not null references users(id) on delete cascade,
    user_name     text not null,
    dirty         boolean not null default false,
    last_seen_at  timestamptz not null default now(),
    primary key (org_id, record_number, user_id)
);

create index if not exists idx_presence_sweep on presence (last_seen_at);
