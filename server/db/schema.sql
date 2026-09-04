-- ============================================================
-- QUALITYGUARD SCHEMA
--
-- Two kinds of table live here, and the split is the whole design:
--
--   1. MASTER DATA gets real typed tables. Parts, lots, vendors,
--      gages, documents and people have a fixed shape, need foreign
--      keys, and get queried in structured ways.
--
--   2. QUALITY EVENTS share ONE universal table. An NCR, a CAPA, an
--      8D, a complaint, a SCAR and an audit finding are the same
--      object: a numbered record with a status, an owner, a form
--      payload and links to other records. The form payload lives in
--      JSONB so the Form Builder can change it without a migration.
--
-- That is why 23 modules do not need 23 codebases.
-- ============================================================

drop table if exists audit_log            cascade;
drop table if exists attachments          cascade;
drop table if exists record_links         cascade;
drop table if exists records              cascade;
drop table if exists workflow_transitions cascade;
drop table if exists workflow_states      cascade;
drop table if exists form_versions        cascade;
drop table if exists record_types         cascade;
-- Dropped so a full rebuild re-applies every migration. Leaving it
-- would recreate the tables at their baseline shape while still
-- believing the later migrations had run.
drop table if exists schema_migrations    cascade;

drop table if exists first_article_results cascade;
drop table if exists work_order_operations cascade;
drop table if exists sessions             cascade;
drop table if exists role_permissions     cascade;
drop table if exists permissions          cascade;
drop table if exists roles                cascade;
drop table if exists certifications       cascade;
drop table if exists document_requirements cascade;
drop table if exists training_records     cascade;
drop table if exists work_orders          cascade;
drop table if exists document_revisions   cascade;
drop table if exists documents            cascade;
drop table if exists gages                cascade;
drop table if exists vendors              cascade;
drop table if exists lots                 cascade;
drop table if exists parts                cascade;
drop table if exists users                cascade;
drop table if exists sites                cascade;
drop table if exists organizations        cascade;


-- ============================================================
-- Tenancy and people
-- ============================================================

create table organizations (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    created_at  timestamptz not null default now()
);

create table sites (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    code        text not null,
    name        text not null,
    unique (org_id, code)
);

-- Certifications the site holds. A plant can carry ISO 9001, AS9100 and
-- ISO 14001 at once, each with its own registrar and audit cycle, so
-- this is a table rather than columns on the organization.
--
-- next_audit_on is what the countdown in the header reads from. Nothing
-- in the UI should ever hard-code a date.
create table certifications (
    id                  uuid primary key default gen_random_uuid(),
    org_id              uuid not null references organizations(id) on delete cascade,
    site_id             uuid references sites(id) on delete cascade,
    standard            text not null,
    registrar           text,
    certificate_number  text,
    issued_on           date,
    expires_on          date,
    next_audit_on       date,
    audit_type          text check (audit_type in (
                           'stage_1', 'stage_2', 'surveillance', 'recertification'
                        )),
    scope               text,
    created_at          timestamptz not null default now()
);

-- ============================================================
-- Roles and permissions
--
-- This is not only plumbing. ISO 9001 clause 5.3 requires that roles,
-- responsibilities and authorities are assigned and communicated, and
-- an auditor will ask to see it written down. These three tables ARE
-- that document, which is why the matrix is data rather than a
-- hard-coded map in the application.
-- ============================================================

create table roles (
    key         text primary key,
    name        text not null,
    description text,
    position    integer not null
);

-- One row per thing a person can do. `clause` records which part of
-- the standard the authority belongs to, so the permission matrix can
-- be shown to an auditor clause by clause.
create table permissions (
    key         text primary key,
    resource    text not null,
    action      text not null,
    description text not null,
    clause      text
);

create table role_permissions (
    role_key       text not null references roles(key) on delete cascade,
    permission_key text not null references permissions(key) on delete cascade,
    primary key (role_key, permission_key)
);

create table users (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    email       text not null,
    full_name   text not null,
    initials    text not null,
    role        text not null references roles(key),

    -- Discipline is what someone works on, not what they are allowed to
    -- do. A mechanical and an electrical engineer hold identical system
    -- authority, so this is an attribute rather than a role: keeping
    -- them apart would double the permission matrix without adding a
    -- single real rule.
    discipline  text,
    job_title   text,

    -- Credentials.
    --
    -- scrypt with a per-user random salt. The salt is stored beside the
    -- hash because it is not a secret: its job is to make two people
    -- with the same password hash differently, so a stolen table cannot
    -- be attacked with one precomputed dictionary.
    password_hash  text,
    password_salt  text,
    must_change_password boolean not null default false,
    last_login_at  timestamptz,

    -- Throttling. Counting failures per account and locking briefly
    -- turns an online guessing attack from hours into centuries.
    failed_attempts integer not null default 0,
    locked_until    timestamptz,

    active      boolean not null default true,
    deactivated_at timestamptz,
    created_at  timestamptz not null default now(),
    created_by  uuid references users(id) on delete set null,
    unique (org_id, email)
);

-- Sessions live in the database rather than in a signed token so that
-- access can actually be withdrawn. Deactivating someone at 09:00 must
-- end their session at 09:00, not whenever a token happens to expire,
-- and an auditor may ask who was signed in when a record changed.
create table sessions (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references users(id) on delete cascade,
    created_at   timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at   timestamptz not null,
    revoked_at   timestamptz,
    ip           text,
    user_agent   text
);


-- ============================================================
-- Master data
-- ============================================================

create table parts (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    part_number  text not null,
    description  text not null,
    revision     text not null,
    customer     text,
    created_at   timestamptz not null default now(),
    unique (org_id, part_number)
);

create table lots (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    lot_number   text not null,
    part_id      uuid references parts(id) on delete set null,
    -- Self reference is what makes the genealogy tree possible: a lot
    -- that was split or merged points at the lot it came from.
    parent_lot_id uuid references lots(id) on delete set null,
    heat_number  text,
    qty          integer not null default 0,
    location     text,
    status       text not null default 'released' check (status in (
                    'released', 'on_hold', 'quarantine', 'scrapped', 'shipped'
                 )),
    created_at   timestamptz not null default now(),
    unique (org_id, lot_number)
);

create table vendors (
    id            uuid primary key default gen_random_uuid(),
    org_id        uuid not null references organizations(id) on delete cascade,
    name          text not null,
    scope         text not null,
    cert_type     text,
    cert_expires  date,
    otd_pct       numeric(5,2),
    ppm           integer,
    grade         char(1) check (grade in ('A','B','C','D')),
    status        text not null default 'approved' check (status in (
                     'approved', 'on_watch', 'scar_open', 'onboarding', 'suspended'
                  )),
    created_at    timestamptz not null default now(),
    unique (org_id, name)
);

create table gages (
    id               uuid primary key default gen_random_uuid(),
    org_id           uuid not null references organizations(id) on delete cascade,
    gage_id          text not null,
    description      text not null,
    range_text       text,
    interval_months  integer not null,
    last_cal         date,
    next_due         date,
    created_at       timestamptz not null default now(),
    unique (org_id, gage_id)
);

create table documents (
    id               uuid primary key default gen_random_uuid(),
    org_id           uuid not null references organizations(id) on delete cascade,
    doc_number       text not null,
    title            text not null,
    owner_id         uuid references users(id) on delete set null,
    current_revision text,
    status           text not null default 'draft' check (status in (
                        'draft', 'in_approval', 'released', 'obsolete'
                     )),
    created_at       timestamptz not null default now(),
    unique (org_id, doc_number)
);

create table document_revisions (
    id              uuid primary key default gen_random_uuid(),
    document_id     uuid not null references documents(id) on delete cascade,
    revision        text not null,
    change_summary  text not null,
    author_id       uuid references users(id) on delete set null,
    approved_by     uuid references users(id) on delete set null,
    effective_date  date,
    created_at      timestamptz not null default now(),
    unique (document_id, revision)
);

create table work_orders (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    wo_number   text not null,
    part_id     uuid references parts(id) on delete set null,
    lot_id      uuid references lots(id) on delete set null,
    qty         integer not null,
    current_op  text,
    total_ops   text,
    cell        text,
    status      text not null default 'running' check (status in (
                   'planned', 'running', 'quality_hold', 'mrb_hold', 'complete'
                )),
    created_at  timestamptz not null default now(),
    unique (org_id, wo_number)
);

-- Competence, clause 7.2. Trained against a SPECIFIC revision, which
-- is what lets a new document release open a training gap by itself.
create table training_records (
    id                uuid primary key default gen_random_uuid(),
    org_id            uuid not null references organizations(id) on delete cascade,
    user_id           uuid not null references users(id) on delete cascade,
    document_id       uuid not null references documents(id) on delete cascade,
    revision_trained  text not null,
    trained_on        date not null,
    next_review       date,
    unique (user_id, document_id)
);

-- Which documents each role must be trained on.
--
-- Without this table the word "gap" has no meaning: you cannot be
-- missing training you were never required to have. A gap is then
-- one of two things, and both are computed at read time rather than
-- stored:
--   1. the role requires a document and no training record exists
--   2. a record exists but at a superseded revision
create table document_requirements (
    id           uuid primary key default gen_random_uuid(),
    org_id       uuid not null references organizations(id) on delete cascade,
    role         text not null,
    document_id  uuid not null references documents(id) on delete cascade,
    unique (org_id, role, document_id)
);


-- ============================================================
-- The configurable layer
-- ============================================================

create table record_types (
    id          uuid primary key default gen_random_uuid(),
    org_id      uuid not null references organizations(id) on delete cascade,
    key         text not null,
    name        text not null,
    prefix      text not null,
    clause      text,
    active      boolean not null default true,
    unique (org_id, key)
);

-- The form schema itself. Publishing a new version leaves existing
-- records pointing at the old one, so history stays readable.
create table form_versions (
    id              uuid primary key default gen_random_uuid(),
    record_type_id  uuid not null references record_types(id) on delete cascade,
    version         integer not null,
    schema          jsonb not null,
    published_at    timestamptz,
    published_by    uuid references users(id) on delete set null,
    unique (record_type_id, version)
);

create table workflow_states (
    id              uuid primary key default gen_random_uuid(),
    record_type_id  uuid not null references record_types(id) on delete cascade,
    key             text not null,
    name            text not null,
    position        integer not null,
    is_terminal     boolean not null default false,
    unique (record_type_id, key)
);

create table workflow_transitions (
    id              uuid primary key default gen_random_uuid(),
    record_type_id  uuid not null references record_types(id) on delete cascade,
    from_state      text not null,
    to_state        text not null,
    required_role   text,
    unique (record_type_id, from_state, to_state)
);


-- ============================================================
-- The universal record
-- ============================================================

create table records (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations(id) on delete cascade,
    site_id         uuid references sites(id) on delete set null,
    record_type_id  uuid not null references record_types(id),
    number          text not null,
    title           text not null,
    status          text not null,
    severity        text not null default 'ok' check (severity in ('ok','warn','crit')),
    owner_id        uuid references users(id) on delete set null,

    -- Everything the form defines. Indexed with GIN so queries into
    -- the payload stay fast as it grows.
    data            jsonb not null default '{}'::jsonb,
    form_version    integer not null default 1,

    opened_at       timestamptz not null default now(),
    due_at          timestamptz,
    closed_at       timestamptz,

    created_by      uuid references users(id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (org_id, number)
);

-- The graph. An NCR links to a CAPA links to an 8D links to a
-- complaint. This table is why the demo can trace one problem across
-- five modules.
create table record_links (
    id              uuid primary key default gen_random_uuid(),
    from_record_id  uuid not null references records(id) on delete cascade,
    to_record_id    uuid not null references records(id) on delete cascade,
    link_type       text not null default 'related' check (link_type in (
                       'related', 'caused_by', 'corrects', 'supersedes', 'child_of'
                    )),
    created_at      timestamptz not null default now(),
    check (from_record_id <> to_record_id),
    unique (from_record_id, to_record_id, link_type)
);

create table attachments (
    id           uuid primary key default gen_random_uuid(),
    record_id    uuid not null references records(id) on delete cascade,
    filename     text not null,
    mime_type    text,
    size_bytes   bigint,
    storage_key  text not null,
    uploaded_by  uuid references users(id) on delete set null,
    uploaded_at  timestamptz not null default now()
);

-- Immutable field level history. Nothing in a QMS may be deleted or
-- silently changed. There is deliberately no UPDATE or DELETE path to
-- this table anywhere in the API.
create table audit_log (
    id          bigserial primary key,
    org_id      uuid not null references organizations(id) on delete cascade,
    record_id   uuid references records(id) on delete cascade,
    entity      text not null,
    entity_id   uuid,
    field       text not null,
    old_value   text,
    new_value   text,
    reason      text,
    changed_by  uuid references users(id) on delete set null,
    changed_at  timestamptz not null default now()
);


-- ============================================================
-- Indexes
-- ============================================================

create index idx_records_org_type    on records (org_id, record_type_id);
create index idx_records_status      on records (org_id, status);
create index idx_records_severity    on records (org_id, severity);
create index idx_records_due         on records (due_at) where closed_at is null;
create index idx_records_data_gin    on records using gin (data);

create index idx_links_from          on record_links (from_record_id);
create index idx_links_to            on record_links (to_record_id);

create index idx_audit_record        on audit_log (record_id, changed_at desc);
create index idx_audit_entity        on audit_log (entity, entity_id);

create index idx_lots_parent         on lots (parent_lot_id);
create index idx_lots_part           on lots (part_id);
create index idx_gages_due           on gages (org_id, next_due);
create index idx_training_user       on training_records (user_id);
create index idx_docreq_role         on document_requirements (org_id, role);
create index idx_cert_next_audit     on certifications (org_id, next_audit_on);
create index idx_sessions_user       on sessions (user_id);
create index idx_sessions_live       on sessions (expires_at) where revoked_at is null;
create index idx_docrev_document     on document_revisions (document_id);


-- ============================================================
-- updated_at maintenance
-- ============================================================

create or replace function touch_updated_at() returns trigger as $$
begin
    new.updated_at := now();
    return new;
end;
$$ language plpgsql;

create trigger records_touch
    before update on records
    for each row execute function touch_updated_at();
