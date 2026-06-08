// One DAppKit instance per process; created lazily so it never runs at module
// load time during build (where `window` doesn't exist).

import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { NETWORK } from "./config";

type DAppKitInstance = ReturnType<typeof buildDAppKit>;

let cached: DAppKitInstance | null = null;

export function getDAppKit(): DAppKitInstance {
  if (cached) return cached;

  const defaultNet = (NETWORK === "localnet" ? "testnet" : NETWORK) as
    | "testnet"
    | "mainnet"
    | "devnet";

  cached = buildDAppKit(defaultNet);
  return cached;
}

function buildDAppKit(
  defaultNet: "testnet" | "mainnet" | "devnet",
) {
  return createDAppKit({
    networks: ["testnet", "mainnet", "devnet"] as const,
    createClient: (network) =>
      new SuiJsonRpcClient({
        url: getJsonRpcFullnodeUrl(network),
        network,
      }),
    defaultNetwork: defaultNet,
    autoConnect: true,
    // Google sign-in is handled by Enoki's full-page redirect flow (see
    // lib/auth.ts), not a dapp-kit popup wallet. dapp-kit keeps its default
    // wallet-standard wallets (Slush + injected extensions).
    walletInitializers: [],
  });
}
