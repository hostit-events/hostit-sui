// Server-only route. Recalls organizer memories similar to a query via the
// MemWal relayer. The browser POSTs {owner, query, limit?}; the lib helper maps
// `owner` to the org namespace and the relayer embeds → searches → downloads →
// decrypts server-side, returning plaintext hits. Holds no secret of its own —
// lib/memwal.ts reads MEMWAL_DELEGATE_KEY / MEMWAL_ACCOUNT_ID server-side and
// gracefully disables when they are unset. Never echoes the delegate key.

import { recallOrganizerMemory } from "@/lib/memwal";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { owner?: string; query?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const query = body.query?.trim();
  if (!owner) return Response.json({ error: "Missing owner" }, { status: 400 });
  if (!query) return Response.json({ error: "Missing query" }, { status: 400 });

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
