"use client";

import { useEffect, useRef } from "react";
import { useWallets } from "@mysten/dapp-kit-react";
import { getWallets } from "@mysten/wallet-standard";

/**
 * Keep Enoki zkLogin sign-in working on cold page loads (e.g. incognito / first
 * visit on a deployed domain).
 *
 * Enoki's wallets open the Google OAuth popup *after* an `await` that hydrates
 * their session from IndexedDB. When that read is cold/async, `window.open`
 * runs outside the click's user-activation window and the browser silently
 * blocks the popup → the connect modal shows "Connection failed" with no popup
 * and no console error. dapp-kit's autoConnect only warms that hydration when a
 * wallet was previously saved — which is why a warm localhost works but a cold
 * deploy doesn't.
 *
 * We replicate the warm state up front: on mount, run a `silent` connect on each
 * Enoki ("Sign in with …") wallet. Silent connect hydrates from storage and
 * returns early *without* opening a popup or changing connection state, so a
 * later real click awaits an already-resolved promise and the popup opens
 * within the gesture.
 *
 * `useWallets()` returns UiWallet handles (no callable features), so it's used
 * only to react to registration; the raw wallets — whose `standard:connect`
 * accepts `silent` (dapp-kit's own `connectWallet` deliberately omits it) — come
 * from the wallet-standard registry. Renders nothing.
 */
export function EnokiWarmup() {
  const uiWallets = useWallets();
  const warmed = useRef(false);

  useEffect(() => {
    if (warmed.current) return;
    // Wait until an Enoki wallet has actually registered (it's async).
    if (!uiWallets.some((w) => w.name?.startsWith("Sign in with"))) return;
    warmed.current = true;
    for (const wallet of getWallets().get()) {
      if (!wallet.name?.startsWith("Sign in with")) continue;
      const connectFeature = wallet.features["standard:connect"] as
        | { connect?: (input?: { silent?: boolean }) => Promise<unknown> }
        | undefined;
      // silent → hydrate IndexedDB only; no popup, no connection-state change
      void connectFeature?.connect?.({ silent: true })?.catch(() => {});
    }
  }, [uiWallets]);

  return null;
}
