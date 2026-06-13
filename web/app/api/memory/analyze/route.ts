// Server-only route. Analyzes organizer conversation text via the MemWal
// relayer: server-side LLM fact extraction, then each extracted fact is
// embedded / SEAL-encrypted / stored in the background under the org namespace.
// The browser POSTs {owner, text}. Holds no secret of its own — lib/memwal.ts
// reads MEMWAL_DELEGATE_KEY / MEMWAL_ACCOUNT_ID server-side and gracefully
// disables when they are unset. Never echoes the delegate key.

import { analyzeOrganizerConversation } from "@/lib/memwal";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { owner?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const owner = body.owner?.trim();
  const text = body.text?.trim();
  if (!owner) return Response.json({ error: "Missing owner" }, { status: 400 });
  if (!text) return Response.json({ error: "Missing text" }, { status: 400 });

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
