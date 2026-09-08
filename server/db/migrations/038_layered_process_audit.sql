-- ============================================================
-- Layered Process Audit (LPA), IATF 16949 clause 9.2.2.
--
-- Recurring checklist audits done by different layers of the
-- organisation (a shift supervisor daily, an area manager weekly, a
-- plant manager monthly) against a process or area.
--
--   lpa_templates / lpa_questions  - the question bank.
--   lpa_schedules                  - layer x area x frequency; carries
--                                     next_due, rolled forward as
--                                     instances are materialised.
--   lpa_audits                     - one instance: scheduled, in
--                                     progress, complete or missed.
--   lpa_answers                    - one row per question per audit,
--                                     pass / fail / n-a, and the NCR
--                                     number raised for a fail.
--
-- Due instances are materialised lazily on GET /api/lpa (no cron):
-- a schedule past due with no open instance gets one, and its
-- next_due moves forward; an open instance past its due date is
-- marked missed. Generic over every organization.
-- ============================================================

-- ---------- permissions ----------

insert into permissions (key, resource, action, description, clause) values
    ('lpa.read',   'lpa', 'read',   'View layered process audits',                     '9.2.2'),
    ('lpa.audit',  'lpa', 'audit',  'Perform a layered process audit',                 '9.2.2'),
    ('lpa.manage', 'lpa', 'manage', 'Create LPA templates and schedules',              '9.2.2')
on conflict (key) do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, p
  from roles r
  cross join (values ('lpa.read')) as v(p)
 where r.key in (
     'operator', 'quality_inspector', 'quality_tech', 'quality_engineer',
     'manufacturing_engineer', 'production_manager', 'engineering_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'lpa.audit'
  from roles r
 where r.key in (
     'quality_inspector', 'quality_tech', 'quality_engineer',
     'manufacturing_engineer', 'production_manager', 'engineering_manager',
     'quality_manager', 'general_manager', 'admin'
 )
 on conflict do nothing;

insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, 'lpa.manage'
  from roles r
 where r.key in (
     'quality_engineer', 'engineering_manager', 'quality_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;

-- ---------- tables ----------

create table if not exists lpa_templates (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    name        text not null,
    description text,
    active      boolean not null default true,
    created_by  uuid references users(id) on delete set null,
    created_at  timestamptz not null default now()
);

create table if not exists lpa_questions (
    id          uuid primary key default gen_random_uuid(),
    template_id uuid not null references lpa_templates(id) on delete cascade,
    position    integer not null default 0,
    text        text not null,
    guidance    text,
    critical    boolean not null default false
);

create table if not exists lpa_schedules (
    id             uuid primary key default gen_random_uuid(),
    org_id         uuid not null references organizations(id) on delete cascade,
    template_id    uuid not null references lpa_templates(id) on delete cascade,
    layer          text not null,
    area           text not null,
    auditor_id     uuid references users(id) on delete set null,
    frequency_days integer not null check (frequency_days between 1 and 365),
    next_due       date not null,
    active         boolean not null default true,
    created_by     uuid references users(id) on delete set null,
    created_at     timestamptz not null default now()
);

create table if not exists lpa_audits (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    schedule_id  uuid references lpa_schedules(id) on delete set null,
    template_id  uuid not null references lpa_templates(id) on delete cascade,
    layer        text not null,
    area         text not null,
    auditor_id   uuid references users(id) on delete set null,
    due_on       date not null,
    performed_on date,
    status       text not null default 'scheduled' check (status in (
                     'scheduled', 'in_progress', 'complete', 'missed'
                 )),
    score_pass   integer not null default 0,
    score_total  integer not null default 0,
    created_at   timestamptz not null default now()
);

create table if not exists lpa_answers (
    id          uuid primary key default gen_random_uuid(),
    audit_id    uuid not null references lpa_audits(id) on delete cascade,
    question_id uuid not null references lpa_questions(id) on delete cascade,
    result      text not null check (result in ('pass', 'fail', 'na')),
    note        text,
    ncr_number  text,
    answered_by uuid references users(id) on delete set null,
    answered_at timestamptz not null default now(),
    unique (audit_id, question_id)
);

create index if not exists idx_lpa_questions on lpa_questions (template_id, position);
create index if not exists idx_lpa_schedules on lpa_schedules (org_id, active, next_due);
create index if not exists idx_lpa_audits    on lpa_audits (org_id, status, due_on);
create index if not exists idx_lpa_answers   on lpa_answers (audit_id);
