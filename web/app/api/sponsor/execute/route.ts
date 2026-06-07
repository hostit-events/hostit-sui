// Server-only route. Forwards the user-signed sponsored tx to Enoki for
// execution. Returns the final on-chain digest.

import { EnokiClient } from "@mysten/enoki";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Server is missing ENOKI_PRIVATE_API_KEY" },
      { status: 500 },
    );
  }

  let body: { digest?: string; signature?: string };
  try {
    body = await req.json();
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
    return Response.json(
      {
        error: e.message ?? "Enoki executeSponsoredTransaction failed",
        details: e.errors,
      },
      { status: e.status ?? 500 },
    );
  }
}
