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
