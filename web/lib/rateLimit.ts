// HostIt MemWal — minimal in-memory rate limiter for the /api/memory/* routes.
//
// SERVER-ONLY. Used to bound LLM/relayer cost amplification on the unauthenticated
// edge of the memory routes (especially /api/memory/analyze, which invokes the
// relayer's LLM).
//
// SCOPE / KNOWN LIMITATION: this is a per-process fixed-window counter. It is good
// enough for a single instance but is NOT robust across a multi-instance / serverless
// deployment (each lambda/worker has its own memory), and it cannot enforce a
// replay-nonce store for the auth challenge. Robust limiting AND replay protection
// both need a shared KV store (Vercel KV / Upstash Redis) — the SAME store ISSUES.md
// #17 calls for — so they should be implemented together. The `rateLimit(key)`
// function below is the clean seam: swap its body for a KV-backed sliding window
// (and add a nonce check in memwalAuth) when #17 lands; callers do not change.

import "server-only";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (for a Retry-After hint). */
  retryAfterSec: number;
  limit: number;
  remaining: number;
}

interface Bucket {
  count: number;
  /** Epoch ms when the current window ends. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodically evict stale buckets so the Map cannot grow unbounded. Best-effort;
// runs lazily on access.
function sweep(now: number): void {
  if (buckets.size < 1024) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * Fixed-window counter. Returns whether `key` is still within `limit` requests
 * per `windowMs`. KV-swap seam — see the module header.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0, limit, remaining: limit - 1 };
  }
  if (existing.count >= limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      limit,
      remaining: 0,
    };
  }
  existing.count += 1;
  return {
    ok: true,
    retryAfterSec: 0,
    limit,
    remaining: limit - existing.count,
  };
}

/**
 * Best-effort client IP from standard forwarded headers (Vercel / proxies set
 * `x-forwarded-for`; `x-real-ip` as a fallback). Returns "unknown" when absent so
 * the limiter still applies a shared bucket rather than failing open per-request.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // First entry is the originating client; the rest are proxies.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}

/**
 * Apply BOTH a per-identity (verified address) and per-IP limit for a route.
 * Returns the first failing result, or an ok result. The tightest budget should
 * be given to the costliest route (analyze → LLM).
 */
export function rateLimitMemory(
  route: string,
  identity: string,
  ip: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const idResult = rateLimit(
    `mem:${route}:id:${identity}`,
    opts.limit,
    opts.windowMs,
  );
  if (!idResult.ok) return idResult;
  return rateLimit(`mem:${route}:ip:${ip}`, opts.limit, opts.windowMs);
}
