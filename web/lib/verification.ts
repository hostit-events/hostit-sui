"use client";

import { useQueries } from "@tanstack/react-query";
import { useCurrentClient } from "@mysten/dapp-kit-react";

/**
 * Batched suiNS reverse-lookup for many addresses at once. Each lookup is
 * keyed individually in tanstack-query so the cache survives address-list
 * changes (an additional address just fires one new query).
 */
export function useSuiNSNames(addresses: string[]): Map<string, string | null> {
  const client = useCurrentClient() as unknown as {
    resolveNameServiceNames: (input: { address: string; limit?: number }) => Promise<{
      data: string[];
    }>;
  };

  const results = useQueries({
    queries: addresses.map((address) => ({
      queryKey: ["suins-reverse", address],
      queryFn: async () => {
        try {
          const res = await client.resolveNameServiceNames({ address, limit: 1 });
          return res.data[0] ?? null;
        } catch {
          return null;
        }
      },
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    })),
  });

  const map = new Map<string, string | null>();
  addresses.forEach((addr, i) => map.set(addr, (results[i]?.data as string | null) ?? null));
  return map;
}

/**
 * v1 verification: an organizer address is "verified" iff it holds a registered
 * suiNS name. Used by `<EventCard verified={...} />` to show the permissionless
 * quality signal in place of any gating (anyone can create an event; suiNS/KYC
 * distinguishes trusted ones — it never hides or reorders events).
 *
 * v2 will layer a KYC tier on top; the consumer interface stays the same
 * (single boolean), with a separate hook for the KYC bit.
 */
export function useIsVerified(address: string | null | undefined): boolean {
  const addresses = address ? [address] : [];
  const names = useSuiNSNames(addresses);
  if (!address) return false;
  return Boolean(names.get(address));
}
