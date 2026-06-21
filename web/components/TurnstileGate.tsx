"use client";

import { useEffect, useRef } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/config";
import {
  registerTurnstileGetter,
  unregisterTurnstileGetter,
} from "@/lib/turnstileClient";

// Bound the wait for a (re)solve so a slow/stuck challenge fails fast to null
// rather than hanging the user — far below the library's 30s default.
const TOKEN_TIMEOUT_MS = 8000;

/**
 * One invisible Cloudflare Turnstile widget for the whole app (mounted in
 * ClientProviders). "interaction-only" appearance: silent for real users, a
 * visible challenge only when Cloudflare deems it necessary — so it's pinned
 * bottom-right with a high z-index to stay clickable in that rare case.
 *
 * Tokens are single-use (~5 min). The getter READS the currently-solved token
 * (the mount token, or one pre-armed by the prior call), returns it, and only
 * THEN resets to mint the next one in the background — never reset-before-read
 * (which would throw away the valid mount token and stall the first request).
 * Calls are serialized by lib/turnstileClient so two requests never share a
 * token. Renders nothing when no site key is configured. See issue #81.
 */
export function TurnstileGate() {
  const ref = useRef<TurnstileInstance | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    const fn = async () => {
      const inst = ref.current;
      if (!inst) return null;
      try {
        // Use the already-solved token if present; only wait for a solve when
        // none is ready (bounded by an explicit short timeout).
        const token = inst.getResponse() ?? (await inst.getResponsePromise(TOKEN_TIMEOUT_MS));
        // Pre-arm the NEXT single-use token in the background (do NOT await), so
        // the next serialized caller usually finds one ready.
        inst.reset();
        return token ?? null;
      } catch {
        return null;
      }
    };
    registerTurnstileGetter(fn);
    return () => unregisterTurnstileGetter(fn);
  }, []);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div style={{ position: "fixed", right: 12, bottom: 12, zIndex: 60 }}>
      <Turnstile
        ref={ref}
        siteKey={TURNSTILE_SITE_KEY}
        options={{ appearance: "interaction-only" }}
      />
    </div>
  );
}
