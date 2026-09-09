-- ============================================================
-- Record audit trail: store a diff, not a full blob, on UPDATE; and
-- a retention function (audit M11).
--
-- Migration 044 wrote to_jsonb(OLD) and to_jsonb(NEW) in full for
-- every change. Under autosave that is a whole-row copy per
-- keystroke-pause, and reading history means eyeballing two large
-- blobs to find the one field that moved.
--
--  * UPDATE now stores only the top-level columns that actually
--    changed (old IS DISTINCT FROM new), in both old_values and
--    new_values. When `data` itself changed the whole `data` blob is
--    still both sides - the row-level table audit (audit_log, added
--    with the row-keyed table endpoint) is the fine-grained trail
--    for that. INSERT and DELETE keep their full snapshot.
--
--  * record_audit_prune(retain_days) deletes UPDATE rows older than
--    retain_days for records that are closed or gone; INSERT and
--    DELETE rows are always kept, and an open record keeps its whole
--    history. Called on a daily timer (server/src/audit-retention.js,
--    RECORD_AUDIT_RETAIN_DAYS, default 730) and safe to run by hand.
--
-- Partitioning was considered and left out - it rewrites the table
-- for a table this size does not need yet.
-- Idempotent (create or replace).
-- ============================================================

create or replace function log_record_audit() returns trigger
language plpgsql as $$
declare
    v_user    uuid;
    v_old     jsonb;
    v_new     jsonb;
    v_old_d   jsonb := '{}'::jsonb;
    v_new_d   jsonb := '{}'::jsonb;
    k         text;
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

    elsif (tg_op = 'INSERT') then
        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (new.org_id, new.id, new.number,
                (select key from record_types where id = new.record_type_id),
                'INSERT', v_user, null, to_jsonb(new));
        return new;

    else
        v_old := to_jsonb(old);
        v_new := to_jsonb(new);
        for k in select jsonb_object_keys(v_new) loop
            if (v_old -> k) is distinct from (v_new -> k) then
                v_old_d := v_old_d || jsonb_build_object(k, v_old -> k);
                v_new_d := v_new_d || jsonb_build_object(k, v_new -> k);
            end if;
        end loop;

        /* nothing actually changed - no audit row */
        if v_new_d = '{}'::jsonb then
            return new;
        end if;

        insert into record_audit (org_id, record_id, record_number, record_type,
                                  action_type, changed_by, old_values, new_values)
        values (new.org_id, new.id, new.number,
                (select key from record_types where id = new.record_type_id),
                'UPDATE', v_user, v_old_d, v_new_d);
        return new;
    end if;
end;
$$;

create or replace function record_audit_prune(retain_days int default 730)
returns bigint language plpgsql as $$
declare
    n bigint;
begin
    delete from record_audit ra
     where ra.action_type = 'UPDATE'
       and ra.changed_at < now() - make_interval(days => retain_days)
       and not exists (
           select 1 from records r
            where r.id = ra.record_id and r.closed_at is null
       );
    get diagnostics n = row_count;
    return n;
end;
$$;
