# Migrations

Every schema change from here on goes in this folder, not into
`schema.sql`. Numbered, applied once, recorded in `schema_migrations`.

    npm run db:migrate

`schema.sql` stays as the baseline for building a database from
nothing. Once you have data you care about, you never run it again.

Naming: `002_add_attachments.sql`, `003_...` -- zero padded so the
files sort in the order they run.

Each file runs inside one transaction, so a failure leaves the schema
untouched rather than half changed.

## Append-only

`db:migrate` records a SHA-256 of every file it applies. On the next
run it re-checks the ones already applied: if a file changed on disk
since, the run stops before doing anything. A migration that has run
somewhere is history — fix a mistake with a new migration, never by
editing the old one. (Rows recorded before checksums existed are
backfilled on the next run, not flagged.)

## Drift check

`db/schema.snapshot.sql` is a committed `pg_dump --schema-only` of a
database built the canonical way: `schema.sql`, then `seed.sql`, then
every migration in order.

    npm run db:schema-check              # fails if it drifted
    npm run db:schema-check -- --write   # regenerate it

CI runs the check on every PR. When you add a migration, run
`--write` and commit the updated snapshot alongside it — the diff is
the review's summary of what your migration changes.
