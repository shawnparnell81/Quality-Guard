-- ============================================================
-- Management review: the write side (clause 9.3).
--
-- The module has had its 9.3.2 input pack (auto-compiled), its
-- 9.3.3 actions and its charts since migrations 005 / 025, but all
-- of it read-only - reviews and actions only ever came from seed
-- data. This adds:
--
--   * attendance (9.3 expects the review to record who was there);
--   * a link from a 9.3.3 action to the CAPA or record that carries
--     it out, so "status of actions from previous reviews" is a live
--     number rather than a memory.
--
-- The create / edit endpoints and the minutes PDF are code
-- (routes/evaluate.js); this file is only the schema they need.
-- Idempotent.
-- ============================================================

alter table management_review_actions
    add column if not exists linked_record text;

create table if not exists management_review_attendance (
    id         uuid primary key default gen_random_uuid(),
    org_id     uuid not null references organizations(id) on delete cascade,
    review_id  uuid not null references management_reviews(id) on delete cascade,
    name       text not null,
    role       text,
    present    boolean not null default true,
    position   integer not null default 0
);

create index if not exists idx_review_attendance on management_review_attendance (review_id, position);

-- review.manage already exists (migration 025). Make sure the roles
-- that run a review can also now create and close one - same set 025
-- granted the chart permission to.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'review.manage'
  from roles r
 where r.key in (
     'quality_manager', 'quality_engineer', 'engineering_manager',
     'production_manager', 'purchasing_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;
