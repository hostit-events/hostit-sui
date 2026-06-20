import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// rateLimit imports "server-only" (throws if bundled for the client) — neutralize
// it so the module loads under vitest. Same precedent as memwalAuth.test.ts.
vi.mock("server-only", () => ({}));

// Force the deterministic in-memory path: with kvEnabled() === false the limiter
// never fires the (async, best-effort) KV write-through, so the local Map alone
// decides every result. This isolates the unit from any provisioned KV.
vi.mock("../kvStore", () => ({
  kvEnabled: () => false,
  kvIncrWindow: vi.fn(async () => null),
}));

import {
  rateLimit,
  rateLimitMemory,
  clientIpFromHeaders,
} from "../rateLimit";

// The bucket store is process-global module state. vitest isolates module state
// per test file, but multiple `it`s in THIS file share it — so use unique keys.
let n = 0;
function uniq(prefix: string): string {
  return `${prefix}:${n++}:${Math.random().toString(36).slice(2)}`;
}

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

describe("rateLimit (in-memory path, KV disabled)", () => {
  it("allows up to the limit then blocks with a Retry-After hint", () => {
    const key = uniq("k");
    expect(rateLimit(key, 2, 60_000)).toMatchObject({ ok: true, remaining: 1 });
    expect(rateLimit(key, 2, 60_000)).toMatchObject({ ok: true, remaining: 0 });
    const third = rateLimit(key, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(third.remaining).toBe(0);
  });

  describe("window reset (fake timers)", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("re-allows after the window elapses", () => {
      const key = uniq("win");
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);
      expect(rateLimit(key, 1, 60_000).ok).toBe(false);
      // Advance past the window — the count must reset.
      vi.advanceTimersByTime(60_001);
      expect(rateLimit(key, 1, 60_000).ok).toBe(true);
    });
  });
});

describe("rateLimitMemory fan-out", () => {
  it("returns the identity failure BEFORE the IP bucket is consulted", () => {
    const id = uniq("alice");
    const ip = uniq("ip");
    // Exhaust the per-identity budget (limit 1).
    expect(rateLimitMemory("analyze", id, ip, { limit: 1, windowMs: 60_000 }).ok).toBe(true);
    const blocked = rateLimitMemory("analyze", id, ip, { limit: 1, windowMs: 60_000 });
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);

    // The IP bucket must NOT have been consumed by the blocked call: a different
    // identity from the same IP still has its full per-IP budget. With limit 2 the
    // shared IP key `mem:analyze:ip:<ip>` has only the one hit from the first
    // (successful) call above, so this fresh identity's two calls both pass.
    const id2 = uniq("bob");
    expect(rateLimitMemory("analyze", id2, ip, { limit: 2, windowMs: 60_000 }).ok).toBe(true);
  });
});

describe("clientIpFromHeaders precedence", () => {
  it("prefers a platform-verified header over a spoofed x-forwarded-for", () => {
    const ip = clientIpFromHeaders(
      headers({
        "x-vercel-forwarded-for": "1.2.3.4",
        "x-forwarded-for": "9.9.9.9",
      }),
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("uses x-real-ip when no x-vercel-forwarded-for is present", () => {
    const ip = clientIpFromHeaders(
      headers({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "9.9.9.9" }),
    );
    expect(ip).toBe("5.6.7.8");
  });

  it("falls back to the first x-forwarded-for entry when no verified header", () => {
    const ip = clientIpFromHeaders(
      headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }),
    );
    expect(ip).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no IP headers are present", () => {
    expect(clientIpFromHeaders(headers({}))).toBe("unknown");
  });
});
