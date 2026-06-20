// Server-only route. Forwards the user-signed sponsored tx to Enoki for
// execution. Returns the final on-chain digest.

import { EnokiClient } from "@mysten/enoki";
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Per-IP rate limit + body cap: this route is UNAUTHENTICATED and drives the
// Enoki sponsor wallet, so it is a cost/abuse surface. Mirrors the /api/copilot
// limiter. NOTE: per-process only — see plan 003 for a durable KV-backed limiter
// across serverless instances.
const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;
// Body is just { digest, signature } — both short strings. 16 KB is ample.
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Server is missing ENOKI_PRIVATE_API_KEY" },
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

  // Per-IP rate limit before any Enoki execution (429 + Retry-After on breach).
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`execute:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  let body: { digest?: string; signature?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { digest, signature } = body;
  if (!digest || !signature) {
    return Response.json(
      { error: "Missing digest or signature" },
      { status: 400 },
    );
  }

  const enoki = new EnokiClient({ apiKey });
  try {
    const result = await enoki.executeSponsoredTransaction({ digest, signature });
    return Response.json(result);
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; errors?: unknown };
    // Log full upstream detail server-side ONLY; never echo it to the client.
    console.error("[sponsor/execute] executeSponsoredTransaction failed", {
      status: e.status,
      message: e.message,
      errors: e.errors,
    });
    const status = e.status ?? 500;
    return Response.json(
      { error: "Could not execute sponsored transaction. Please try again." },
      { status },
    );
  }
}
