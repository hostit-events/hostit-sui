// /api/identity/profile-pointer — the non-sensitive `profile:<addr> → blobId`
// pointer (GH#96). GET is open (a blobId is not PII). PUT requires a wallet
// personal-message signature so only the owner can set their own pointer; a
// SuiClient is passed so zkLogin (Google) signatures verify too.

export const dynamic = "force-dynamic";

import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { rpcUrl } from "@/lib/config";
import { getKv, kvEnabled } from "@/lib/kvStore";
import { rateLimitMemory, clientIpFromHeaders } from "@/lib/rateLimit";
import { profilePointerMessage } from "@/lib/accountMessages";
import { isBlobId } from "@/lib/walrus";

const MAX_BODY_BYTES = 4 * 1024;
const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

let cachedClient: SuiJsonRpcClient | null = null;
function suiClient(): SuiJsonRpcClient {
  const net = NETWORK === "localnet" ? "testnet" : NETWORK;
  if (!cachedClient) cachedClient = new SuiJsonRpcClient({ url: rpcUrl(net), network: net });
  return cachedClient;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function GET(req: Request) {
  if (!kvEnabled()) return Response.json({ blobId: null });
  const address = new URL(req.url).searchParams.get("address");
  if (!address) return Response.json({ error: "address required" }, { status: 400 });
  const blobId = (await getKv()?.get(`profile:${normalizeSuiAddress(address)}`)) ?? null;
  return Response.json({ blobId });
}

export async function PUT(req: Request) {
  if (!kvEnabled())
    return Response.json({ error: "Profile storage isn't configured." }, { status: 503 });

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
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const address = str(body.address);
  const blobId = str(body.blobId);
  const signature = str(body.signature);
  if (!address || !blobId || !signature) return Response.json({ error: "Missing fields" }, { status: 400 });
  if (!isBlobId(blobId)) return Response.json({ error: "Invalid blobId" }, { status: 400 });

  const addr = normalizeSuiAddress(address);
  const rl = rateLimitMemory("profile-ptr", addr, ip, { limit: 10, windowMs: 60_000 });
  if (!rl.ok)
    return Response.json({ error: "Rate limit exceeded" }, {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSec) },
    });

  const message = new TextEncoder().encode(profilePointerMessage(addr, blobId));
  let signer: string;
  try {
    const pub = await verifyPersonalMessageSignature(message, signature, { client: suiClient() });
    signer = normalizeSuiAddress(pub.toSuiAddress());
  } catch {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  if (signer !== addr) return Response.json({ error: "Signature address mismatch" }, { status: 401 });

  await getKv()?.set(`profile:${addr}`, blobId);
  return Response.json({ ok: true });
}
