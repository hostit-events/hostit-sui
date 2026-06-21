// POST /api/email/verify — finish wallet email verification (GH#96). Checks the
// user's 6-digit code against the KV-stored hash; on success deletes it (one-shot,
// replay-safe) and returns the opaque email hash for the client to register
// on-chain (identity::register_email). No Turnstile (already passed at /start).

export const dynamic = "force-dynamic";

import { createHash } from "node:crypto";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { getKv, kvEnabled } from "@/lib/kvStore";
import { rateLimitMemory, clientIpFromHeaders } from "@/lib/rateLimit";

const MAX_BODY_BYTES = 4 * 1024;

interface OtpRecord {
  codeHash: string;
  hashHex: string;
  hashBytes: number[];
  version: number;
  nonce: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: Request) {
  if (!kvEnabled())
    return Response.json({ error: "Verification storage isn't configured." }, { status: 503 });

  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES)
    return Response.json({ error: "body too large" }, { status: 413 });
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  const ip = clientIpFromHeaders(req.headers);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const address = str(body.address);
  const code = str(body.code);
  if (!address || !code) return Response.json({ error: "Missing fields" }, { status: 400 });

  const addr = normalizeSuiAddress(address);
  const rl = rateLimitMemory("email-verify", addr, ip, { limit: 8, windowMs: 60_000 });
  if (!rl.ok)
    return Response.json({ error: "Too many attempts" }, {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });

  const kv = getKv();
  const rec = (await kv?.get(`emailotp:${addr}`)) as OtpRecord | null;
  if (!rec) return Response.json({ error: "Code expired — start again." }, { status: 410 });

  const got = createHash("sha256").update(`${addr}:${rec.nonce}:${code}`).digest("hex");
  if (got !== rec.codeHash) return Response.json({ error: "Incorrect code." }, { status: 401 });

  await kv?.del(`emailotp:${addr}`); // one-shot
  return Response.json({ emailHash: rec.hashHex, hashBytes: rec.hashBytes, version: rec.version });
}
