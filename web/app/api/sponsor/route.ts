// Server-only route. Holds the private Enoki API key.
// Receives a transaction-kind from the client, asks Enoki to sponsor, returns
// the sponsor-signed bytes + digest. The client signs the bytes locally and
// sends them to /api/sponsor/execute.

import { EnokiClient } from "@mysten/enoki";
import { NETWORK, SPONSORED_TARGETS } from "@/lib/config";
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Per-IP rate limit + body cap: this route is UNAUTHENTICATED and makes the
// Enoki sponsor wallet pay gas, so it is a gas-drain surface. Mirrors the
// /api/copilot limiter. NOTE: per-process only — see plan 003 for a durable
// KV-backed limiter across serverless instances.
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
// transactionKindBytes is base64 of a tx kind; 128 KB is generous and bounds
// junk-payload cost before we call Enoki.
const MAX_BODY_BYTES = 128 * 1024;

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

  let body: { transactionKindBytes?: string; sender?: string };
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
    const e = err as { message?: string; status?: number; errors?: unknown };
    // Log full upstream detail server-side ONLY; never echo it to the client.
    console.error("[sponsor] createSponsoredTransaction failed", {
      status: e.status,
      message: e.message,
      errors: e.errors,
    });
    const status = e.status ?? 500;
    return Response.json(
      { error: "Could not create sponsored transaction. Please try again." },
      { status },
    );
  }
}
