# QMS Guardian

A quality management system for small manufacturers - nonconformance,
CAPA, calibration, internal audits, training, document control and more,
built around ISO 9001. Node and Express on the backend, PostgreSQL for
storage, a plain HTML/CSS/JS front end with no framework or build step.

## Where things live

- `server/` - the API, the database schema and migrations, and every
  setup/maintenance script. **This is where you actually run things** -
  there is no `package.json` at this repository root.
- `public/` - the front end: the landing page, sign-in, and the app
  itself. Served by the server in `server/`, not run separately.

## Getting started

See **[`server/README.md`](server/README.md)** for setup (about five
minutes: create a database, copy `.env.example` to `.env`, run one
command to build the schema and load demo data) and the full list of
API endpoints.
