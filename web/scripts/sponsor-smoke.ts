/**
 * Standalone Enoki sponsored-transaction smoke (server-side).
 *
 *   bun run smoke:sponsor   # from web/
 *
 * Mirrors what /api/sponsor + /api/sponsor/execute do, calling Enoki directly
 * with the **private** API key. Verifies the API contract independently of
 * the route handlers so a failure isolates Enoki-side issues (missing
 * allowlist, drained sponsor balance, etc.) vs. dapp wiring bugs.
 *
 * Pre-conditions in `web/.env.local`:
 *   - ENOKI_PRIVATE_API_KEY=enoki_private_...
 *
 * Enoki portal setup:
 *   1. Sponsored Transactions enabled for the project. The per-request allowlist
 *      below mirrors the app (SPONSORED_TARGETS in lib/config.ts); this smoke
 *      exercises `event::create_event` on the current package.
 *   2. Fund the testnet sponsor from the portal (one-click).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnokiClient } from "@mysten/enoki";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Keypair } from "@mysten/sui/cryptography";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

const SENDER = "0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9";
const PACKAGE_ID =
  process.env.NEXT_PUBLIC_HOSTIT_PACKAGE_ID ??
  "0x7816f65c8fb05298df91fe25065b82ada0f61d8020d5673376ad02ecefcd314c";
const HUB_ID =
  process.env.NEXT_PUBLIC_HOSTIT_HUB_ID ??
  "0x9468930839c11fdad73e739a4052d1fe9367bd8ea98dd3f7198bade074138514";
const CLOCK_ID = "0x6";
const ENOKI_PRIVATE_API_KEY = process.env.ENOKI_PRIVATE_API_KEY ?? "";

if (!ENOKI_PRIVATE_API_KEY) {
  console.error(
    "Set ENOKI_PRIVATE_API_KEY in web/.env.local (no NEXT_PUBLIC_ prefix).\n" +
      "Get a private key at https://portal.enoki.mysten.app/ → your project → API Keys.",
  );
  process.exit(2);
}

function loadCliKeypair(expectedAddress: string): Keypair {
  const path = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const entries: string[] = JSON.parse(readFileSync(path, "utf8"));
  for (const e of entries) {
    let kp: Keypair | null = null;
    if (e.startsWith("suiprivkey")) {
      const { secretKey, scheme } = decodeSuiPrivateKey(e);
      if (scheme === "ED25519") kp = Ed25519Keypair.fromSecretKey(secretKey);
      else if (scheme === "Secp256k1") kp = Secp256k1Keypair.fromSecretKey(secretKey);
      else if (scheme === "Secp256r1") kp = Secp256r1Keypair.fromSecretKey(secretKey);
    } else {
      const bytes = Buffer.from(e, "base64");
      const secret = bytes.subarray(1);
      if (bytes[0] === 0) kp = Ed25519Keypair.fromSecretKey(secret);
      else if (bytes[0] === 1) kp = Secp256k1Keypair.fromSecretKey(secret);
      else if (bytes[0] === 2) kp = Secp256r1Keypair.fromSecretKey(secret);
    }
    if (kp && kp.toSuiAddress() === expectedAddress) return kp;
  }
  throw new Error(`No keystore entry derives to ${expectedAddress}`);
}

async function main() {
  const client = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl("testnet"),
    network: "testnet",
  });
  const enoki = new EnokiClient({ apiKey: ENOKI_PRIVATE_API_KEY });
  const kp = loadCliKeypair(SENDER);

  console.log(`Sender: ${SENDER}`);
  console.log(`Package: ${PACKAGE_ID}`);
  console.log();

  // Sponsored smoke target: a real, permissionless, self-contained entry fn on
  // the current package — needs only the shared Hub + Clock + pure args. Creates
  // one free test event and transfers the OrganizerCap back to the sender.
  const now = Date.now();
  const start = now + 60_000;
  const end = start + 3_600_000;
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: `${PACKAGE_ID}::event::create_event`,
    arguments: [
      tx.object(HUB_ID),
      tx.pure.string("Sponsored Smoke Event"),
      tx.pure.string("SMOKE"),
      tx.pure.string("smoke"),
      tx.pure.u64(start),
      tx.pure.u64(end),
      tx.pure.u64(now),
      tx.pure.u64(10),
      tx.pure.u64(2),
      tx.pure.bool(true), // is_free — no price needed for the smoke
      tx.pure.bool(false), // is_refundable
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([cap], SENDER);
  tx.setSender(SENDER);

  const kindBytes = await tx.build({ client, onlyTransactionKind: true });
  console.log(`[1/3] built tx kind bytes: ${kindBytes.length} bytes`);

  const sponsored = await enoki.createSponsoredTransaction({
    network: "testnet",
    transactionKindBytes: toBase64(kindBytes),
    sender: SENDER,
    allowedMoveCallTargets: [`${PACKAGE_ID}::event::create_event`],
  });
  console.log(`[2/3] enoki sponsored; digest=${sponsored.digest}`);

  const txBytes = fromBase64(sponsored.bytes);
  const { signature } = await kp.signTransaction(txBytes);
  const result = await enoki.executeSponsoredTransaction({
    digest: sponsored.digest,
    signature,
  });
  console.log(`[3/3] executed; digest=${result.digest}`);
  console.log();

  await client.core.waitForTransaction({ digest: result.digest });
  const onChain = await client.getTransactionBlock({
    digest: result.digest,
    options: { showInput: true, showEffects: true },
  });
  const data = onChain.transaction?.data as
    | { gasData?: { owner?: string }; sender?: string }
    | undefined;
  const gasOwner = data?.gasData?.owner ?? "(unknown)";
  const sender = data?.sender ?? "(unknown)";
  console.log(`sender (signs the data): ${sender}`);
  console.log(`gas owner (sponsor):     ${gasOwner}`);
  console.log(`distinct signers:        ${sender !== gasOwner ? "yes ✓" : "no ✗"}`);
  console.log();
  console.log(`https://suiscan.xyz/testnet/tx/${result.digest}`);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  if (err?.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
});
