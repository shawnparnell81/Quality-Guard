# API route conventions

_Audit finding L6. Where does a new endpoint go?_

Every HTTP route lives under `/api`. Within that, a route is either
**feature** or **cross-cutting**, and that decides how its router is
mounted in `server/src/app.js`.

## Feature routers — mounted at `/api/<feature>`

A router that owns one area of the product mounts under its own prefix
and names its paths relative to it:

```js
app.use("/api/records", records);      // records.js: .get("/:number"), .patch("/:number"), ...
app.use("/api/dashboard", dashboard);  // dashboard.js: .get("/"), .get("/readiness"), ...
```

Add a new feature router the same way: give it a prefix that matches the
noun it serves, and keep the `.get`/`.post` paths inside it relative
(`.post("/schedules")`, not `.post("/lpa/schedules")`).

## Cross-cutting routers — mounted at bare `/api`

A router whose routes span several features, or that is plumbing rather
than a feature, mounts at `/api` and each route spells out its own full
path:

```js
app.use("/api", metrics);        // /api/metrics  — counts across NCRs, CAPAs, documents
app.use("/api", notifications);  // /api/notifications*
app.use("/api", layout);         // /api/layout/*
```

Several existing routers (`access`, `production`, `change`, `logs`, …)
mount this way because they carry more than one top-level noun
(`/api/work-orders` **and** `/api/receipts`, say). That is fine; the
paths inside them are still fully spelled out.

## Bare endpoints defined directly in `app.js`

The few endpoints that are neither a feature nor a router are declared
inline in `app.js`, before the router mounts:

| Path | Purpose |
|---|---|
| `GET /` , `GET /app` | serve the landing page and the SPA shell |
| `GET /api/health`, `GET /api/ready` | liveness / readiness probes (no auth) |
| `POST /api/auth/*` | sign-in, change-password, logout (the only routes reachable without a session) |
| `GET /api/me` | the signed-in user; reachable during a forced password change |
| `GET /api/stream` | the SSE change feed (a long-lived handler, not a router) |

## Middleware order (for reference)

`express.json` → security headers → static files → request-id/logging →
`identify` (attaches `request.user` / `request.can`) → `/api/auth` →
`requireAuth` → `/api/me` → `requirePasswordCurrent` → `requireCsrf` →
`/api/stream` → the router mounts above → 404 → the single error handler.
