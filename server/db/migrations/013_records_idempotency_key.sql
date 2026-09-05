-- Lets a record creation be retried safely. An offline-queued
-- submission (shop-floor tablet, connection drops mid-sync) carries a
-- client-generated key with it; if the same key shows up twice - the
-- first attempt actually landed but the confirmation never made it
-- back, so the client retries - the second attempt should hand back
-- the record already created, not raise a duplicate.
--
-- Scoped per org, not globally unique: two different tenants
-- generating the same random key is not a collision worth caring
-- about, and should never be treated as one.
alter table records add column if not exists idempotency_key text;

create unique index if not exists records_org_idempotency_key
    on records (org_id, idempotency_key)
    where idempotency_key is not null;
