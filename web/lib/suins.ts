"use client";

import { useQuery } from "@tanstack/react-query";
import { useCurrentClient } from "@mysten/dapp-kit-react";

/** Reverse-look up a Sui address → first registered suiNS name, or null. */
export function useSuiNSName(address: string | null | undefined) {
  // Cast to the JSON-RPC client at the call site since dapp-kit returns the
  // abstract ClientWithCoreApi type. We configure with SuiJsonRpcClient in
  // lib/dapp-kit.ts so the method exists at runtime.
  const client = useCurrentClient() as unknown as {
    resolveNameServiceNames: (input: { address: string; limit?: number }) => Promise<{
      data: string[];
      hasNextPage?: boolean;
    }>;
  };
  return useQuery<string | null, Error>({
    queryKey: ["suins-reverse", address],
    enabled: Boolean(address),
    staleTime: 5 * 60_000, // names rarely change; 5 min is safe
    gcTime: 30 * 60_000,
    queryFn: async () => {
      if (!address) return null;
      try {
        const res = await client.resolveNameServiceNames({ address, limit: 1 });
        return res.data[0] ?? null;
      } catch {
        return null;
      }
    },
  });
}
