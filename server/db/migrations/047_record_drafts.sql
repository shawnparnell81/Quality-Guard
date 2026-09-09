-- ============================================================
-- Server-side record drafts (P3 / M15).
--
-- The record editor autosaves to localStorage so a reload does not
-- lose an in-progress entry. That draft is stuck on one browser: it
-- does not survive a device change, and another person cannot be
-- told "someone has unsaved changes here" with any accuracy.
--
-- One row per (user, draft_key), where draft_key is
-- "<record-type>:<number>" for an edit or "<record-type>:new" for a
-- fresh record. The snapshot is the same {title, severity, due_at,
-- data} shape the localStorage draft already uses. Deleted on a
-- successful save or an explicit discard; org_id is here only so a
-- removed organization takes its drafts with it.
--
-- Idempotent.
-- ============================================================

create table if not exists record_drafts (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    user_id     uuid not null references users(id) on delete cascade,
    draft_key   text not null,
    snapshot    jsonb not null,
    updated_at  timestamptz not null default now(),
    unique (user_id, draft_key)
);

create index if not exists idx_record_drafts_user on record_drafts (user_id);
create index if not exists idx_record_drafts_key  on record_drafts (org_id, draft_key);

drop trigger if exists record_drafts_touch on record_drafts;
create trigger record_drafts_touch
    before update on record_drafts
    for each row execute function touch_updated_at();
