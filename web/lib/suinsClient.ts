// suiNS resolution runs on the app's ACTIVE network (lib/config `NETWORK`,
// testnet by default). suiNS is live on Sui testnet, so a testnet wallet's
// `.sui` name resolves on the testnet fullnode — names resolve on the same
// network the app and all its addresses live on. (Previously hard-coded to
// mainnet on the false premise that "names don't exist on testnet", so every
// lookup returned [] and no `.sui` name ever rendered — GH#113.) Dedicated
// read-only client for reverse/forward resolution; names only resolve where a
// name service exists (testnet/mainnet), not on localnet.

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { NETWORK, rpcUrl } from "./config";

/** The network suiNS names are resolved against (part of every cache key). */
export const SUINS_NETWORK = NETWORK;

interface SuiNSResolver {
  resolveNameServiceNames: (input: { address: string; limit?: number }) => Promise<{
    data: string[];
    hasNextPage?: boolean;
  }>;
  resolveNameServiceAddress: (input: { name: string }) => Promise<string | null>;
}

let cached: SuiNSResolver | null = null;

/** Singleton read-only client for suiNS resolution on the app network (lazy; never at module load). */
export function getSuiNSClient(): SuiNSResolver {
  if (!cached) {
    cached = new SuiJsonRpcClient({
      url: rpcUrl(SUINS_NETWORK),
      network: SUINS_NETWORK,
    }) as unknown as SuiNSResolver;
  }
  return cached;
}
