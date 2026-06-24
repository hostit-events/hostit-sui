"use client";

import { useCallback } from "react";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { GOOGLE_CLIENT_ID, NETWORK } from "./config";

/**
 * sessionStorage key carrying the in-app return target across the Google
 * redirect. It travels OUT-OF-BAND (not in the redirect_uri) because Google
 * matches redirect_uri EXACTLY including the query string — a varying `?next=`
 * breaks the single registered `/auth` URI with `redirect_uri_mismatch`.
 * sessionStorage survives the same-tab round-trip to Google and back to /auth.
 */
export const RETURN_TO_KEY = "hostit:next";

/**
 * Normalize an in-app return target to a SAME-ORIGIN path, or null. Used on both
 * the store side (useGoogleSignIn) and the read side (AuthScreen) so a malicious
 * `?next=` can't redirect a freshly-authenticated user off-site.
 *
 * A bare `startsWith("/") && !startsWith("//")` check is NOT enough: `/\evil.com`
 * passes it, but WHATWG URL parsing normalizes the backslash to `/`, so it
 * resolves to host `evil.com` (classic open-redirect). We reject backslashes
 * outright AND confirm the resolved origin matches ours — the URL parser is the
 * real sink, so we validate against it.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (typeof window === "undefined") return null;
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

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
 * to complete the id_token in the URL hash, and the EXACT redirect_uri
 * allowlisted in the Google OAuth client (no query string — see RETURN_TO_KEY).
 * Pass `returnTo` (e.g. the current `/event/[id]` URL) to have `/auth` bounce
 * there once the session lands, so a buyer who signs in mid-purchase returns to
 * the event they were buying. `returnTo` rides in sessionStorage, never the
 * redirect_uri, so the registered `/auth` URI keeps matching.
 */
export function useGoogleSignIn() {
  const enokiFlow = useEnokiFlow();
  return useCallback(
    async (returnTo?: string) => {
      // Stash the return target out-of-band. Only a validated same-origin path is
      // kept (AuthScreen re-validates on read); anything off-origin is dropped.
      const safe = safeReturnTo(returnTo);
      if (safe) sessionStorage.setItem(RETURN_TO_KEY, safe);
      const url = await enokiFlow.createAuthorizationURL({
        provider: "google",
        clientId: GOOGLE_CLIENT_ID,
        // Constant, query-less, and exactly registered → no redirect_uri_mismatch.
        redirectUrl: new URL("/auth", window.location.origin).toString(),
        network: ENOKI_NETWORK,
        // Ask for the `email` scope so Google puts `email` + `email_verified`
        // in the id_token. Enoki defaults to "openid" only; without this the
        // token has no email claim and /api/email/bind-google rejects it with
        // "Google email not verified" (#96). Scope doesn't affect the zkLogin
        // address (derived from iss/aud/sub), so existing Google users are
        // unaffected; `email` is a non-sensitive scope (no Google re-review).
        extraParams: { scope: ["email"] },
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
