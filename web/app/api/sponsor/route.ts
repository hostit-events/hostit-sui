// Server-only route. Holds the private Enoki API key.
// Receives a transaction-kind from the client, asks Enoki to sponsor, returns
// the sponsor-signed bytes + digest. The client signs the bytes locally and
// sends them to /api/sponsor/execute.

import { EnokiClient } from "@mysten/enoki";
import { NETWORK, SPONSORED_TARGETS } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Server is missing ENOKI_PRIVATE_API_KEY. Add it to web/.env.local (do not prefix with NEXT_PUBLIC_).",
      },
      { status: 500 },
    );
  }

  let body: { transactionKindBytes?: string; sender?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { transactionKindBytes, sender } = body;
  if (!transactionKindBytes || !sender) {
    return Response.json(
      { error: "Missing transactionKindBytes or sender" },
      { status: 400 },
    );
  }

  const enokiNetwork = NETWORK === "localnet" ? "testnet" : NETWORK;
  const enoki = new EnokiClient({ apiKey });

  try {
    const sponsored = await enoki.createSponsoredTransaction({
      network: enokiNetwork,
      transactionKindBytes,
      sender,
      allowedMoveCallTargets: SPONSORED_TARGETS as string[],
    });
    return Response.json(sponsored);
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; errors?: unknown };
    return Response.json(
      {
        error: e.message ?? "Enoki createSponsoredTransaction failed",
        details: e.errors,
      },
      { status: e.status ?? 500 },
    );
  }
}
