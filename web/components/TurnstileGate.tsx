"use client";

import { useEffect, useRef, useState } from "react";
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
 * needs a token (and once on app entry via <TurnstileWarmup/>). With
 * "interaction-only" appearance it stays invisible unless Cloudflare actually
 * requires a human, in which case the widget is promoted to a centered modal with
 * a blurred backdrop (so it can't be missed) and drops back on success/expiry.
 *
 * Each getter call mints a fresh single-use token: reset() clears any prior one,
 * execute() runs the (usually silent) solve, then we read it. Calls are serialized
 * by lib/turnstileClient so two requests never overlap a solve or share a token.
 * Renders nothing when no site key is configured. See issues #81, #100.
 */
export function TurnstileGate() {
  const ref = useRef<TurnstileInstance | null>(null);
  // True only while Cloudflare is actually requiring a human interaction. We then
  // promote the (always-mounted) widget into a centered, backdrop-blurred modal
  // so the checkbox can't be missed, and drop back on success/expiry/error.
  const [interactive, setInteractive] = useState(false);

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
    <>
      {/* Blur + dim the whole site behind the challenge so focus lands on it.
          Only present while interactive — never on idle/landing (the widget
          stays silent there). */}
      {interactive && (
        <div aria-hidden className="fixed inset-0 z-[70] bg-background/70 backdrop-blur-md" />
      )}
      {/* The single persistent widget: centered modal while interactive, parked
          (invisible — interaction-only) bottom-right otherwise. NEVER unmounted,
          so the ref + token getter survive the promotion. */}
      <div
        className={
          interactive
            ? "fixed inset-0 z-[71] grid place-items-center p-4"
            : "fixed bottom-3 right-3 z-[60]"
        }
        role={interactive ? "dialog" : undefined}
        aria-modal={interactive || undefined}
        aria-label={interactive ? "Human verification" : undefined}
      >
        <div
          className={
            interactive
              ? "flex flex-col items-center gap-3 rounded-2xl border bg-card p-6 shadow-2xl"
              : undefined
          }
        >
          {interactive && (
            <div className="text-center">
              <p className="text-sm font-semibold">Quick verification</p>
              <p className="text-xs text-muted-foreground">Confirm you’re human to continue.</p>
            </div>
          )}
          <Turnstile
            ref={ref}
            siteKey={TURNSTILE_SITE_KEY}
            onBeforeInteractive={() => setInteractive(true)}
            onAfterInteractive={() => setInteractive(false)}
            onSuccess={() => setInteractive(false)}
            onError={() => setInteractive(false)}
            onExpire={() => setInteractive(false)}
            options={{ appearance: "interaction-only", execution: "execute" }}
          />
        </div>
      </div>
    </>
  );
}
