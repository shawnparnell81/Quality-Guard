# QualityGuard API

Node plus PostgreSQL. No ORM, no build step, no framework beyond Express.

Requires **Node 20.6 or later** (the scripts here use `--env-file`,
which does not exist before that) and **PostgreSQL 13 or later**
(`schema.sql` calls `gen_random_uuid()`, built into Postgres core
only from v13 on - an older server needs the `pgcrypto` extension
instead, which nothing here installs for you).

There is no `package.json` at the repository root. Everything below
runs from inside this `server/` folder, not the repo root.

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

`.env` holds database password. It is listed in `.gitignore` and
must never be committed.

### 3. Create the tables and load the demo data

```
npm install
npm run db:reset
```

`db:reset` runs `db/schema.sql` then `db/seed.sql`. Both are safe to
re-run at any time: the schema drops every table before recreating it,
so this always gives a clean database.

If you would rather run the SQL by hand, open `db/schema.sql` in the
pgAdmin query tool, execute it, then do the same with `db/seed.sql`.

### 4. Start the server

```
npm run dev
```

Then open <http://localhost:3001/>. That is the whole app: the server
serves the front end from `public/` and the API from `/api`, so there is
one command, one port, and no CORS to configure.

`npm run dev` restarts automatically when a server file changes. Front
end changes just need a browser reload.

## Project layout

```
QualityGuard/
  public/              front end, served at /
    index.html
    style.css
    js/
      app.js           router, theme, startup
      api.js           every call to the server
      dom.js           element helpers, tables, pills
      views/           one module per screen
  server/              API, served at /api
    db/                schema.sql and seed.sql
    src/
      app.js           express setup
      db.js            connection pool
      routes/
```

The front end never calls `fetch` outside `api.js`, and never builds
DOM outside `dom.js` helpers. Both rules exist so that adding auth
headers later, or changing how a status pill looks, is a one-file
change.

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

## Endpoints

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

```
curl http://localhost:3001/api/health
curl http://localhost:3001/api/dashboard
curl http://localhost:3001/api/records/NCR-2026-0142
curl http://localhost:3001/api/lots/L-88213/genealogy
curl http://localhost:3001/api/training/gaps
```

Move a record through its workflow, and watch it refuse an illegal jump:

```
curl -X POST http://localhost:3001/api/records/NCR-2026-0142/transition ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"mrb\",\"actor\":\"MO\"}"
```

```
curl -X POST http://localhost:3001/api/records/NCR-2026-0142/transition ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"closed\",\"actor\":\"MO\"}"
```

The second returns `409 Transition not allowed`. That is the workflow
engine doing its job, not a bug.

## Not built yet

Deliberately absent, and you should say so plainly if anyone asks:

- **Authentication.** Every request currently acts as the demo
  organization. Real auth is the next thing to add, before this touches
  anything resembling production data.
- **File uploads.** The `attachments` table exists; nothing writes to it.
- **Electronic signatures.** The form schema defines a signature field
  type, but there is no signing implementation behind it.
- **Multi-tenancy enforcement.** Every query filters by `org_id`, so the
  shape is right, but nothing stops a caller asking for another org.
  Row-level security is the proper fix.

None of these block the pitch. All of them block a paying customer.
