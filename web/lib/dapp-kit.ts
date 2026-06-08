// One DAppKit instance per process; created lazily so it never runs at module
// load time during build (where `window` doesn't exist).

import { createDAppKit } from "@mysten/dapp-kit-core";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { enokiWalletsInitializer } from "@mysten/enoki";
import { ENOKI_API_KEY, ENOKI_ENABLED, GOOGLE_CLIENT_ID, NETWORK } from "./config";

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
    walletInitializers:
      ENOKI_ENABLED && GOOGLE_CLIENT_ID
        ? [
            enokiWalletsInitializer({
              apiKey: ENOKI_API_KEY,
              providers: {
                google: {
                  clientId: GOOGLE_CLIENT_ID,
                  // Pin the OAuth redirect to one stable URL. Enoki otherwise
                  // defaults redirect_uri to the *current* page, so signing in
                  // via the global "Connect Wallet" header from /discover,
                  // /wallet, … would each need allowlisting in Google. With
                  // this, only `${origin}/auth` must be registered per domain.
                  // (getDAppKit runs client-side only, so `window` is defined;
                  // guarded anyway for safety.)
                  ...(typeof window !== "undefined"
                    ? { redirectUrl: `${window.location.origin}/auth` }
                    : {}),
                },
              },
            }),
          ]
        : [],
  });
}
