"use client";

import { useEffect } from "react";
import { getTurnstileToken, isTurnstileReady } from "@/lib/turnstileClient";
import { TURNSTILE_ENABLED } from "@/lib/config";

/**
 * Run the Cloudflare Turnstile challenge ONCE on first entry to the app.
 *
 * Mounted in the (app) layout, so it fires when the user lands on /discover etc.
 * — NEVER on the landing page (root layout). Surfacing any interactive checkbox
 * here (when the user has just arrived and isn't mid-task) instead of lazily at
 * purchase time means the gasless buy can mint its token silently: solving the
 * challenge once primes Cloudflare's clearance for the rest of the session, so
 * no checkbox interrupts checkout (issue #100's lazy execution moved the friction
 * INTO the purchase — this moves it back to a calm moment).
 *
 * Fire-and-forget: the warm-up token is discarded; the point is to establish
 * trust. Waits out the hard-load mount race against <TurnstileGate/> registering
 * its getter, then triggers exactly one solve.
 */
export function TurnstileWarmup() {
  useEffect(() => {
    if (!TURNSTILE_ENABLED) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const warm = () => {
      if (isTurnstileReady()) {
        void getTurnstileToken(); // one solve; token discarded
        return;
      }
      if (tries++ < 12) timer = setTimeout(warm, 300); // widget not mounted yet
    };
    warm();
    return () => clearTimeout(timer);
  }, []);
  return null;
}
