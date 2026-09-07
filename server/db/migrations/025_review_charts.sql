-- ============================================================
-- Charts for the management review, clause 9.3.
--
-- A management review is presented, not just recorded: the people in
-- the room want to see the trend, the Pareto, the target-versus-actual
-- bar. Until now that meant pulling numbers into a spreadsheet, making
-- a chart, exporting it and attaching the image - and doing it again
-- next quarter. These two tables let a chart be built and edited in
-- the app instead, and seen by anyone who opens the review.
--
-- review_charts:        one row per chart on a review.
-- review_chart_points:  the (label, value) pairs it plots, ordered.
--
-- Single series per chart on purpose - it covers the bar, the line and
-- the Pareto a review actually uses. Idempotent.
-- ============================================================

create table if not exists review_charts (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    review_id   uuid not null references management_reviews(id) on delete cascade,
    title       text not null,
    chart_type  text not null check (chart_type in ('bar', 'line', 'pareto')),
    x_label     text,
    y_label     text,
    position    integer not null default 0,
    updated_by  uuid references users(id) on delete set null,
    updated_at  timestamptz not null default now()
);

create table if not exists review_chart_points (
    id        uuid primary key default gen_random_uuid(),
    chart_id  uuid not null references review_charts(id) on delete cascade,
    label     text not null,
    value     numeric(14,4) not null default 0,
    position  integer not null default 0
);

create index if not exists idx_review_charts on review_charts (review_id, position);
create index if not exists idx_review_chart_points on review_chart_points (chart_id, position);

-- ---------- permission ----------
insert into permissions (key, resource, action, description, clause)
values ('review.manage', 'review', 'manage', 'Add and edit management review charts', '9.3')
on conflict (key) do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'review.manage'
  from roles r
 where r.key in (
     'quality_manager', 'quality_engineer', 'engineering_manager',
     'production_manager', 'purchasing_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;
