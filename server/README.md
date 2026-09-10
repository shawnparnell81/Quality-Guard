# QMS Guardian API

Node plus PostgreSQL. No ORM, no build step, no framework beyond Express.

Requires **Node 20.6 or later** (the scripts here use `--env-file`,
which does not exist before that) and **PostgreSQL 13 or later**
(`schema.sql` calls `gen_random_uuid()`, built into Postgres core
only from v13 on - an older server needs the `pgcrypto` extension
instead, which nothing here installs for you).

Everything below runs from inside this `server/` folder, not the repo
root. The repository root has a `package.json` of its own, but it holds
only the type checker (`npm run typecheck` - see
[`docs/typechecking.md`](../docs/typechecking.md)) and a `test` script
that delegates back here.

## Setup

Four steps. The whole thing takes about five minutes.

### 1. Create the database

Open pgAdmin 4, right-click **Databases** under your server, choose
**Create > Database**, and name it `qualityguard`. Leave everything else
at the default.

### 2. Configure your connection

Copy `.env.example` to `.env`, then edit `.env` and put in the password
you set when you installed PostgreSQL:

```
cd server
copy .env.example .env
```

`.env` holds your database password, and any SMTP credentials if you
turn email on. It is listed in `.gitignore` and must never be
committed. Every other setting in `.env.example` is optional and
documented in place.

### 3. Create the tables and load the demo data

```
npm install
npm run db:reset
```

`db:reset` runs `db/schema.sql`, then `db/seed.sql`, then `db:migrate`
(every file in `db/migrations/`, because `schema.sql` is only the
baseline the migrations carry forward), then `db:passwords`, which sets
one development password on every seeded account and prints it along
with a few addresses to sign in as. Safe to re-run at any time: the
schema drops every table before recreating it, and if the database
already has tables, `db:reset` takes a backup first, so a mistake is
recoverable with `npm run db:restore`.

If you would rather run the SQL by hand, open `db/schema.sql` in the
pgAdmin query tool, execute it, then do the same with `db/seed.sql` -
then come back here for `npm run db:migrate` and `npm run db:passwords`,
because the code expects the migrations to have run.

### 4. Start the server

```
npm run dev
```

Then open <http://localhost:3001/>. That is the whole app: the server
serves the front end from `public/` and the API from `/api`, so there is
one command, one port, and no CORS to configure. Sign in with one of the
accounts `db:passwords` listed; a seeded account holds a temporary
password, so the first thing it does is send you to
`change-password.html`.

`npm run dev` restarts automatically when a server file changes. Front
end changes just need a browser reload.

## Project layout

```
QualityGuard/
  public/              front end, served at /
    index.html
    login.html         sign-in
    change-password.html
    style.css
    js/
      app.js           router, theme, startup
      api.js           every call to the server
      dom.js           element helpers, tables, pills
      session.js       the signed-in user, and can()
      views/           one module per screen
  server/              API, served at /api
    db/                schema.sql, seed.sql, migrations/
    src/
      app.js           express setup and the middleware chain
      db.js            connection pool
      auth.js          sessions, cookies, CSRF, permissions
      passwords.js     scrypt hashing, strength rules, lockout
      uploads.js       multer, shared by every upload route
      routes/
```

Inside the app itself, the front end calls the server only through
`api.js`, and builds DOM only through `dom.js` helpers. Both rules exist
so that a cross-cutting change - `api.js` attaching the CSRF header to
every write, or a status pill looking different - stays a one-file
change. The standalone sign-in and change-password pages call `fetch`
directly, since they run before the app shell does.

## What the schema does

The split between the two kinds of table is the whole design.

**Master data gets real typed tables.** Parts, lots, vendors, gages,
documents and people have a fixed shape, need foreign keys, and get
queried in structured ways.

**Quality events share one table.** An NCR, a CAPA, an 8D, a complaint,
a SCAR, an audit and a risk are the same object: a numbered record with
a status, an owner, a form payload and links to other records. The
payload lives in a JSONB column, so the Form Builder can add a field
without a database migration.

That is why 23 modules do not need 23 codebases, and it is the answer
when someone asks how a system this broad got built.

Three tables carry most of the weight:

| Table          | Why it matters                                                              |
| -------------- | --------------------------------------------------------------------------- |
| `records`      | Every quality event, whatever the module. GIN-indexed on the JSONB payload. |
| `record_links` | The graph. One problem traced across five modules is this table.            |
| `audit_log`    | Immutable field-level history. No API path updates or deletes it.           |

`record_audit` sits behind those: a full before/after row snapshot of
every `records` write, put there by a database trigger rather than by
the API, so a change made straight through psql is logged too. It is
the one trail with a retention window (`RECORD_AUDIT_RETAIN_DAYS`).

## Endpoints

A sample, not the full list - there are two dozen routers under `/api`.
Every one of them needs a session cookie, the exceptions being
`GET /api/health`, `GET /api/ready` and `POST /api/auth/*`. A mutating
request from a browser also carries the `X-CSRF-Token` header. See
[`docs/auth.md`](../docs/auth.md) for the request pipeline and
[`docs/api-conventions.md`](../docs/api-conventions.md) for where a new
route goes.

### Dashboard

| Method | Path                         | Returns                                              |
| ------ | ---------------------------- | ---------------------------------------------------- |
| GET    | `/api/health`                | Server and database status                           |
| GET    | `/api/dashboard`             | Every KPI on the front page                          |
| GET    | `/api/dashboard/open-events` | Open events feed, severity ordered                   |
| GET    | `/api/dashboard/readiness`   | Per-clause findings, worst first, plus a gap summary |

### Quality events

| Method | Path                                    | Notes                                          |
| ------ | --------------------------------------- | ---------------------------------------------- |
| GET    | `/api/records?type=ncr&open=true`       | Filter by `type`, `status`, `severity`, `open` |
| GET    | `/api/records/NCR-2026-0142`            | Record plus its links and full history         |
| POST   | `/api/records`                          | Validated against the published form schema    |
| PATCH  | `/api/records/NCR-2026-0142`            | Writes an audit row per changed field          |
| POST   | `/api/records/NCR-2026-0142/transition` | Refuses moves the workflow does not define     |

### Master data

| Method | Path                               | Notes                                                      |
| ------ | ---------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/vendors`                     | Ordered worst status first                                 |
| GET    | `/api/gages`                       | Calibration status derived from the due date, never stored |
| GET    | `/api/documents`                   | With revision counts                                       |
| GET    | `/api/documents/WI-0412/revisions` | Full revision history                                      |
| GET    | `/api/parts`                       |                                                            |
| GET    | `/api/lots?on_hold=true`           |                                                            |
| GET    | `/api/lots/L-88213/genealogy`      | Recursive CTE, heat number to shipment                     |
| GET    | `/api/training/gaps`               | Gaps computed at read time, never stored                   |
| GET    | `/api/training/matrix`             | Operator against document revision                         |

## Two endpoints worth reading the SQL for

**`/api/lots/:lot/genealogy`** walks the parent chain up to raw material
and back down through every child lot in one recursive CTE. This is the
query a recall turns on: which customers received parts from this heat
number.

**`/api/training/gaps`** returns nothing from a `gaps` column, because
there isn't one. A gap is the absence of a training record at the
document's current revision, computed when you ask. Release a new
revision in Document Control and the gaps appear on their own. That link
is what auditors probe hardest under clause 7.2.

## Try it

The probes need nothing:

```
curl http://localhost:3001/api/health
curl http://localhost:3001/api/ready
```

Everything else needs a session. Sign in once into a cookie jar and
send it back on each call. Use an account whose password you have
already changed in the browser - a temporary password gets `428` on
every endpoint but `/api/me` and `/api/auth/*`:

```
curl -c qg.txt -X POST http://localhost:3001/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"you@example.com\",\"password\":\"your-password\"}"

curl -b qg.txt http://localhost:3001/api/dashboard
curl -b qg.txt http://localhost:3001/api/records/NCR-2026-0142
curl -b qg.txt http://localhost:3001/api/lots/L-88213/genealogy
curl -b qg.txt http://localhost:3001/api/training/gaps
```

`curl` sends no `Origin` and no `Referer`, so the CSRF check passes it
through and only the session matters. A browser write needs the
`X-CSRF-Token` header as well.

Move a record through its workflow, and watch it refuse an illegal jump.
Who acted is the session's business, not the body's - `to` and an
optional `reason` are all it takes:

```
curl -b qg.txt -X POST http://localhost:3001/api/records/NCR-2026-0142/transition ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"mrb\"}"
```

```
curl -b qg.txt -X POST http://localhost:3001/api/records/NCR-2026-0142/transition ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"closed\"}"
```

The second returns `409 Transition not allowed`. That is the workflow
engine doing its job, not a bug. A legal step your role has no
permission for is a separate answer, `403`, with the permission it
wanted.

## Built since the first draft of this file

Four things this README used to list as absent, and no longer are:

- **Authentication and authorization.** Server-side sessions in the
  `sessions` table - not JWTs - found from an `HttpOnly` `qg_session`
  cookie (`SameSite=Lax`, and `Secure` once `NODE_ENV=production`).
  scrypt hashing with a per-user salt, an account locked for 15 minutes
  after 5 failed attempts, CSRF as a double-submit `qg_csrf` cookie
  matched against an `X-CSRF-Token` header on mutating requests, and
  RBAC through `roles` -> `role_permissions` -> a `request.can(key)`
  helper. A temporary password sets `users.must_change_password`, which
  answers **428** everywhere but `GET /api/me` and `/api/auth/*` and
  sends the client to `change-password.html`. Source of truth:
  `src/auth.js`, `src/routes/auth.js`, `src/passwords.js`, all of it
  written up in [`docs/auth.md`](../docs/auth.md).
- **File uploads.** multer in memory (`src/uploads.js`: 25 MB and one
  file per request, 10 MB for the spreadsheet importers) with
  `src/file-storage.js` behind record attachments, controlled documents,
  engineering drawings, calibration certificates, training evidence and
  the Excel form import. Both an extension allowlist and a magic-byte
  check run, so a renamed executable is refused rather than stored.
- **Electronic signatures.** Saving a `signature` field seals it into
  who signed, when, which form version, and a sha256 of the rest of the
  form. A later edit never re-signs it, and the read recomputes the
  hash, so the detail view and the PDF say either "unchanged since
  signing" or "record edited after signing".
- **Multi-tenant scoping.** The session pins every request to its user's
  `org_id`, and each query filters on it. `roles` is keyed
  `(org_id, key)` rather than by key alone, so two companies can each
  own a `quality_manager` role without either editing what the other
  means by it.

## Not built yet

Still genuinely absent, and you should say so plainly if anyone asks:

- **Row-level security.** Tenant separation is enforced in the queries,
  not by the database: nothing in `db/` enables RLS or defines a policy,
  so a route that forgets its `org_id` filter has no second line of
  defence behind it. `test/tenant-isolation.test.js` is what keeps that
  honest today.
- **The s3 storage driver.** `STORAGE_DRIVER=s3` is a contract, not an
  implementation - both driver methods throw a 500 saying so
  (`src/file-storage.js`). The `local` default writes under
  `server/storage`, which means uploads do not survive a container
  redeploy and a second instance cannot see them.
- **Database TLS.** `src/db.js` builds the pool from the `PG*`
  environment variables and never sets `ssl`. Fine over loopback; a
  managed Postgres that expects an encrypted connection needs that
  added first.
- **Rate limits across instances.** The fixed-window counters live in
  one process's memory (`src/rate-limit.js`), so a second instance
  doubles every cap. The SSE fan-out already went cross-instance over
  Postgres `NOTIFY`; this has not.

None of these block the pitch. All of them block a paying customer.
