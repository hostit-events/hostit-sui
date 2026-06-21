// POST /api/email/start — begin wallet email verification (GH#96). Proves the
// wallet controls `address` (it signed the binding message), then emails a
// one-time code. The code's hash (not the code) + the opaque email hash are
// stored in KV for ~10 min, keyed by address. Google users DON'T use this route
// (their email is provider-verified via /api/email/bind-google).
//
// Defense stack mirrors app/api/sponsor/route.ts: force-dynamic, body cap,
// config guard, rate limit (per-address + per-IP), Turnstile, then the work.

export const dynamic = "force-dynamic";

import { createHash, randomInt } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { emailHash, emailHashConfigured } from "@/lib/emailHash";
import { canonicalizeEmail } from "@/lib/emailCanonical";
import { emailBindMessage, OTP_TTL_MS } from "@/lib/accountMessages";
import { getKv, kvEnabled } from "@/lib/kvStore";
import { rateLimitMemory, clientIpFromHeaders } from "@/lib/rateLimit";
import { verifyTurnstile, blockedByTurnstile } from "@/lib/turnstile";

const MAX_BODY_BYTES = 8 * 1024;
const RESEND_API = "https://api.resend.com/emails";

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: Request) {
  if (!emailHashConfigured() || !process.env.RESEND_API_KEY)
    return Response.json({ error: "Email verification isn't configured." }, { status: 503 });
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
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES)
    return Response.json({ error: "body too large" }, { status: 413 });

  const ip = clientIpFromHeaders(req.headers);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = str(body.email);
  const address = str(body.address);
  const signature = str(body.signature);
  const nonce = str(body.nonce);
  const expiryMs = typeof body.expiryMs === "number" ? body.expiryMs : null;
  const turnstileToken = str(body.turnstileToken);
  if (!email || !address || !signature || !nonce || expiryMs === null)
    return Response.json({ error: "Missing fields" }, { status: 400 });

  const addr = normalizeSuiAddress(address);
  const rl = rateLimitMemory("email-start", addr, ip, { limit: 5, windowMs: 60_000 });
  if (!rl.ok)
    return Response.json({ error: "Rate limit exceeded" }, {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });

  if (blockedByTurnstile(await verifyTurnstile(turnstileToken, ip)))
    return Response.json({ error: "Bot check failed." }, { status: 403 });

  const canon = canonicalizeEmail(email);
  if (!canon) return Response.json({ error: "Enter a valid email." }, { status: 400 });
  if (!Number.isFinite(expiryMs) || expiryMs < Date.now())
    return Response.json({ error: "Request expired — try again." }, { status: 400 });

  // Verify the wallet signed the EXACT binding message (proves address ownership).
  const message = emailBindMessage({ address: addr, canonicalEmail: canon, nonce, expiryMs });
  let signer: string;
  try {
    const pub = await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature);
    signer = normalizeSuiAddress(pub.toSuiAddress());
  } catch {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  if (signer !== addr)
    return Response.json({ error: "Signature address mismatch" }, { status: 401 });

  const eh = emailHash(canon);
  if (!eh) return Response.json({ error: "Enter a valid email." }, { status: 400 });

  // Issue + store a one-time code (hash only) bound to address+nonce.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = createHash("sha256").update(`${addr}:${nonce}:${code}`).digest("hex");
  await getKv()?.set(
    `emailotp:${addr}`,
    { codeHash, hashHex: eh.hashHex, hashBytes: eh.hashBytes, version: eh.version, nonce },
    { px: OTP_TTL_MS },
  );

  const from = process.env.EMAIL_FROM ?? "HostIt <onboarding@resend.dev>";
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `email-verify/${addr}-${nonce}`,
    },
    body: JSON.stringify({
      from,
      to: [canon],
      subject: "Your HostIt verification code",
      text: `Your HostIt email verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't request this, ignore this email.`,
    }),
  });
  if (!res.ok) {
    console.error("resend send failed", res.status, await res.text().catch(() => ""));
    return Response.json({ error: "Couldn't send the email — try again." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
