// Server-only Cloudflare Turnstile verification for the project-funded edge
// (the gasless /api/sponsor route + the paid LLM routes). See issue #81.
//
// MODEL: the client attaches a single-use Turnstile token to the request; here
// we validate it against Cloudflare's siteverify endpoint with the SECRET key
// (server-only, never NEXT_PUBLIC_). The bot-wall is ENFORCED only when
// TURNSTILE_SECRET_KEY is set — unset = disabled (dev default), so set the
// public site key (lib/config.ts) and this secret together or neither.
//
// FAIL-OPEN (deliberate, mirrors lib/rateLimit.ts): a real challenge failure
// (bot / missing-or-bad token) blocks; a Cloudflare OUTAGE proceeds, so a CF
// blip never takes down our own sponsorship/AI routes.

import "server-only";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Read at call time (not module load) so tests can toggle the env, and so a
// platform secret-rotation is picked up without a cold start. Trimmed so a
// stray-whitespace value (e.g. `TURNSTILE_SECRET_KEY= `) counts as unset rather
// than flipping enforcement ON with a key CF will always reject.
function secret(): string {
  return (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
}

/** True when a secret is configured, i.e. the bot-wall is enforced server-side. */
export function turnstileEnforced(): boolean {
  return secret().length > 0;
}

export type TurnstileResult =
  | { ok: true; skipped: boolean }
  | { ok: false; reason: "failed" | "unreachable" };

/**
 * Validate a client Turnstile token. Tokens are single-use and valid ~5 min; a
 * replayed token comes back `success:false` (`timeout-or-duplicate`) → `failed`.
 *
 * - no secret configured → `{ ok, skipped }` (disabled)
 * - secret set, no token → `failed` (no proof-of-browser; treat as a bot)
 * - siteverify `success:true` → `ok`
 * - siteverify `success:false` → `failed`
 * - CF unreachable / non-2xx → `unreachable` (caller should fail OPEN)
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string,
): Promise<TurnstileResult> {
  const s = secret();
  if (!s) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: "failed" };

  const form = new URLSearchParams({ secret: s, response: token });
  // The Vercel-verified client IP (lib/rateLimit.ts) sharpens CF's signal; skip
  // the "unknown" sentinel rather than send a bogus value.
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  // Idempotency key makes a future retry of the SAME token safe (CF returns the
  // original verdict instead of timeout-or-duplicate).
  form.set("idempotency_key", crypto.randomUUID());

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      // A persistent non-2xx here usually means a BAD SECRET (4xx), not a real
      // outage — but we still fail OPEN. Log loudly so an operator notices the
      // wall has silently degraded to no-enforcement.
      console.warn(`[turnstile] siteverify ${res.status} — failing OPEN (check TURNSTILE_SECRET_KEY)`);
      return { ok: false, reason: "unreachable" };
    }
    const data = (await res.json()) as { success?: boolean };
    return data.success === true
      ? { ok: true, skipped: false }
      : { ok: false, reason: "failed" };
  } catch (e) {
    console.warn("[turnstile] siteverify unreachable — failing OPEN", e);
    return { ok: false, reason: "unreachable" }; // network error → fail-open
  }
}

/**
 * Block ONLY on a genuine challenge failure. The disabled state and a CF outage
 * (`unreachable`) both return false — proceed (fail-open).
 */
export function blockedByTurnstile(r: TurnstileResult): boolean {
  return !r.ok && r.reason === "failed";
}
