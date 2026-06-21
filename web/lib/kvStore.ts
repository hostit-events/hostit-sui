// HostIt — shared key-value store (Vercel KV / Upstash Redis over REST).
//
// SERVER-ONLY. This module reads a REST token (a secret), so it must never be
// bundled for the client — the `server-only` import below makes Next.js fail the
// build if it is. It backs TWO cost/abuse gates that both need state shared across
// serverless instances:
//   1. the cross-instance rate limiter (lib/rateLimit.ts), and
//   2. the one-time replay-nonce for the memory auth challenge (lib/memwalAuth.ts).
//
// GRACEFUL FALLBACK: when the env vars are absent (local dev, or a deploy that has
// not provisioned a store yet) `kvEnabled()` returns false and BOTH callers fall
// back to per-process in-memory state — fine for a single instance, but the
// cross-instance guarantee is inert until the store is configured. This mirrors how
// the MemWal layer "gracefully disables" so the app builds + runs without secrets.
//
// FAIL-OPEN: every helper here swallows KV/network errors (logging once) and
// returns a benign value, so a Redis outage degrades to per-process behavior
// rather than 500-ing the routes it guards.

import "server-only";
import { Redis } from "@upstash/redis";

// KV env vars are server-only secrets — read via process.env here, NEVER export
// them from lib/config.ts and NEVER NEXT_PUBLIC_-prefix them (see
// .env.local.example). Provider-agnostic, checked in priority order so a Vercel
// Marketplace integration auto-wires with NO manual aliasing:
//   1. RATE_LIMIT_KV_REST_URL/TOKEN — explicit override (custom name)
//   2. KV_REST_API_URL/TOKEN        — Vercel KV / Vercel-Marketplace Upstash
//   3. UPSTASH_REDIS_REST_URL/TOKEN — Upstash native integration
// Use the WRITE token (we SET/INCR), never KV_REST_API_READ_ONLY_TOKEN.
const url =
  process.env.RATE_LIMIT_KV_REST_URL ??
  process.env.KV_REST_API_URL ??
  process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.RATE_LIMIT_KV_REST_TOKEN ??
  process.env.KV_REST_API_TOKEN ??
  process.env.UPSTASH_REDIS_REST_TOKEN;

/** True when a real shared KV is configured; false → per-process fallback. */
export function kvEnabled(): boolean {
  return Boolean(url && token);
}

let client: Redis | null = null;

/** The shared Redis client, or null when no store is configured. Memoized. */
export function getKv(): Redis | null {
  if (!kvEnabled()) return null;
  if (!client) client = new Redis({ url: url!, token: token! });
  return client;
}

// Log a KV error at most once per process to avoid flooding logs during an outage.
let warned = false;
function warnOnce(context: string, err: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(`[kvStore] ${context} (further KV errors suppressed):`, err);
}

/**
 * Best-effort fixed-window increment, shared across instances. Returns the new
 * count for `key` in the current window (the window is created with `windowMs`
 * TTL on first hit), or `null` when the store is disabled or errored.
 *
 * Used by the rate limiter to learn the GLOBAL count so it can prime the local
 * bucket. Fail-open: any error returns null and the caller keeps its per-process
 * decision.
 */
export async function kvIncrWindow(
  key: string,
  windowMs: number,
): Promise<number | null> {
  const kv = getKv();
  if (!kv) return null;
  try {
    const count = await kv.incr(key);
    // Set the TTL only when we just created the key (count === 1); re-setting it
    // on every hit would turn a fixed window into a sliding one and never expire.
    if (count === 1) {
      await kv.pexpire(key, windowMs);
    }
    return count;
  } catch (err) {
    warnOnce(`kvIncrWindow(${key})`, err);
    return null;
  }
}

/**
 * Atomic "claim this key once" with a TTL — the primitive behind the one-time
 * replay nonce. Returns true when the caller may PROCEED, false when it must be
 * rejected as a replay:
 *   - true  → the key was free and is now claimed for `ttlMs` (first use),
 *   - true  → a KV error occurred (FAIL-OPEN: never reject a legitimate request
 *             because of a Redis outage; the per-process fallback still applies),
 *   - false → the key already existed within its TTL (a replay).
 *
 * The nonce caller in memwalAuth.ts only consults this when `kvEnabled()` is true
 * and otherwise uses its own in-memory fallback.
 */
export async function kvClaimOnce(key: string, ttlMs: number): Promise<boolean> {
  const kv = getKv();
  if (!kv) return false;
  try {
    // SET key value NX PX ttl → "OK" when set (free), null when it already exists.
    const res = await kv.set(key, "1", { nx: true, px: ttlMs });
    return res === "OK";
  } catch (err) {
    warnOnce(`kvClaimOnce(${key})`, err);
    // Fail-open: return true ("proceed") so a KV outage cannot reject a legitimate
    // request; the per-process nonce fallback in memwalAuth.ts still applies.
    return true;
  }
}
