import { describe, it, expect, vi } from "vitest";

// rateLimit imports "server-only" (throws if bundled for the client) — neutralize
// it so the module loads under vitest. Same precedent as memwalAuth.test.ts.
vi.mock("server-only", () => ({}));

import { rateLimit } from "../rateLimit";

// These pin the per-IP limiter keying + window behavior that the gasless sponsor
// routes (app/api/sponsor/route.ts and app/api/sponsor/execute/route.ts) depend
// on. The routes themselves have no HTTP test harness in this repo; this asserts
// the pure `rateLimit` contract they build on.
//
// NOTE: `rateLimit`'s bucket store is process-global module state, so every test
// here uses a UNIQUE key (random suffix) to avoid cross-test / cross-module
// counter collisions.
function uniq(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

describe("sponsor route rate-limit guards", () => {
  it("allows up to the limit per key, then blocks with a Retry-After hint", () => {
    const key = uniq("sponsor:ip:test");
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    expect(rateLimit(key, 2, 60_000).ok).toBe(true);
    const third = rateLimit(key, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(third.remaining).toBe(0);
  });

  it("isolates budgets across distinct keys (per-IP buckets do not share)", () => {
    const a = uniq("sponsor:ip:a");
    const b = uniq("sponsor:ip:b");
    // Exhaust key a.
    expect(rateLimit(a, 1, 60_000).ok).toBe(true);
    expect(rateLimit(a, 1, 60_000).ok).toBe(false);
    // Key b still has its full budget — it must not be affected by a.
    expect(rateLimit(b, 1, 60_000).ok).toBe(true);
  });

  it("keys the per-wallet sponsor bucket independently of the per-IP bucket (#81)", () => {
    const suffix = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const walletKey = `sponsor:wallet:0xabc:${suffix}`;
    const ipKey = `sponsor:ip:1.2.3.4:${suffix}`;
    // Exhaust the per-wallet bucket.
    expect(rateLimit(walletKey, 1, 60_000).ok).toBe(true);
    expect(rateLimit(walletKey, 1, 60_000).ok).toBe(false);
    // The per-IP bucket (different prefix) is unaffected — a wallet throttled for
    // farming gas does not consume the IP budget, and vice-versa. Both apply.
    expect(rateLimit(ipKey, 1, 60_000).ok).toBe(true);
  });

  it("keys the two sponsor routes into separate buckets (sponsor:ip vs execute:ip)", () => {
    const suffix = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const createKey = `sponsor:ip:${suffix}`;
    const executeKey = `execute:ip:${suffix}`;
    // Exhaust the create-route bucket.
    expect(rateLimit(createKey, 1, 60_000).ok).toBe(true);
    expect(rateLimit(createKey, 1, 60_000).ok).toBe(false);
    // The execute-route bucket (different prefix, same IP) is independent.
    expect(rateLimit(executeKey, 1, 60_000).ok).toBe(true);
  });
});
