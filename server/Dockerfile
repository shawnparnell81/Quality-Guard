# QMS Guardian API + the front end it serves.
#
# Build context is the repo root (see docker-compose.yml), because the
# server resolves the static site at ../../public.

FROM node:22-bookworm-slim

# migrate.js and backup.js shell out to pg_dump / psql, and the
# entrypoint uses pg_isready + psql to wait for and inspect the
# database on first boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

# Dependencies first, against the lockfile, so a code change does not
# reinstall the world. Dev deps (playwright) are left out.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# App code, plus the front end (app.js -> ../../public) and the
# entrypoint.
COPY server/ ./
COPY public/ /app/public/
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3001

# The entrypoint waits for Postgres, seeds an empty database, runs
# migrations, then execs the server.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
