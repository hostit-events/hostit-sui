// Client-side bridge to the single invisible Turnstile widget
// (components/TurnstileGate.tsx). The widget registers its token-getter here on
// mount, so the gasless sponsor flow (lib/sponsor.ts) and the LLM client calls
// (CopilotPanel, memoryClient) can `await getTurnstileToken()` before POSTing
// WITHOUT each holding a React ref to the widget. See issue #81.
//
// SERIALIZED: there is ONE widget, and Turnstile tokens are single-use — so two
// concurrent callers must NOT both grab "the current token" (Cloudflare rejects
// the second as `timeout-or-duplicate`). getTurnstileToken() therefore queues
// every request through a single in-flight chain, so each caller gets its own
// freshly-minted token and the widget's reset()+solve never overlap.
//
// Returns null when Turnstile is disabled (no site key) or the widget isn't
// ready; the server treats a null token as a failed challenge ONLY when a secret
// is configured (lib/turnstile.ts), so disabled-everywhere is a clean no-op.

type Getter = () => Promise<string | null>;

// ponytail: one global widget per page → a single registration slot is enough.
let getter: Getter | null = null;
// Serialization queue — never rejects (each link swallows its own error) so the
// chain can't deadlock.
let chain: Promise<unknown> = Promise.resolve();

export function registerTurnstileGetter(fn: Getter): void {
  getter = fn;
}

/** True once the single widget has registered its getter (i.e. a token can be
 *  minted). Lets the app-entry warm-up wait out the hard-load mount race instead
 *  of misreading a not-ready null as a failed challenge. */
export function isTurnstileReady(): boolean {
  return getter !== null;
}

/** Identity-safe clear: only nulls the slot if `fn` is still the live getter, so
 *  a Strict-Mode mount→unmount→mount can't have the old cleanup clobber the new
 *  registration. */
export function unregisterTurnstileGetter(fn: Getter): void {
  if (getter === fn) getter = null;
}

export async function getTurnstileToken(): Promise<string | null> {
  const g = getter;
  if (!g) return null;
  const run = chain.then(() => g().catch(() => null));
  // Advance the queue; swallow errors so a failed mint never breaks the chain.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
