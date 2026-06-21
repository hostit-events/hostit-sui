// Generate a wallet pass for one ticket.
//   POST /api/wallet-pass/:ticketId   body: { platform, name, dateText?, venue?, serial? }
//   platform=apple  -> returns the signed .pkpass bytes (application/vnd.apple.pkpass)
//   platform=google -> returns { saveUrl } (a signed "Save to Google Wallet" link)
//
// The ticketId in the path is the bare on-chain object id the QR encodes; the
// display fields come from the client (the user's own ticket — the pass is
// cosmetic, the QR carries the authoritative public id). Server-only secrets are
// read inside lib/walletPass.server.ts. Unconfigured provider => 503.

import { buildApplePkpass, buildGoogleSaveUrl, walletCapabilities } from "@/lib/walletPass.server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(req: Request, ctx: { params: Promise<{ ticketId: string }> }) {
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`wallet-pass:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "retry-after": String(rl.retryAfterSec) } },
    );
  }

  const { ticketId } = await ctx.params;
  if (!/^0x[0-9a-fA-F]+$/.test(ticketId)) {
    return Response.json({ error: "Invalid ticket id" }, { status: 400 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Payload too large" }, { status: 413 });
  }
  let body: { platform?: string; name?: string; dateText?: string; venue?: string; serial?: string };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const platform = body.platform;
  const name = (body.name ?? "").trim();
  if (platform !== "apple" && platform !== "google") {
    return Response.json({ error: "platform must be 'apple' or 'google'" }, { status: 400 });
  }
  if (!name) {
    return Response.json({ error: "name is required" }, { status: 400 });
  }

  const caps = walletCapabilities();
  if ((platform === "apple" && !caps.apple) || (platform === "google" && !caps.google)) {
    return Response.json({ error: `${platform} wallet is not configured` }, { status: 503 });
  }

  const data = {
    ticketId,
    name: name.slice(0, 120),
    dateText: body.dateText?.trim().slice(0, 120) || undefined,
    venue: body.venue?.trim().slice(0, 120) || undefined,
    serial: body.serial?.trim().slice(0, 40) || undefined,
  };

  try {
    if (platform === "google") {
      const saveUrl = await buildGoogleSaveUrl(data);
      return Response.json({ saveUrl });
    }
    const pkpass = buildApplePkpass(data);
    return new Response(new Uint8Array(pkpass), {
      headers: {
        "content-type": "application/vnd.apple.pkpass",
        "content-disposition": `attachment; filename="hostit-${ticketId.slice(2, 10)}.pkpass"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    // Log the real cause server-side; return a generic message so we never echo
    // crypto/cert library internals (the cause is server misconfig, not input).
    console.error("wallet-pass generation failed", e);
    return Response.json({ error: "Pass generation failed" }, { status: 500 });
  }
}
