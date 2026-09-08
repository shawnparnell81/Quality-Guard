# Backup & restore

QMS Guardian keeps two things you cannot regenerate: the PostgreSQL
database and the uploaded files under `server/storage/` (attachments,
controlled-document revisions, training evidence, drawings, receipt
photos, form imports). A backup captures both, in one folder, so a
restore is one operation.

## Taking a backup

```
cd server
npm run db:backup                 # full bundle: database + files
npm run db:backup -- nightly      # give it a label (default "manual")
```

Each run writes one timestamped folder under `server/backups/`:

```
qualityguard-2026-09-08T16-05-55-nightly/
  db.sql          pg_dump --clean --if-exists (schema + data + sequences)
  storage/        a copy of server/storage/
  manifest.json   { bundle_version, created_at, label, database,
                    db_bytes, storage_included, storage_bytes }
```

`server/backups/` is git-ignored. Copy the bundles you care about
off the machine — a backup that lives only on the server it backs up
is not a backup.

### Retention

Running `npm run db:backup` from the command line prunes
`server/backups/` to the newest **`BACKUP_KEEP`** bundles (default
14). The most recent bundle is never deleted. The safety bundles
that `db:migrate` and `db:restore` take are subject to the same
prune the next time you run `db:backup`.

Set it in `server/.env`:

```
BACKUP_KEEP=30
```

### What runs automatically

`npm run db:migrate` takes a **database-only** safety bundle
(`-pre-migrate`) before applying anything — schema migrations never
touch stored files, so the dump alone is enough to roll back.

## Restoring

```
cd server
npm run db:restore                       # the most recent bundle
npm run db:restore -- <folder name>      # a specific one
npm run db:restore -- --list             # show what's available
```

The restore:

1. Takes a **full** safety bundle of the current state first
   (`-pre-restore`), so restoring the wrong one is itself
   recoverable.
2. Replays `db.sql` with `psql --set=ON_ERROR_STOP=on` (the
   `--clean --if-exists` in the dump drops and recreates every
   object).
3. If the bundle carries `storage/`, moves the current
   `server/storage/` aside to `server/storage.replaced-<timestamp>/`
   (kept, not deleted) and copies the bundle's files into its place.

A bare `.sql` file from before bundles still restores — the database
only, with no file swap.

> Restart the app after a restore so it picks up the restored rows.

## Disaster recovery, from scratch

On a fresh machine:

```
# 1. Postgres running, an empty database created, server/.env pointed at it
cd server
npm ci

# 2. build the schema and apply every migration
npm run db:schema
npm run db:migrate

# 3. drop in the bundle and restore over the top
mkdir -p backups && cp -r /path/to/qualityguard-...-nightly backups/
npm run db:restore -- qualityguard-...-nightly

# 4. start
npm start
```

Steps 2's `db:schema`/`db:migrate` are optional when the bundle's
`db.sql` is self-contained (it is — `pg_dump` captures the whole
schema); they just give you a working database to take the
`-pre-restore` safety bundle against.
