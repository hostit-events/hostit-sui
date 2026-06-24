// Server-only route. Holds the private Enoki API key.
// Receives a transaction-kind from the client, asks Enoki to sponsor, returns
// the sponsor-signed bytes + digest. The client signs the bytes locally and
// sends them to /api/sponsor/execute.

import { EnokiClient } from "@mysten/enoki";
import { NETWORK, SPONSORED_TARGETS } from "@/lib/config";
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";
import { verifyTurnstile, blockedByTurnstile } from "@/lib/turnstile";

export const dynamic = "force-dynamic";

// Per-IP rate limit + body cap: this route is UNAUTHENTICATED and makes the
// Enoki sponsor wallet pay gas, so it is a gas-drain surface. Mirrors the
// /api/copilot limiter. NOTE: per-process only — see plan 003 for a durable
// KV-backed limiter across serverless instances.
const RL_LIMIT = 20;
// Per-WALLET budget: a single wallet farming sponsored gas is throttled
// independently of its IP (which rotates cheaply behind NAT/VPN). Tighter than
// the per-IP cap because one human rarely fires >10 sponsored txs/min. (#81)
const RL_WALLET_LIMIT = 10;
const RL_WINDOW_MS = 60_000;
// transactionKindBytes is base64 of a tx kind; 128 KB is generous and bounds
// junk-payload cost before we call Enoki.
const MAX_BODY_BYTES = 128 * 1024;

/**
 * Canonicalize a client-supplied Sui address (lowercase, zero-padded to 32
 * bytes) or return null if it isn't a valid hex address. Used to key the
 * per-wallet rate bucket so cosmetic variants (casing, leading-zero forms) can't
 * mint fresh buckets, and junk senders are rejected before we ever call Enoki.
 */
function normalizeSuiAddress(a: string): string | null {
  const m = /^0x([0-9a-fA-F]{1,64})$/.exec(a.trim());
  return m ? `0x${m[1].toLowerCase().padStart(64, "0")}` : null;
}

export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Server is missing ENOKI_PRIVATE_API_KEY. Add it to web/.env.local (do not prefix with NEXT_PUBLIC_).",
      },
      { status: 500 },
    );
  }

  // Byte cap the raw payload BEFORE parsing (413 on oversize). A Content-Length
  // header lets us short-circuit; otherwise we measure the decoded body.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  // Per-IP rate limit before any Enoki sponsorship (429 + Retry-After on breach).
  // A blocked request never reaches createSponsoredTransaction, so it costs no gas.
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`sponsor:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: {
    transactionKindBytes?: string;
    sender?: string;
    turnstileToken?: string;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { transactionKindBytes, sender } = body;
  if (!transactionKindBytes || !sender) {
    return Response.json(
      { error: "Missing transactionKindBytes or sender" },
      { status: 400 },
    );
  }

  // Reject a malformed sender BEFORE any Enoki work, and canonicalize it so the
  // per-wallet bucket can't be evaded with cosmetic address variants. (#81)
  const wallet = normalizeSuiAddress(sender);
  if (!wallet) {
    return Response.json({ error: "Invalid sender address" }, { status: 400 });
  }

  // Per-wallet rate limit (in addition to the per-IP one above): bounds a single
  // wallet draining the sponsor budget even as it rotates IPs. The per-IP cap is
  // the real backstop — a fresh keypair still mints a fresh bucket (inherent). (#81)
  const rlWallet = rateLimit(`sponsor:wallet:${wallet}`, RL_WALLET_LIMIT, RL_WINDOW_MS);
  if (!rlWallet.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rlWallet.retryAfterSec) } },
    );
  }

  // Bot-wall: require a valid Cloudflare Turnstile token before the sponsor
  // wallet pays gas. Enforced only when TURNSTILE_SECRET_KEY is set; a CF outage
  // fails OPEN (proceeds) so a Cloudflare blip never blocks sponsorship. A 403
  // here denies the FREE gas only — the user can still self-sign and pay their
  // own gas on-chain (the chain is never gated). (#81)
  if (blockedByTurnstile(await verifyTurnstile(body.turnstileToken, ip))) {
    return Response.json(
      { error: "Bot check failed. Refresh the page and try again." },
      { status: 403 },
    );
  }

  const enokiNetwork = NETWORK === "localnet" ? "testnet" : NETWORK;
  const enoki = new EnokiClient({ apiKey });

  try {
    const sponsored = await enoki.createSponsoredTransaction({
      network: enokiNetwork,
      transactionKindBytes,
      sender,
      allowedMoveCallTargets: SPONSORED_TARGETS as string[],
    });
    return Response.json(sponsored);
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      status?: number;
      errors?: Array<{ code?: string; message?: string }>;
    };
    // Log full upstream detail server-side ONLY.
    console.error("[sponsor] createSponsoredTransaction failed", {
      status: e.status,
      message: e.message,
      errors: e.errors,
    });
    // When Enoki's dry run hit a Move abort (e.g. per-wallet limit, sold out,
    // window closed), forward JUST the MoveAbort substring so the client's
    // humanizeError shows the REAL reason instead of a generic "couldn't sponsor".
    // A Move abort code is public, deterministic on-chain state — not sensitive;
    // we surface only that substring, never the rest of the Enoki payload.
    const dryRunMsg = Array.isArray(e.errors)
      ? e.errors.find((x) => x?.code === "dry_run_failed")?.message
      : undefined;
    const moveAbort = dryRunMsg?.match(/MoveAbort\(.*\}\s*,\s*\d+\)/)?.[0];
    if (moveAbort) {
      return Response.json({ error: moveAbort }, { status: 400 });
    }
    const status = e.status ?? 500;
    return Response.json(
      { error: "Could not create sponsored transaction. Please try again." },
      { status },
    );
  }
}
