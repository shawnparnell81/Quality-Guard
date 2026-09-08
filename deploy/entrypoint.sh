#!/bin/sh
# Container entrypoint: wait for the database, initialise it on first
# boot, apply migrations, then start the server.
set -e

cd /app/server

echo "[entrypoint] waiting for postgres at ${PGHOST}:${PGPORT} ..."
until pg_isready -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" >/dev/null 2>&1; do
    sleep 1
done
echo "[entrypoint] postgres is up"

# A fresh database has no 'organizations' table. Give it the baseline
# schema, the demo seed and the default logins; an existing database
# skips straight to migrations.
EXISTS="$(psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -tAc "select to_regclass('public.organizations')" 2>/dev/null || true)"

if [ -z "${EXISTS}" ]; then
    echo "[entrypoint] fresh database - applying schema, seed and default passwords"
    node scripts/run-sql.js db/schema.sql
    node scripts/run-sql.js db/seed.sql
    node scripts/set-passwords.js
fi

echo "[entrypoint] applying migrations"
node scripts/migrate.js

echo "[entrypoint] starting server"
exec node src/app.js
