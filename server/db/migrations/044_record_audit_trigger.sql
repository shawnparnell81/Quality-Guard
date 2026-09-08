-- ============================================================
-- Database-level audit trail for the records table.
--
-- NCRs and every other record type share the records table, so this
-- covers all of them. It complements audit_log, which the API writes
-- field-by-field: this one is a full before/after row snapshot
-- written by the database itself, so a change made outside the app -
-- a psql session, a bad migration - is logged too, and there is no
-- application code path that can skip it.
--
-- changed_by is read from a per-transaction setting the app sets in
-- server/src/db.js (set_config('app.user_id', ...)). It is null for a
-- change made straight through the database with no app session -
-- which is exactly the case this trigger exists to catch.
--
-- No foreign keys on the payload columns on purpose: the trail has to
-- outlive the rows it describes. If org_id referenced organizations
-- with ON DELETE CASCADE (as audit_log does), deleting an org would
-- cascade into records, fire this trigger, and the trigger's own
-- INSERT would then violate the FK against the half-deleted org.
-- ============================================================

create table record_audit (
    id            bigserial primary key,
    org_id        uuid,                           -- organizations.id; no FK - see above
    record_id     uuid not null,                  -- records.id; no FK so a DELETE is still logged
    record_number text,
    record_type   text,                           -- record_types.key ('ncr', 'capa', ...)
    action_type   text not null check (action_type in ('INSERT', 'UPDATE', 'DELETE')),
    changed_by    uuid,                           -- users.id, or null for an out-of-band change
    changed_at    timestamptz not null default now(),
    old_values    jsonb,
    new_values    jsonb
);

create index idx_record_audit_row on record_audit (record_id, changed_at desc);
create index idx_record_audit_org on record_audit (org_id, changed_at desc);

create or replace function log_record_audit() returns trigger
language plpgsql as $$
declare
    v_user uuid;
begin
    begin
        v_user := nullif(current_setting('app.user_id', true), '')::uuid;
    exception when others then
        v_user := null;
    end;

    if (tg_op = 'DELETE') then
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (old.org_id, old.id, old.number,
                (select key from record_types where id = old.record_type_id),
                'DELETE', v_user, to_jsonb(old), null);
        return old;
    else
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (new.org_id, new.id, new.number,
                (select key from record_types where id = new.record_type_id),
                tg_op, v_user,
                case when tg_op = 'UPDATE' then to_jsonb(old) end,
                to_jsonb(new));
        return new;
    end if;
end;
$$;

create trigger trg_record_audit
    after insert or update or delete on records
    for each row execute function log_record_audit();
