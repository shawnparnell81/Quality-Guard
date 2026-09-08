# Deploying QMS Guardian

One command brings up the whole stack: PostgreSQL, the API (which also
serves the web app), and Caddy for automatic HTTPS.

```
app  ──►  Caddy :443  ──►  app :3001  ──►  db :5432
```

## Requirements

- A Linux host with **Docker** and the **Docker Compose plugin**
  (`docker compose version` should work).
- For real HTTPS: a domain name with an `A`/`AAAA` record pointing at
  the host, and ports **80** and **443** open. Without a domain it
  still runs on `localhost` with a self-signed certificate.

## First run

```sh
git clone <this repo> qms-guardian
cd qms-guardian

cp deploy.env.example .env
# edit .env: set POSTGRES_PASSWORD, and DOMAIN + TLS_EMAIL if you have
# a domain

docker compose up -d
```

On first boot the app container creates the schema, loads the demo
organisation ("Ridgeline Precision"), sets the default passwords and
runs every migration. Follow along with:

```sh
docker compose logs -f app
```

When it settles, open `https://<your-domain>` (or `https://localhost`).

### Default logins

The demo seed ships a full set of users, all with the same
development password and all flagged to change it on first sign-in:

| Role            | Email                        |
|-----------------|------------------------------|
| General Manager | `r.sandoval@ridgeline.example` |
| Administrator   | `i.brannigan@ridgeline.example` |
| Quality Manager | `s.parnell@ridgeline.example` |

Password for every account: **`RidgelinePrecision2026`**. You are
forced to set a real one on first sign-in. Do that for the accounts
you keep, and disable the rest (Administration → People). These
credentials are public knowledge.

To run a clean instance with no demo data, replace `server/db/seed.sql`
with just your own `organizations` row before the first
`docker compose up`, or delete the demo org once you are in.

## Day to day

| Task | Command |
|------|---------|
| Update to a new version | `git pull && docker compose up -d --build` |
| Back up (database + files) | `docker compose exec app npm run db:backup` |
| List backups | `docker compose exec app npm run db:restore -- --list` |
| Restore | `docker compose exec app npm run db:restore -- <bundle-name>` |
| Apply new migrations only | `docker compose exec app node scripts/migrate.js` |
| Tail structured logs | `docker compose logs -f app` |
| Stop | `docker compose down` (add `-v` to also wipe data) |

Backups are written to `./backups/` on the host (a bind mount), so
they survive `docker compose down` and are easy to copy off the box.
Uploaded files live in the `storage` volume and likewise persist
across rebuilds. `docker compose down -v` deletes **everything** -
database, files, TLS certificates.

Health checks:

- `GET /api/health` — process up + database reachable (200 / 503)
- `GET /api/ready` — readiness probe for an orchestrator

## Configuration

Everything is in `.env` (see `deploy.env.example` for the annotated
list): the database password, the domain and ACME email, optional
SMTP for email notifications, the digest hour, and the log level.
Change a value and `docker compose up -d` to apply it.

## Notes

- `NODE_ENV=production` is set for the app container: the session
  cookie gets the `Secure` flag (so it only works over the HTTPS
  Caddy provides) and 5xx responses stop echoing the underlying error.
- The app container includes `postgresql-client`, so `pg_dump` /
  `psql` back the backup, restore and migrate commands from inside
  the container.
- Single node. Multiple app replicas would need the SSE bus and the
  notification-presence registry moved to a shared store (Redis or
  Postgres `LISTEN`/`NOTIFY`) - the code is structured so that is the
  only change.
