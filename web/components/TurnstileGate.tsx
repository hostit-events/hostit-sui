"use client";

import { useEffect, useRef } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { TURNSTILE_SITE_KEY } from "@/lib/config";
import {
  registerTurnstileGetter,
  unregisterTurnstileGetter,
} from "@/lib/turnstileClient";

// Bound the wait for a (re)solve so a stuck challenge fails to null rather than
// hanging forever — but long enough that, on the rare action-time interactive
// challenge, a human can actually find and click the corner checkbox (8s wasn't).
// The app-entry <TurnstileWarmup/> means most action-time mints are silent/fast.
const TOKEN_TIMEOUT_MS = 20000;

/**
 * One Cloudflare Turnstile widget for the whole app (mounted in ClientProviders).
 *
 * LAZY (#100): `execution: "execute"` means the widget renders but does NOT run a
 * challenge until `.execute()` is called — so it never solves, and never surfaces
 * an interactive challenge, while the user is just browsing (idle pages like
 * /wallet). The challenge runs ONLY on demand, the moment a gasless/AI action
 * needs a token. With "interaction-only" appearance it stays invisible unless
 * Cloudflare actually requires interaction, in which case it appears bottom-right
 * (high z-index) at action time.
 *
 * Each getter call mints a fresh single-use token: reset() clears any prior one,
 * execute() runs the (usually silent) solve, then we read it. Calls are serialized
 * by lib/turnstileClient so two requests never overlap a solve or share a token.
 * Renders nothing when no site key is configured. See issues #81, #100.
 */
export function TurnstileGate() {
  const ref = useRef<TurnstileInstance | null>(null);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    const fn = async () => {
      const inst = ref.current;
      if (!inst) return null;
      try {
        // Lazy on-demand solve: reset() clears any consumed token, execute() runs
        // the challenge (silent for real users), then read the fresh token. Nothing
        // runs until a caller actually needs a token — no idle-page challenges.
        inst.reset();
        inst.execute();
        const token = await inst.getResponsePromise(TOKEN_TIMEOUT_MS);
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
        options={{ appearance: "interaction-only", execution: "execute" }}
      />
    </div>
  );
}
