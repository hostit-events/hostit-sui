"use client";

import { useEffect } from "react";

/**
 * Makes Enoki's Google (zkLogin) sign-in popup reliable across browsers.
 *
 * Enoki opens the OAuth popup with `window.open` *after* an async session
 * hydration (IndexedDB). On a cold load that call lands outside the click's
 * user-activation window, so browsers silently block the popup — no window
 * opens and the connect modal shows "Connection failed". (It only ever
 * "worked" where popup-blocking is disabled, e.g. an automated browser, or
 * where hydration was already warm, e.g. a returning localhost session.)
 *
 * dapp-kit renders the wallet button itself, so we can't move that
 * `window.open` into the gesture. Instead we intercept the gesture globally:
 * on the *click* of the "Sign in with Google" button (capture phase, before
 * dapp-kit's handler) we synchronously open a blank popup — always permitted
 * inside a user gesture — and briefly shim `window.open` so Enoki's later
 * call reuses our already-open window instead of opening a blocked one.
 *
 * Works for every entry point (the /auth page and the header). Renders nothing.
 */
export function GoogleSignInFix() {
  useEffect(() => {
    function onClickCapture(event: MouseEvent) {
      const target = event.target as Element | null;
      const button = target?.closest?.("button");
      if (!button) return;
      if (!/sign in with google/i.test(button.textContent ?? "")) return;

      // Already armed by a prior click in this gesture — don't open a second one.
      if ((window.open as { __enokiArmed?: boolean }).__enokiArmed) return;

      // Inside the gesture: opening a popup here is never blocked.
      let popup: Window | null = null;
      try {
        popup = window.open("about:blank", "_blank", "popup,width=500,height=640");
      } catch {
        return;
      }
      if (!popup) return; // hard block even in-gesture; nothing we can do

      const original = window.open;
      let consumed = false;
      const patched = function patchedOpen() {
        consumed = true;
        window.open = original;
        return popup;
      } as typeof window.open & { __enokiArmed?: boolean };
      patched.__enokiArmed = true;
      window.open = patched;

      // If Enoki never claims the window (e.g. connect bailed before opening),
      // restore window.open and close the stray blank popup.
      window.setTimeout(() => {
        if (window.open === patched) window.open = original;
        if (!consumed) {
          try {
            popup?.close();
          } catch {
            /* ignore */
          }
        }
      }, 8000);
    }

    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, []);

  return null;
}
