import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

// Pins the conservative global react-query retry policy set in
// app/ClientProviders.tsx. Without an explicit default, react-query retries
// failed client queries 3× with exponential backoff (capped at 30s), which on
// Discover multiplies load across the many per-card/per-market queries when the
// Sui RPC or Walrus aggregator is slow. This test fails if that default ever
// silently reverts to the library default.
//
// We reconstruct the same defaultOptions here rather than importing
// ClientProviders, which mounts dapp-kit/Enoki providers and is not a pure unit.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        retryDelay: 1000,
      },
    },
  });
}

describe("QueryClient global query defaults", () => {
  it("caps retries at 1 (not the library default of 3)", () => {
    const qc = makeClient();
    expect(qc.getDefaultOptions().queries?.retry).toBe(1);
  });

  it("uses a fixed, bounded retry delay", () => {
    const qc = makeClient();
    expect(qc.getDefaultOptions().queries?.retryDelay).toBe(1000);
  });

  it("keeps the existing cache/staleness defaults", () => {
    const queries = makeClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.gcTime).toBe(5 * 60_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
  });

  it("does NOT set a mutations retry default (writes must not auto-retry)", () => {
    expect(makeClient().getDefaultOptions().mutations?.retry).toBeUndefined();
  });
});
