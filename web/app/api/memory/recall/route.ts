// Server-only route. Recalls organizer memories similar to a query via the
// MemWal relayer.
//
// AUTH (security fix): the caller must PROVE control of `owner` with a personal-
// message signature. The browser POSTs { owner, message, signature, query, limit? };
// we verify the signature server-side (lib/memwalAuth.ts) and use the VERIFIED
// address as the namespace owner — body.owner is NEVER trusted directly. This
// closes the IDOR hole where any caller could read any organizer's memories by
// sending their address. See memwalAuth for the client signing flow (GH#19).
//
// The relayer embeds → searches → downloads → decrypts server-side, returning
// plaintext hits. Holds no secret of its own — lib/memwal.ts reads
// MEMWAL_DELEGATE_KEY / MEMWAL_ACCOUNT_ID server-side and gracefully disables when
// they are unset. Never echoes the delegate key.

import { recallOrganizerMemory } from "@/lib/memwal";
import { verifyMemoryCaller, isMemoryAuthError } from "@/lib/memwalAuth";
import { rateLimitMemory, clientIpFromHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

// Size cap: reject before touching the relayer (query embedding cost).
const MAX_QUERY_BYTES = 1 * 1024; // 1 KB

export async function POST(req: Request) {
  let body: {
    owner?: string;
    message?: string;
    signature?: string;
    query?: string;
    limit?: number;
  };
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

  // 2) Rate limit per verified identity + per IP.
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimitMemory("recall", owner, ip, {
    limit: 60,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // 3) Validate + size-cap the payload before calling the relayer.
  const query = body.query?.trim();
  if (!query) return Response.json({ error: "Missing query" }, { status: 400 });
  const queryBytes = new TextEncoder().encode(query).length;
  if (queryBytes > MAX_QUERY_BYTES) {
    return Response.json(
      { error: `query exceeds ${MAX_QUERY_BYTES} bytes` },
      { status: 413 },
    );
  }

  const limit =
    typeof body.limit === "number" && Number.isFinite(body.limit)
      ? Math.max(1, Math.min(50, Math.trunc(body.limit)))
      : undefined;

  try {
    const result = await recallOrganizerMemory(owner, query, { limit });
    return Response.json(result);
  } catch (e: unknown) {
    return Response.json(
      { error: e instanceof Error ? e.message : "recall failed" },
      { status: 500 },
    );
  }
}
