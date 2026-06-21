/**
 * P0-C empirical Seal check (GH#96): proves the LIVE committee key server grants
 * — and denies — email decryption per our on-chain policies, end to end.
 *
 *   bun run scripts/seal-email-smoke.ts     # from web/
 *
 * The deployer key plays BOTH organizer and attendee (it creates an event, mints
 * an EmailGrant for it, and encrypts its own email). We then attempt 4 decrypts
 * against the real key server:
 *   1. own-email id  via seal_approve_own_email        → MUST succeed
 *   2. own-email id  via seal_approve_attendee_email   → MUST succeed (organizer+grant)
 *   3. bare-self id  via seal_approve_attendee_email   → MUST FAIL (KYC isolation, P0-B)
 *   4. own-email id  via seal_approve_attendee_email w/o the grant arg is N/A (grant required)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Keypair } from "@mysten/sui/cryptography";
import { createEventTx } from "../lib/ticketing";
import { grantEmailAccessTx } from "../lib/identity";
import {
  makeSealClient,
  makeEmailSealId,
  makeSealId,
  createSessionKey,
  sealDecrypt,
  approveOwnEmail,
  approveAttendeeEmail,
} from "../lib/seal";
import { PACKAGE_ID } from "../lib/config";

const SENDER = "0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9";
const HOUR = 3_600_000;
const DAY = 86_400_000;

function loadCliKeypair(expected: string): Keypair {
  const entries: string[] = JSON.parse(
    readFileSync(join(homedir(), ".sui", "sui_config", "sui.keystore"), "utf8"),
  );
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
    if (kp && kp.toSuiAddress() === expected) return kp;
  }
  throw new Error(`No keystore entry derives to ${expected}`);
}

function createdId(res: { objectChanges?: unknown }, suffix: string): string | null {
  const changes = (res.objectChanges ?? []) as { type?: string; objectType?: string; objectId?: string }[];
  return changes.find((c) => c.type === "created" && c.objectType?.includes(suffix))?.objectId ?? null;
}

async function main() {
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" });
  const kp = loadCliKeypair(SENDER);
  const sign = async (m: Uint8Array) => {
    const { signature } = await kp.signPersonalMessage(m);
    return { signature };
  };

  // 1) Create a throwaway event (deployer = organizer).
  const now = Date.now();
  const evTx = createEventTx(
    {
      name: "Seal Smoke",
      symbol: "SEAL",
      uri: "smoke",
      startMs: BigInt(now + HOUR),
      endMs: BigInt(now + DAY),
      purchaseStartMs: BigInt(now),
      maxTickets: 10n,
      maxPerUser: 5n,
      isFree: true,
      isRefundable: false,
    },
    SENDER,
  );
  evTx.setSender(SENDER);
  const evRes = await client.signAndExecuteTransaction({
    transaction: evTx,
    signer: kp,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.core.waitForTransaction({ digest: evRes.digest });
  const eventId = createdId(evRes, "::event::Event");
  const capId = createdId(evRes, "::event::OrganizerCap");
  if (!eventId || !capId) throw new Error("event/cap not found in objectChanges");
  console.log(`event ${eventId}\ncap   ${capId}`);

  // 2) Mint an EmailGrant for this event (deployer = attendee).
  const grantTx = grantEmailAccessTx(eventId);
  grantTx.setSender(SENDER);
  const grantRes = await client.signAndExecuteTransaction({
    transaction: grantTx,
    signer: kp,
    options: { showObjectChanges: true, showEffects: true },
  });
  await client.core.waitForTransaction({ digest: grantRes.digest });
  const grantId = createdId(grantRes, "::identity::EmailGrant");
  if (!grantId) throw new Error("grant not found");
  console.log(`grant ${grantId}`);

  // 3) Encrypt the deployer's email under the EMAIL namespace, and a decoy under
  //    the bare-self namespace (the KYC/drafts namespace).
  const sealClient = makeSealClient(client);
  const emailId = makeEmailSealId(SENDER);
  const selfId = makeSealId(SENDER);
  const PLAINTEXT = "p0c-smoke@hostit.events";
  const enc = async (id: string) =>
    (
      await sealClient.encrypt({
        threshold: 1,
        packageId: PACKAGE_ID,
        id,
        data: new TextEncoder().encode(PLAINTEXT),
      })
    ).encryptedObject as Uint8Array;
  const emailCt = await enc(emailId);
  const selfCt = await enc(selfId);

  const sk = await createSessionKey(client, SENDER, sign);
  const dec = new TextDecoder();
  const tryDecrypt = async (label: string, ct: Uint8Array, build: (tx: import("@mysten/sui/transactions").Transaction) => void) => {
    try {
      const pt = dec.decode(await sealDecrypt(client, sk, ct, build));
      return { label, ok: pt === PLAINTEXT, detail: pt === PLAINTEXT ? "decrypted" : `wrong: ${pt}` };
    } catch (e) {
      return { label, ok: false, detail: `denied: ${(e as Error).message?.slice(0, 80)}` };
    }
  };

  const r1 = await tryDecrypt("own-email via own_email", emailCt, (tx) => approveOwnEmail(tx, emailId));
  const r2 = await tryDecrypt("own-email via attendee_email", emailCt, (tx) =>
    approveAttendeeEmail(tx, emailId, capId, eventId, grantId),
  );
  const r3 = await tryDecrypt("self/KYC via attendee_email", selfCt, (tx) =>
    approveAttendeeEmail(tx, selfId, capId, eventId, grantId),
  );

  console.log("\n=== results ===");
  console.log(`1. owner decrypts own email          : ${r1.ok ? "PASS" : "FAIL"} (${r1.detail})`);
  console.log(`2. organizer+grant decrypts email    : ${r2.ok ? "PASS" : "FAIL"} (${r2.detail})  <- P0-C`);
  console.log(`3. organizer+grant CANNOT read KYC ns: ${!r3.ok ? "PASS" : "FAIL"} (${r3.detail})  <- P0-B`);

  const allPass = r1.ok && r2.ok && !r3.ok;
  console.log(`\n${allPass ? "ALL PASS ✅" : "SOME FAILED ❌"}`);
  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error("smoke failed:", e);
  process.exit(1);
});
