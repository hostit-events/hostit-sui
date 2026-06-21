// POST /api/email/bind-google — verify a Google id_token server-side and return
// the opaque email hash (GH#96). Google's `email_verified` is provider-
// authoritative, so no OTP is needed; we just re-verify the JWT signature/
// audience/expiry against Google's JWKS, then HMAC the verified email.

export const dynamic = "force-dynamic";

import { createRemoteJWKSet, jwtVerify } from "jose";
import { emailHash, emailHashConfigured } from "@/lib/emailHash";
import { GOOGLE_CLIENT_ID } from "@/lib/config";
import { clientIpFromHeaders, rateLimitMemory } from "@/lib/rateLimit";

const MAX_BODY_BYTES = 16 * 1024;
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function POST(req: Request) {
  if (!emailHashConfigured())
    return Response.json({ error: "Email isn't configured." }, { status: 503 });
  if (!GOOGLE_CLIENT_ID)
    return Response.json({ error: "Google sign-in isn't configured." }, { status: 503 });

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
  const rl = rateLimitMemory("email-google", ip, ip, { limit: 10, windowMs: 60_000 });
  if (!rl.ok)
    return Response.json({ error: "Rate limit exceeded" }, {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const idToken = typeof body.idToken === "string" ? body.idToken : null;
  if (!idToken) return Response.json({ error: "Missing idToken" }, { status: 400 });

  try {
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_CLIENT_ID,
    });
    if (payload.email_verified !== true || typeof payload.email !== "string")
      return Response.json({ error: "Google email not verified" }, { status: 400 });
    const eh = emailHash(payload.email);
    if (!eh) return Response.json({ error: "Invalid email" }, { status: 400 });
    return Response.json({
      emailHash: eh.hashHex,
      hashBytes: eh.hashBytes,
      version: eh.version,
      email: payload.email,
    });
  } catch (e) {
    console.error("google id_token verify failed", e);
    return Response.json({ error: "Invalid Google token" }, { status: 401 });
  }
}
