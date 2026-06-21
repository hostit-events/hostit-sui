// suiNS names live on Sui **mainnet**, even though HostIt runs on testnet. The
// app's dapp-kit client is the active (testnet) client, so resolving names there
// always returned `[]` — the bug where a connected wallet's `.sui` name never
// rendered. This is a dedicated read-only MAINNET client used ONLY for suiNS
// reverse/forward resolution, independent of the app's active network.

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

/** The network suiNS names are resolved against (part of every cache key). */
export const SUINS_NETWORK = "mainnet" as const;

interface SuiNSResolver {
  resolveNameServiceNames: (input: { address: string; limit?: number }) => Promise<{
    data: string[];
    hasNextPage?: boolean;
  }>;
  resolveNameServiceAddress: (input: { name: string }) => Promise<string | null>;
}

let cached: SuiNSResolver | null = null;

/** Singleton read-only mainnet client for suiNS resolution (lazy; never at module load). */
export function getSuiNSClient(): SuiNSResolver {
  if (!cached) {
    cached = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(SUINS_NETWORK),
      network: SUINS_NETWORK,
    }) as unknown as SuiNSResolver;
  }
  return cached;
}
