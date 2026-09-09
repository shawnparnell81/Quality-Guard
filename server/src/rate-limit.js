/* ============================================================
   Rate limiting (audit M12).

   Fixed-window counters kept in memory - no dependency, the same
   posture as the hand-rolled cookie parser and the login lockout.
   Single-node: a multi-instance deploy moves these counters to Redis
   (or Postgres), same as the SSE bus and the digest.

   Three layers, wired in app.js:
     - a generous global per-IP limit on all of /api
     - a strict per-IP limit on /api/auth/* (password-spray across
       many accounts from one address; the per-account lockout in
       routes/auth.js is unchanged and complements this)
     - a per-user limit on the endpoints that parse or render a
       document (Excel / PDF / import), which are the cheap DoS

   The per-account login lockout is deliberately left where it is.
   ============================================================ */

const buckets = new Map();   // key -> { count, resetAt }

/* Sweep expired buckets so a long-lived process does not grow without
   bound. Unref'd: it never keeps the event loop alive on its own. */
const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, 60_000);
if (typeof sweep.unref === "function") sweep.unref();

/* The caller's address. x-forwarded-for is honoured (a proxy in front
   passes the real client first in the list); otherwise the socket. */
export function clientIp(request) {
    const fwd = request.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
    return request.socket?.remoteAddress || "unknown";
}

function hit(key, windowMs, max) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { ok: bucket.count <= max, retryAfterMs: bucket.resetAt - now };
}

/* rateLimit({ name, windowMs, max, by })
   `by(request)` returns the counter key suffix (default: the IP).
   `when(request)` optionally skips the check (default: always on). */
export function rateLimit({ name, windowMs, max, by = clientIp, when }) {
    return (request, response, next) => {
        if (when && !when(request)) return next();

        const result = hit(name + ":" + by(request), windowMs, max);
        if (result.ok) return next();

        const retryAfter = Math.ceil(result.retryAfterMs / 1000);
        response.setHeader("Retry-After", String(retryAfter));
        return response.status(429).json({
            error: "Too many requests - slow down and try again in "
                + retryAfter + "s",
            code: "rate_limited"
        });
    };
}

/* Test-only: wipe every counter between cases. */
export function _resetRateLimits() {
    buckets.clear();
}
