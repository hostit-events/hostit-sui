"use client";

import { useQuery } from "@tanstack/react-query";
import { getSuiNSClient, SUINS_NETWORK } from "./suinsClient";

/**
 * Reverse-look up a Sui address → its default/primary suiNS name, or null.
 * Resolves on the MAINNET suiNS client (see lib/suinsClient.ts) — names don't
 * exist on testnet. Returns null for an address with no default name (the common
 * case, not an error); genuine RPC failures surface as a query error (one retry)
 * so they aren't masked as "no name forever" — consumers fall back to hex.
 */
export function useSuiNSName(address: string | null | undefined) {
  const client = getSuiNSClient();
  return useQuery<string | null, Error>({
    queryKey: ["suins-reverse", SUINS_NETWORK, address],
    enabled: Boolean(address),
    staleTime: 5 * 60_000, // names rarely change; 5 min is safe
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async () => {
      if (!address) return null;
      const res = await client.resolveNameServiceNames({ address, limit: 1 });
      return res.data[0] ?? null;
    },
  });
}

/**
 * Forward-resolve a suiNS name → address (for search by name). Accepts a bare
 * label or a `.sui` name; resolves on mainnet. Returns null if unregistered.
 */
export function useResolveSuiNSAddress(name: string | null | undefined) {
  const client = getSuiNSClient();
  const clean = name?.trim().toLowerCase() || "";
  return useQuery<string | null, Error>({
    queryKey: ["suins-forward", SUINS_NETWORK, clean],
    enabled: clean.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    queryFn: async () => {
      const full = clean.endsWith(".sui") ? clean : `${clean}.sui`;
      const addr = await client.resolveNameServiceAddress({ name: full });
      return addr ?? null;
    },
  });
}
