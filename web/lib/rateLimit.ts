// HostIt MemWal — rate limiter for the cost-sensitive API edge (the /api/memory/*
// routes, /api/copilot, /api/create-assist, and the sponsor routes).
//
// SERVER-ONLY. Used to bound LLM/relayer cost amplification on the unauthenticated
// edge of those routes (especially /api/memory/analyze, which invokes the
// relayer's LLM).
//
// DESIGN: a per-process fixed-window counter (the local `Map` below) that is now
// ALSO shared-aware via a write-through to a KV store (lib/kvStore.ts, Vercel KV /
// Upstash Redis). The local Map stays the synchronous fast path AND the always-
// available fallback, so `rateLimit()` keeps its synchronous signature and NO
// caller changes. When a KV is configured, every call fires a best-effort async
// increment of a shared windowed counter; once the GLOBAL count crosses the limit,
// the local bucket is "primed" to its limit so the NEXT call on this instance is
// rejected even though the count originated on another instance. This converges a
// burst that fans out across instances to the GLOBAL limit within one window,
// instead of today's effective `limit × instance-count`.
//
// TRADE-OFF (intentional, bounded): each cold instance can let the FIRST request
// of a window through before the KV-primed rejection lands (the increment is async
// and is not awaited on the return path). That is a deliberate relaxation, far
// tighter than the old unbounded per-instance multiplication. FAIL-OPEN: a KV
// outage degrades to the pure per-process behavior (errors are swallowed in
// kvStore.ts) rather than failing requests. A strictly synchronous global decision
// would require making this seam `async` and editing every caller — deliberately
// out of scope. The replay-nonce store that shares this KV lives in lib/memwalAuth.ts.

import "server-only";
import { kvEnabled, kvIncrWindow } from "@/lib/kvStore";

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
 * Best-effort: increment the SHARED (cross-instance) counter for `key` and, if the
 * global count has crossed `limit`, prime the local bucket to its limit so the next
 * call on THIS instance is rejected too. Fire-and-forget — never awaited on the
 * synchronous return path; kvStore swallows its own errors (fail-open).
 */
function primeFromKv(key: string, limit: number, windowMs: number): void {
  void kvIncrWindow(`rl:${key}`, windowMs).then((count) => {
    if (count === null) return; // KV disabled or errored — keep per-process result.
    if (count < limit) return; // still under the global cap.
    const now = Date.now();
    const existing = buckets.get(key);
    // Raise the local count to the limit (do not lower it, and do not extend a
    // still-valid window's resetAt) so subsequent local calls are rejected until
    // the window rolls over.
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: limit, resetAt: now + windowMs });
    } else if (existing.count < limit) {
      existing.count = limit;
    }
  });
}

/**
 * Fixed-window counter. Returns whether `key` is still within `limit` requests
 * per `windowMs`.
 *
 * The local `Map` is the synchronous decision and the always-available fallback;
 * when a KV is configured this ALSO fires a best-effort shared increment that
 * primes the local bucket from the global count (see `primeFromKv` and the module
 * header). The signature is intentionally synchronous so callers stay untouched.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  // Share/learn the global count across instances (best-effort, non-blocking).
  if (kvEnabled()) primeFromKv(key, limit, windowMs);

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
 * Best-effort client IP from forwarded headers. Returns "unknown" when absent so
 * the limiter still applies a shared bucket rather than failing open per-request.
 *
 * Precedence (verified → real-ip → first XFF → "unknown"): prefer a
 * platform-verified header because the raw `x-forwarded-for` first entry is
 * CLIENT-CONTROLLED and can be spoofed to rotate the per-IP bucket. On Vercel the
 * edge sets `x-vercel-forwarded-for` / `x-real-ip` to the true client IP and a
 * client cannot forge them.
 */
export function clientIpFromHeaders(headers: Headers): string {
  // Platform-verified client IP (Vercel sets these; a client cannot forge them
  // because the edge overwrites them). Prefer them over x-forwarded-for.
  const verified =
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (verified) {
    const first = verified.split(",")[0]?.trim();
    if (first) return first;
  }
  // Fallback: x-forwarded-for is CLIENT-CONTROLLED and spoofable — last resort.
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
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
