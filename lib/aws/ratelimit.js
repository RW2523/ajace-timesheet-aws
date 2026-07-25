// In-memory fixed-window rate limiter.
//
// Deliberately in-process: this deployment is a single pm2 process on one box,
// so a shared store (Redis/DynamoDB) would add a dependency for no benefit.
// Counters reset on restart — acceptable for slowing brute force, and the
// lockout window is short enough that a restart-loop attack gains little.
// If this ever scales to multiple app instances, swap the Map for a shared store.

const buckets = new Map(); // key -> { count, resetAt }

/**
 * @returns {{ok: boolean, retryAfter: number, remaining: number}}
 */
export function rateLimit(key, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000), remaining: 0 };
  }
  return { ok: true, retryAfter: 0, remaining: limit - b.count };
}

// Successful auth clears the counter so a legitimate user isn't punished for
// earlier typos.
export function rateLimitReset(key) {
  buckets.delete(key);
}

// Caddy sits in front, so the socket address is always 127.0.0.1 — trust
// X-Forwarded-For's first hop, which Caddy sets.
export function clientIp(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

// Opportunistic cleanup so the Map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
}, 10 * 60 * 1000).unref?.();
