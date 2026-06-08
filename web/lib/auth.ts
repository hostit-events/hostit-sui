"use client";

import { useCallback } from "react";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { GOOGLE_CLIENT_ID, NETWORK } from "./config";

/** Enoki only knows mainnet/testnet/devnet; map localnet → testnet. */
export const ENOKI_NETWORK = (
  NETWORK === "mainnet" ? "mainnet" : NETWORK === "devnet" ? "devnet" : "testnet"
) as "mainnet" | "testnet" | "devnet";

/** True when the active session is Google (Enoki zkLogin), not a wallet. */
export function useIsGoogleSession(): boolean {
  return !!useZkLogin().address;
}

/**
 * Start Google zkLogin as a **full-page redirect** (no popup). The popup flow
 * is fragile across browsers (blocked when `window.open` runs after the async
 * session hydration); a same-tab redirect is immune — sessionStorage/IndexedDB
 * survives the round-trip to Google and back to `/auth`.
 */
export function useGoogleSignIn() {
  const enokiFlow = useEnokiFlow();
  return useCallback(async () => {
    const url = await enokiFlow.createAuthorizationURL({
      provider: "google",
      clientId: GOOGLE_CLIENT_ID,
      redirectUrl: `${window.location.origin}/auth`,
      network: ENOKI_NETWORK,
    });
    window.location.href = url;
  }, [enokiFlow]);
}

/** Sign out of whichever session is active (Google zkLogin or wallet). */
export function useSignOut() {
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();
  const dAppKit = useDAppKit();
  return useCallback(async () => {
    if (zk.address) await enokiFlow.logout();
    else await dAppKit.disconnectWallet();
  }, [enokiFlow, zk.address, dAppKit]);
}
