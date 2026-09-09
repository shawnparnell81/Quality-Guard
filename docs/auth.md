# Authentication & authorization

How QMS Guardian decides **who you are** and **what you may do**. The
two jobs are deliberately separate:

- **Identity** — a server-side session, found from an httpOnly cookie.
- **Authority** — `role_permissions` in the database, per organization.

There are no JWTs or bearer tokens. Sessions are stored server-side so
access can genuinely be withdrawn: deactivating someone at 09:00 ends
their session at 09:00, not whenever a token would have expired.

Source of truth: `server/src/auth.js` (middleware + cookies + the
permission maps), `server/src/routes/auth.js` (login / logout /
change-password), `server/src/passwords.js` (hashing), and the request
pipeline in `server/src/app.js`.

---

## 1. Identity

### The session

`POST /api/auth/login { email, password, remember }`:

1. Look up the user by email. A wrong password, an unknown email, and
   an inactive account all return the **same** 401 message
   (`"Email or password is not correct"`) so the endpoint can't be
   used to enumerate staff.
2. On success: insert a row into `sessions`
   (`id` uuid, `user_id`, `created_at`, `last_seen_at`, `expires_at`,
   `revoked_at`, `ip`, `user_agent`) and set the cookie.

A session is only good if it **exists**, is **not expired**, is **not
revoked**, and belongs to a user who is still **active**. Any one of
those failing means no user. `identify` also bumps `last_seen_at` on
every authenticated request (best-effort; a failure never blocks the
request).

| Setting | Value |
|---|---|
| Cookie name | `qg_session` |
| Flags | `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age = SESSION_HOURS` |
| `Secure` | added **only** when `NODE_ENV=production` (so the cookie still works over plain http in dev) |
| Lifetime | **12 hours** (`SESSION_HOURS` in `auth.js`) |

### "Remember me"

`REMEMBER_ME_HOURS` (30 days) is honoured **only outside production**.
On a real deployment the flag is ignored and everyone gets the 12-hour
session — a long-lived session is a liability, and this stays off until
it's built properly. The startup banner in `app.js` says so out loud.

### Session lifecycle

| Event | Effect |
|---|---|
| `POST /api/auth/logout` | sets `revoked_at` on the current session |
| `POST /api/auth/change-password` | revokes **every other** live session for that user (if the reason for the change is that someone else knew the password, leaving their session alive defeats the point) |
| user deactivated | `identify` stops resolving a user for their sessions on the next request |
| `GET /api/auth/sessions` | lists a user's own live sessions (id, created, last seen, expires, ip, user agent) |

### Forced password change

A brand-new account or a reset gets a **temporary password**, spoken or
handed over, plus `users.must_change_password = true`. While that flag
is set, `requirePasswordCurrent` middleware returns **428 Precondition
Required** (`code: "password_change_required"`) for everything except
`GET /api/me` and `/api/auth/*` — a temporary password is a handover,
not a credential, so an account holding one can do nothing but replace
it. The SPA bounces such a session to `change-password.html`.

---

## 2. Passwords

`server/src/passwords.js`:

- **scrypt** from Node's own `crypto` — no dependency. Per-password
  random salt; verification uses `timingSafeEqual`. Stored as
  `users.password_hash` + `users.password_salt`.
- **Strength**: at least **12 characters**; a single repeated character
  is rejected. No character-class rules — length carries far more real
  strength than rules that push people toward `Password1!` on a sticky
  note.
- **Temporary passwords** use a "speakable" alphabet
  (`ABCDEFGHJKMNPQRTUVWXYZ2346789` — no O/0, I/l/1, S/5), grouped in
  fours, from `randomBytes` (never `Math.random`).

### Per-account lockout

Tracked on `users.failed_attempts` / `users.locked_until`:

- **5** failed attempts (`MAX_ATTEMPTS`) → the account is locked for
  **15 minutes** (`LOCK_MINUTES`).
- A successful login resets the counter and clears the lock.

This is per **account**. Password-spray — one password tried across
many accounts — is slowed by the per-IP auth rate limit instead
(§5).

---

## 3. CSRF

Added as audit fix C3. `requireCsrf` runs on **authenticated,
state-changing** requests (`POST` / `PUT` / `PATCH` / `DELETE` under
`/api`, after `requireAuth`). `/api/auth/*` is exempt — those carry
their own credential in the body and a caller may not hold a token
yet.

A forged cross-site write never even reaches this check: the
`SameSite=Lax` session cookie is **not sent on a cross-site POST**, so
`requireAuth` 401s first. `requireCsrf` is the belt to that brace, and
the thing that still holds if a future route is a mutating GET.

For a request that **looks like a browser** (an `Origin` or `Referer`
header is present), both must hold:

1. The `Origin` / `Referer` host equals this host (or `X-Forwarded-Host`
   behind a proxy).
2. **Double-submit token**: the `qg_csrf` cookie value equals the
   `X-CSRF-Token` request header.

| | `qg_csrf` |
|---|---|
| Flags | `SameSite=Lax`, `Path=/`, `Max-Age = SESSION_HOURS`; `Secure` in production. **Not** `HttpOnly` — the SPA has to read it. |
| Issued by | `identify`, on the first authenticated **GET** that lacks it. The SPA's first call is `GET /api/me`, so the token is always in place before its first write. |
| Sent by | `public/js/api.js` — `withCsrf()` attaches `X-CSRF-Token` to every non-GET (`request()` and `postForm()`). |
| Cleared | alongside `qg_session` on logout. |

A caller with **no `Origin` and no `Referer`** is not a browser
navigation — a CSRF attack rides a browser — so a script, an
integration, `curl`, or a test harness passes `requireCsrf` and is
gated by `requireAuth` alone.

---

## 4. The request pipeline

Order matters; this is the middleware chain in `app.js`:

```
express.json (1 MB limit)
  → security headers        enforced CSP, X-Content-Type-Options: nosniff,
                            X-Frame-Options: DENY, Referrer-Policy: same-origin,
                            HSTS (production only)
  → static files            /public only; no-store on the app's own js/css/html
  → request id + logging     X-Request-Id in and out; one structured line per request
  → GLOBAL per-IP rate limit  (§5)
  → identify                attaches request.user, request.permissions, request.can();
                            leaves them null/empty when unauthenticated
  → requestContext.run      carries request.user.id into DB transactions so the
                            record_audit trigger can attribute the change
  → /api/auth  (per-IP rate limit, then the auth router)   ← reachable without a session
  → requireAuth             401 past this line without a session
  → GET /api/me             reachable during a forced password change
  → requirePasswordCurrent  428 while must_change_password is set
  → requireCsrf             (§3)
  → per-user heavy-endpoint rate limit  (§5)
  → GET /api/stream (SSE) → feature routers → 404 → single error handler
```

Guarding "everything needs a session" in **one** place
(`app.use("/api", requireAuth)`) means a new route can't be left
unprotected by accident.

Endpoints reachable **without** a session: `GET /`, `GET /app`,
`GET /api/health`, `GET /api/ready`, and `POST /api/auth/login` /
`change-password` / `logout`. Everything else needs one.

---

## 5. Rate limiting

Added as audit fix M12. In-memory fixed-window counters
(`server/src/rate-limit.js`), no dependency. Every cap is env-tunable;
`RATE_LIMIT_OFF=1` disables the lot.

| Layer | Scope | Default | Env |
|---|---|---|---|
| Global | per IP, all `/api` | 600 / min | `RATE_LIMIT_GLOBAL_PER_MIN` |
| Auth | per IP, `/api/auth/*` | 60 / 15 min | `RATE_LIMIT_AUTH_PER_15MIN` |
| Heavy | per user, document endpoints (`pdf` / `excel` / `xlsx` / `import`) | 120 / min | `RATE_LIMIT_HEAVY_PER_MIN` |

Over the cap → **429** with `Retry-After` and `{ code: "rate_limited" }`.
The per-account login lockout (§2) is separate and complements the auth
layer. Single-node counters; a multi-instance deploy moves them to
Redis, the same as the SSE bus.

---

## 6. Authorization — RBAC, per organization

### The model

| Table | Holds |
|---|---|
| `roles` | one row per role per org (`operator`, `quality_engineer`, `quality_manager`, `production_manager`, `general_manager`, `admin`, …) |
| `permissions` | the catalogue: `resource.action` keys such as `ncr.read`, `ncr.close`, `capa.create`, `wo.log`, `forms.manage`, `production.hold`, `roles.manage`, `user.reset_password` |
| `role_permissions` | the grant matrix, **keyed by `org_id`** — every tenant owns its own, editable in **Roles & Permissions** |

A user has exactly one `role` (`users.role`). `identify` loads that
role's grants for that org into `request.permissions` (a `Set`) and
exposes `request.can(key)`.

Notable role shapes:

- **`general_manager`** holds every permission (computed at provisioning
  from the catalogue, not a hand-typed list).
- **`admin`** gets every `*.read` plus `user` / `roles` — it manages
  people and access and deliberately holds **no quality authority**.
  Separation of duties: whoever administers the system cannot also
  disposition parts.
- Read and write are separate permissions throughout — that split is
  what lets a drawing be engineering-only while everyone can see the
  nonconformance that references it.

### Enforcement

Routes gate with `requirePermission`, which takes a key **or** a
function that derives the key from the request:

```js
records.post("/",                requirePermission(createPermissionFor), …)  // <type>.create
records.post("/:number/close",   requirePermission(req => closePermissionFor(req.body.type)), …)
records.get("/:number",          requirePermission(req => readPermissionFor(type)), …)          // <type>.read
production.post("/work-orders",   requirePermission("wo.log"), …)
```

The per-type maps live in `auth.js`: `CREATE_PERMISSION`,
`CLOSE_PERMISSION`, `READ_PERMISSION`. A record type with **no**
`.read` permission defined stays readable by any signed-in user in the
org (the behaviour before read-gating existed); the ones that define
one are enforced. A denied request returns **403** with
`{ required, your_role }`.

### The client side is honesty only

`public/js/session.js` `can(...)` / `applyPermissions()` disable and
explain `[data-requires]` controls for a role that lacks the
permission. This keeps the UI honest — it is **never** a security
boundary. Every permission is enforced on the server, and the server
is the one that counts.

---

## 7. Audit trail

- **Auth events** are written to `audit_log` with `entity = 'auth'`:
  `login`, `login_failed` (with the attempt number), `login_denied`
  (inactive account), `logout`, `password_changed`. An audit write can
  never block a sign-in — the insert is best-effort.
- **Every DB write** carries the acting user via
  `set_config('app.user_id', <uid>, true)` inside its transaction
  (`withTransaction` in `db.js`, fed by `requestContext`). The
  `record_audit` trigger reads it, so record history is attributed even
  for a change made straight through the database — where `changed_by`
  is `null`, which is exactly the out-of-band case that trail exists to
  catch.

---

## 8. Multi-tenant scoping

Auth is org-aware end to end. `users.org_id`, `roles.org_id`,
`role_permissions.org_id`, and the session's user pin every request to
one organization; the session-user join in `resolveUser` is pinned to
`user.org_id` so two companies can each have their own
`quality_manager` role without colliding. Every data query is
`where org_id = $1`.
