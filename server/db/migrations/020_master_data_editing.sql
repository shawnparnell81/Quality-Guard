-- ============================================================
-- Master data was read-only. Gages, vendors, parts and lots could
-- be listed but never created or edited through the app, and a
-- calibration result was three fields (pass/fail, reading, notes)
-- with nowhere to keep the certificate. This migration adds the
-- columns and permissions a real "add a tool" / "edit a tool" /
-- "record a calibration with its certificate" flow needs. The
-- routes and UI come with it; this is only the schema and the
-- authority to use them.
--
-- Idempotent throughout (add column if not exists, on conflict do
-- nothing) so re-running it is safe.
-- ============================================================

-- ---------- gages: a tool is an asset, not just a due date ----------

alter table gages add column if not exists manufacturer   text;
alter table gages add column if not exists model           text;
alter table gages add column if not exists serial_number   text;
alter table gages add column if not exists location        text;
alter table gages add column if not exists cal_supplier    text;

-- A retired gage is neither "available" nor "on hold" - it is out of
-- service for good. Widen the check the same way migration 015 first
-- set it.
alter table gages drop constraint if exists gages_availability_check;
alter table gages add constraint gages_availability_check
    check (availability in ('available', 'hold', 'retired'));

-- ---------- gage_calibrations: the full result, plus the cert ----------
-- performed_at (timestamptz, defaulted) stays as the history sort key.
-- performed_on is the calibration date the technician actually enters,
-- which is not always today.

alter table gage_calibrations add column if not exists performed_on         date;
alter table gage_calibrations add column if not exists cal_supplier         text;
alter table gage_calibrations add column if not exists as_found             text;
alter table gage_calibrations add column if not exists as_left              text;
alter table gage_calibrations add column if not exists standard_used        text;
alter table gage_calibrations add column if not exists certificate_path     text;
alter table gage_calibrations add column if not exists certificate_filename text;

-- ---------- permissions ----------
-- read/create/edit are separate keys everywhere else in the catalog;
-- follow that. gage.retire already exists (seed.sql) with no route
-- behind it - it gets one now, so make sure the managing roles hold it.

insert into permissions (key, resource, action, description, clause) values
    ('gage.create',   'gage',   'create', 'Add a gage to the register',            '7.1.5'),
    ('gage.edit',     'gage',   'edit',   'Edit a gage''s details',                '7.1.5'),
    ('vendor.create', 'vendor', 'create', 'Add a vendor to the approved list',     '8.4'),
    ('vendor.edit',   'vendor', 'edit',   'Edit an approved vendor',               '8.4'),
    ('part.create',   'part',   'create', 'Add a part number',                     '8.5.1'),
    ('part.edit',     'part',   'edit',   'Edit a part number',                    '8.5.1'),
    ('lot.create',    'lot',    'create', 'Create a material lot',                 '8.5.2'),
    ('lot.edit',      'lot',    'edit',   'Edit a material lot',                   '8.5.2')
on conflict (key) do nothing;

-- roles and their grants are per-organization since migration 009, so
-- grant each new key to every org's own copy of the roles that already
-- do this work in practice. general_manager/admin are listed
-- explicitly for the reason migration 012 and 018 both note: "holds
-- every permission" was a one-time snapshot at provisioning and does
-- not retroactively pick up keys invented afterwards.

-- Calibration authority sits with the same roles that already hold
-- gage.calibrate, plus the managers.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, p.key
  from roles r
 cross join (values ('gage.create'), ('gage.edit'), ('gage.retire')) as p(key)
 where r.key in (
     'quality_tech', 'quality_engineer', 'quality_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;

-- Vendor list is maintained by purchasing and quality management.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, p.key
  from roles r
 cross join (values ('vendor.create'), ('vendor.edit')) as p(key)
 where r.key in (
     'purchasing_manager', 'quality_engineer', 'quality_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;

-- Parts and lots are touched by manufacturing/production and quality.
insert into role_permissions (org_id, role_key, permission_key)
select r.org_id, r.key, p.key
  from roles r
 cross join (values ('part.create'), ('part.edit'), ('lot.create'), ('lot.edit')) as p(key)
 where r.key in (
     'manufacturing_engineer', 'production_manager',
     'quality_engineer', 'quality_manager',
     'general_manager', 'admin'
 )
 on conflict do nothing;
