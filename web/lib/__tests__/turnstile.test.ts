import { describe, it, expect, vi, afterEach } from "vitest";

// turnstile.ts imports "server-only" (throws if bundled for the client) —
// neutralize it so the module loads under vitest. Same precedent as
// sponsorGuards.test.ts / memwalAuth.test.ts.
vi.mock("server-only", () => ({}));

import {
  verifyTurnstile,
  blockedByTurnstile,
  turnstileEnforced,
} from "../turnstile";

const ORIG = process.env.TURNSTILE_SECRET_KEY;

afterEach(() => {
  if (ORIG === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = ORIG;
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("verifyTurnstile", () => {
  it("is disabled (ok, skipped) when no secret is configured — and never calls CF", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(turnstileEnforced()).toBe(false);
    const r = await verifyTurnstile("anything", "1.2.3.4");
    expect(r).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails (treated as a bot) when enabled but no token is supplied", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    expect(turnstileEnforced()).toBe(true);
    const r = await verifyTurnstile(undefined, "1.2.3.4");
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(blockedByTurnstile(r)).toBe(true);
  });

  it("passes when Cloudflare returns success:true", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    mockFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const r = await verifyTurnstile("tok", "1.2.3.4");
    expect(r).toEqual({ ok: true, skipped: false });
    expect(blockedByTurnstile(r)).toBe(false);
  });

  it("fails (blocks) when Cloudflare returns success:false", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }),
          { status: 200 },
        ),
    );
    const r = await verifyTurnstile("replayed-token", "1.2.3.4");
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(blockedByTurnstile(r)).toBe(true);
  });

  it("fails OPEN (unreachable, not blocked) on a Cloudflare network error", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    mockFetch(async () => {
      throw new Error("network down");
    });
    const r = await verifyTurnstile("tok", "1.2.3.4");
    expect(r).toEqual({ ok: false, reason: "unreachable" });
    // The whole point of fail-open: a CF outage must NOT block our own routes.
    expect(blockedByTurnstile(r)).toBe(false);
  });

  it("fails OPEN on a Cloudflare 5xx", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret";
    mockFetch(async () => new Response("upstream error", { status: 502 }));
    const r = await verifyTurnstile("tok", "1.2.3.4");
    expect(r).toEqual({ ok: false, reason: "unreachable" });
    expect(blockedByTurnstile(r)).toBe(false);
  });
});
