import { describe, it, expect } from "vitest";
import {
  registerTurnstileGetter,
  unregisterTurnstileGetter,
  getTurnstileToken,
} from "../turnstileClient";

// The single Turnstile widget mints single-use tokens; lib/turnstileClient must
// SERIALIZE concurrent requests so two callers never overlap a reset()+solve or
// share a token (which Cloudflare would reject as timeout-or-duplicate). (#81)
describe("getTurnstileToken serialization", () => {
  it("returns null when no widget getter is registered", async () => {
    expect(await getTurnstileToken()).toBeNull();
  });

  it("serializes concurrent requests: no overlap, each gets a distinct token", async () => {
    let n = 0;
    let active = 0;
    let maxActive = 0;
    const fn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // simulate reset()+solve latency
      active -= 1;
      return `tok-${(n += 1)}`;
    };
    registerTurnstileGetter(fn);
    try {
      const tokens = await Promise.all([
        getTurnstileToken(),
        getTurnstileToken(),
        getTurnstileToken(),
      ]);
      // Distinct tokens — no two callers shared a single-use token.
      expect(new Set(tokens).size).toBe(3);
      // Never two mints in flight at once — the chain enforced one-at-a-time.
      expect(maxActive).toBe(1);
    } finally {
      unregisterTurnstileGetter(fn);
    }
  });

  it("keeps the queue alive after a getter throws (no deadlock)", async () => {
    let call = 0;
    const fn = async () => {
      call += 1;
      if (call === 1) throw new Error("first mint failed");
      return `ok-${call}`;
    };
    registerTurnstileGetter(fn);
    try {
      const [a, b] = await Promise.all([getTurnstileToken(), getTurnstileToken()]);
      expect(a).toBeNull(); // first swallowed to null
      expect(b).toBe("ok-2"); // chain survived and served the next caller
    } finally {
      unregisterTurnstileGetter(fn);
    }
  });

  it("unregister is identity-safe (a stale cleanup can't clear a newer getter)", async () => {
    const oldFn = async () => "old";
    const newFn = async () => "new";
    registerTurnstileGetter(oldFn);
    registerTurnstileGetter(newFn);
    unregisterTurnstileGetter(oldFn); // stale cleanup — must NOT clear newFn
    try {
      expect(await getTurnstileToken()).toBe("new");
    } finally {
      unregisterTurnstileGetter(newFn);
    }
  });
});
