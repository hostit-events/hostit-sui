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
 *
 * Google ALWAYS returns to `/auth` — the only page that mounts `useAuthCallback`
 * to complete the id_token in the URL hash, and the origin allowlisted in the
 * Google OAuth client. Pass `returnTo` (e.g. the current `/event/[id]` URL) to
 * have `/auth` bounce there once the session lands, so a buyer who signs in
 * mid-purchase returns to the event they were buying.
 */
export function useGoogleSignIn() {
  const enokiFlow = useEnokiFlow();
  return useCallback(
    async (returnTo?: string) => {
      const authUrl = new URL("/auth", window.location.origin);
      if (returnTo) authUrl.searchParams.set("next", returnTo);
      const url = await enokiFlow.createAuthorizationURL({
        provider: "google",
        clientId: GOOGLE_CLIENT_ID,
        redirectUrl: authUrl.toString(),
        network: ENOKI_NETWORK,
      });
      window.location.href = url;
    },
    [enokiFlow],
  );
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
