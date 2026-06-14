// Server-only route. Reports whether the MemWal memory layer is enabled
// server-side (MEMWAL_DELEGATE_KEY + MEMWAL_ACCOUNT_ID present, via memwalEnabled()).
//
// UNSIGNED + UNAUTHENTICATED on purpose: it reveals ONLY a boolean
// config-presence flag — never the delegate key or any secret. The client uses
// it to decide whether memory features are live, so it can avoid prompting the
// user for a signature (e.g. recall-on-open) when the server layer is off.

import { memwalEnabled } from "@/lib/memwal";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ enabled: memwalEnabled() });
}
