// POST /api/identity/lookup-email — resolve an email → the wallet address that
// registered it (GH#96, door/will-call lookup). HMACs the email with the server
// pepper and reads identity::owner_of off-chain via devInspect. Rate-limited +
// Turnstile, because this is a registration/ownership oracle (the on-chain table
// is public, but this resolves email→address without the pepper).

export const dynamic = "force-dynamic";

import { Transaction } from "@mysten/sui/transactions";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { emailHash, emailHashConfigured } from "@/lib/emailHash";
import { EMAIL_REGISTRY_ID, target } from "@/lib/config";
import { clientIpFromHeaders, rateLimitMemory } from "@/lib/rateLimit";
import { verifyTurnstile, blockedByTurnstile } from "@/lib/turnstile";

const MAX_BODY_BYTES = 4 * 1024;
const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

let cachedClient: SuiJsonRpcClient | null = null;
function suiClient(): SuiJsonRpcClient {
  const net = NETWORK === "localnet" ? "testnet" : NETWORK;
  if (!cachedClient) cachedClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(net), network: net });
  return cachedClient;
}

export async function POST(req: Request) {
  if (!emailHashConfigured() || !EMAIL_REGISTRY_ID)
    return Response.json({ error: "Email lookup isn't configured." }, { status: 503 });

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
  const rl = rateLimitMemory("email-lookup", ip, ip, { limit: 20, windowMs: 60_000 });
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
  const email = typeof body.email === "string" ? body.email : null;
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : null;
  if (!email) return Response.json({ error: "Missing email" }, { status: 400 });

  if (blockedByTurnstile(await verifyTurnstile(turnstileToken, ip)))
    return Response.json({ error: "Bot check failed." }, { status: 403 });

  const eh = emailHash(email);
  if (!eh) return Response.json({ error: "Enter a valid email." }, { status: 400 });

  // devInspect identity::owner_of(registry, hash) — aborts (→ no return value) if
  // the email isn't registered, which we surface as { address: null }.
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: target("identity", "owner_of"),
      arguments: [tx.object(EMAIL_REGISTRY_ID), tx.pure.vector("u8", eh.hashBytes)],
    });
    const res = await suiClient().devInspectTransactionBlock({ sender: ZERO, transactionBlock: tx });
    const rv = (res as { results?: { returnValues?: [number[], string][] }[] } | null)?.results?.[0]
      ?.returnValues?.[0];
    if (!rv) return Response.json({ address: null });
    const address = normalizeSuiAddress("0x" + Buffer.from(rv[0]).toString("hex"));
    return Response.json({ address });
  } catch {
    return Response.json({ address: null });
  }
}
