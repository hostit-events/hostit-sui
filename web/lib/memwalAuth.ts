// HostIt MemWal — server-side caller authentication for the /api/memory/* routes.
//
// SERVER-ONLY. The `server-only` import makes Next.js fail the build if this is
// ever pulled into a Client Component. It performs no secret handling itself but
// it gates every memory mutation/read, so it must never run in the browser.
//
// WHY THIS EXISTS (security): the original routes took `owner` straight from the
// request body and used it as the memory namespace key. That is a broken-access /
// IDOR hole — any caller could read, poison, or run LLM cost on ANY organizer's
// namespace just by sending their address. This module forces the caller to PROVE
// control of `owner` with a personal-message signature before the routes derive
// the namespace from the VERIFIED address.
//
// EXPECTED CLIENT SIGNING FLOW (there is no client caller yet — GH#19 will wire
// it; requiring {message,signature} now is a non-breaking contract change):
//   1. Client builds the canonical challenge string:
//        buildMemoryChallenge(ownerAddress, Date.now())
//      => "HostIt-MemWal:auth:v1\nowner=0x<64hex>\nts=<unixMs>"
//   2. Client signs the UTF-8 bytes of that string as a PERSONAL MESSAGE with the
//      organizer's wallet / zkLogin / Enoki key (wallet.signPersonalMessage).
//   3. Client POSTs { owner, message, signature, ...payload } to the route.
//   4. Server calls verifyMemoryCaller(body): it verifies the signature over the
//      exact message bytes, re-parses the challenge, enforces a ~5 min replay
//      window, recovers the signer address, and asserts it equals `owner`. The
//      VERIFIED address is what the routes use as the namespace owner.
//
// zkLogin/Enoki: verifyPersonalMessageSignature is given a testnet SuiClient so
// ZkLogin signatures (which need on-chain state to resolve) verify as well as
// plain Ed25519/Secp256k1 wallet signatures.

import "server-only";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { NETWORK } from "@/lib/config";
import { canonicalizeSuiAddress } from "@/lib/memwal";

/** Domain/intent tag for the personal-message challenge. Bump the suffix to
 * invalidate all previously-signed challenges. */
export const MEMORY_CHALLENGE_DOMAIN = "HostIt-MemWal:auth:v1";

/** Replay window: a signed challenge older than this is rejected. */
export const MEMORY_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
/** Reject timestamps too far in the future (clock skew tolerance). */
const MEMORY_CHALLENGE_FUTURE_SKEW_MS = 60 * 1000; // 1 minute

/** Typed auth error so route handlers can map it to HTTP 401. */
export class MemoryAuthError extends Error {
  readonly status = 401 as const;
  constructor(message: string) {
    super(message);
    this.name = "MemoryAuthError";
  }
}

export function isMemoryAuthError(e: unknown): e is MemoryAuthError {
  return e instanceof MemoryAuthError;
}

/**
 * Build the canonical challenge string a client must sign. Kept here (not just in
 * a comment) so client code can import the exact same builder once GH#19 lands —
 * the server and client MUST agree byte-for-byte.
 */
export function buildMemoryChallenge(owner: string, tsMs: number): string {
  return `${MEMORY_CHALLENGE_DOMAIN}\nowner=${owner}\nts=${tsMs}`;
}

// One shared read-only client for signature verification. zkLogin verification
// needs fullnode access to resolve the address; plain wallet sigs do not, but a
// single client is harmless and avoids per-request construction. We map localnet
// to testnet for the public fullnode URL (mirrors lib/dapp-kit.ts).
const verifyNetwork = NETWORK === "localnet" ? "testnet" : NETWORK;
let cachedClient: SuiJsonRpcClient | null = null;
function getVerifyClient(): SuiJsonRpcClient {
  if (!cachedClient) {
    cachedClient = new SuiJsonRpcClient({
      url: getJsonRpcFullnodeUrl(verifyNetwork),
      network: verifyNetwork,
    });
  }
  return cachedClient;
}

/** Parse + validate the canonical challenge. Returns the asserted owner. */
function parseChallenge(message: string, expectedOwner: string): void {
  const lines = message.split("\n");
  if (lines.length !== 3 || lines[0] !== MEMORY_CHALLENGE_DOMAIN) {
    throw new MemoryAuthError("Malformed auth challenge");
  }
  const ownerMatch = /^owner=(0x[0-9a-fA-F]{1,64})$/.exec(lines[1]);
  const tsMatch = /^ts=(\d{1,20})$/.exec(lines[2]);
  if (!ownerMatch || !tsMatch) {
    throw new MemoryAuthError("Malformed auth challenge");
  }

  // The address embedded in the message must canonicalize to the same value as
  // the body `owner` — prevents a valid signature over address A being replayed
  // to write into namespace B.
  let challengeOwner: string;
  try {
    challengeOwner = canonicalizeSuiAddress(ownerMatch[1]);
  } catch {
    throw new MemoryAuthError("Invalid owner in auth challenge");
  }
  if (challengeOwner !== expectedOwner) {
    throw new MemoryAuthError("Auth challenge owner mismatch");
  }

  const ts = Number(tsMatch[1]);
  if (!Number.isSafeInteger(ts)) {
    throw new MemoryAuthError("Invalid auth challenge timestamp");
  }
  const now = Date.now();
  if (ts > now + MEMORY_CHALLENGE_FUTURE_SKEW_MS) {
    throw new MemoryAuthError("Auth challenge timestamp is in the future");
  }
  if (now - ts > MEMORY_CHALLENGE_MAX_AGE_MS) {
    throw new MemoryAuthError("Auth challenge expired (replay window)");
  }
}

/** The signed-request envelope every /api/memory/* route now requires. */
export interface MemoryAuthBody {
  owner?: unknown;
  message?: unknown;
  signature?: unknown;
}

/**
 * Verify that the caller controls `body.owner`, and return the VERIFIED Sui
 * address (canonicalized). Routes MUST use this return value as the namespace
 * owner and never trust `body.owner` directly.
 *
 * Throws MemoryAuthError (-> HTTP 401) on any failure: missing fields, bad
 * address, malformed/expired challenge, invalid signature, or signer != owner.
 */
export async function verifyMemoryCaller(body: MemoryAuthBody): Promise<string> {
  const ownerRaw = body.owner;
  const message = body.message;
  const signature = body.signature;

  if (typeof ownerRaw !== "string" || !ownerRaw) {
    throw new MemoryAuthError("Missing owner");
  }
  if (typeof message !== "string" || !message) {
    throw new MemoryAuthError("Missing signed challenge message");
  }
  if (typeof signature !== "string" || !signature) {
    throw new MemoryAuthError("Missing signature");
  }

  // Defense in depth: canonicalize/validate the claimed owner up front (same
  // strict 0x+64hex rule the namespace builder applies).
  let owner: string;
  try {
    owner = canonicalizeSuiAddress(ownerRaw);
  } catch (e) {
    throw new MemoryAuthError(
      e instanceof Error ? e.message : "Invalid owner address",
    );
  }

  // The message bytes the client signed are the UTF-8 bytes of the challenge.
  const messageBytes = new TextEncoder().encode(message);

  let publicKey;
  try {
    publicKey = await verifyPersonalMessageSignature(messageBytes, signature, {
      client: getVerifyClient(),
    });
  } catch {
    // Do not leak verifier internals.
    throw new MemoryAuthError("Invalid signature");
  }

  // Recover the signer address from the verified key and require it to match the
  // claimed owner. Canonicalize both sides before comparing.
  let signer: string;
  try {
    signer = canonicalizeSuiAddress(publicKey.toSuiAddress());
  } catch {
    throw new MemoryAuthError("Could not derive signer address");
  }
  if (signer !== owner) {
    throw new MemoryAuthError("Signer does not match owner");
  }

  // Only now (signature proven) enforce the challenge structure + replay window.
  parseChallenge(message, owner);

  return owner;
}
