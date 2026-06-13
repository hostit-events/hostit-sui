// Server-only route. Analyzes organizer conversation text via the MemWal relayer:
// server-side LLM fact extraction, then each extracted fact is embedded /
// SEAL-encrypted / stored in the background under the org namespace.
//
// AUTH (security fix): this is the COSTLIEST route — it invokes the relayer's LLM.
// The caller must PROVE control of `owner` with a personal-message signature. The
// browser POSTs { owner, message, signature, text }; we verify server-side
// (lib/memwalAuth.ts) and use the VERIFIED address as the namespace owner —
// body.owner is NEVER trusted directly. This closes both the cross-tenant write
// and the unauthenticated LLM-cost-amplification holes. The tightest rate limit
// is applied here. See memwalAuth for the client signing flow (GH#19).
//
// Holds no secret of its own — lib/memwal.ts reads MEMWAL_DELEGATE_KEY /
// MEMWAL_ACCOUNT_ID server-side and gracefully disables when they are unset.
// Never echoes the delegate key.

import { analyzeOrganizerConversation } from "@/lib/memwal";
import { verifyMemoryCaller, isMemoryAuthError } from "@/lib/memwalAuth";
import { rateLimitMemory, clientIpFromHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Size cap: reject before invoking the relayer's LLM (cost amplification).
const MAX_TEXT_BYTES = 16 * 1024; // 16 KB

export async function POST(req: Request) {
  let body: { owner?: string; message?: string; signature?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 1) Server-verified identity FIRST (before the disabled check, per spec).
  let owner: string;
  try {
    owner = await verifyMemoryCaller(body);
  } catch (e: unknown) {
    if (isMemoryAuthError(e)) {
      return Response.json({ error: e.message }, { status: 401 });
    }
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2) Rate limit per verified identity + per IP — tightest budget (LLM cost).
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimitMemory("analyze", owner, ip, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // 3) Validate + size-cap the payload before invoking the LLM.
  const text = body.text?.trim();
  if (!text) return Response.json({ error: "Missing text" }, { status: 400 });
  const textBytes = new TextEncoder().encode(text).length;
  if (textBytes > MAX_TEXT_BYTES) {
    return Response.json(
      { error: `text exceeds ${MAX_TEXT_BYTES} bytes` },
      { status: 413 },
    );
  }

  try {
    const result = await analyzeOrganizerConversation(owner, text);
    return Response.json(result);
  } catch (e: unknown) {
    return Response.json(
      { error: e instanceof Error ? e.message : "analyze failed" },
      { status: 500 },
    );
  }
}
