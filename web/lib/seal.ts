// Seal threshold encryption — protects sensitive data (forum messages, KYC/PII)
// with on-chain access policies (the `access::seal_approve_*` functions). Encrypt
// client-side, store ciphertext on Walrus, decrypt only if the caller satisfies
// the policy (owns a ticket / is the organizer / is the data owner).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { SealClient, SessionKey } from "@mysten/seal";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { PACKAGE_ID, SEAL_AGGREGATOR_URL, SEAL_KEY_SERVER_ID, SEAL_VERIFY_KEY_SERVERS } from "./config";

export function makeSealClient(suiClient: any): SealClient {
  return new SealClient({
    suiClient,
    // The MystenLabs testnet key server is a V2 *Committee* server, so its config
    // MUST include the aggregator URL (the SDK throws "requires aggregatorUrl in
    // config" otherwise). Independent/V1 servers must NOT set it.
    serverConfigs: [
      { objectId: SEAL_KEY_SERVER_ID, weight: 1, aggregatorUrl: SEAL_AGGREGATOR_URL },
    ],
    verifyKeyServers: SEAL_VERIFY_KEY_SERVERS, // on for every network except localnet
  } as any);
}

/** Seal identity = policy-object-id (or address) bytes ‖ random nonce. */
export function makeSealId(policyObjectIdOrAddr: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(5));
  return toHex(new Uint8Array([...fromHex(policyObjectIdOrAddr), ...nonce]));
}

/** Domain-separation tag for ORGANIZER-ONLY Seal identities. MUST equal
 *  `ORG_NS_TAG` in sources/access.move so the on-chain policy matches. A Seal
 *  id built with this tag satisfies `seal_approve_organizer` but NOT
 *  `seal_approve_ticket` (whose check is `is_prefix(event_id, id)`), so a
 *  ticket holder cannot decrypt organizer-only ciphertext. */
export const ORG_NS_TAG = new TextEncoder().encode("hostit-org:"); // == b"hostit-org:" in access.move

/** Seal identity for ORGANIZER-ONLY data: ORG_NS_TAG ‖ event-id bytes ‖ nonce.
 *  Use this (not the bare event id) whenever you encrypt data that ONLY the
 *  organizer may read (e.g. an attendee/KYC list). Shared content readable by
 *  ticket holders must keep using the bare event id (see makeSealId). */
export function makeOrganizerSealId(eventId: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(5));
  return toHex(new Uint8Array([...ORG_NS_TAG, ...fromHex(eventId), ...nonce]));
}

export async function sealEncrypt(
  suiClient: any,
  policyObjectIdOrAddr: string,
  plaintext: Uint8Array,
): Promise<{ id: string; ciphertext: Uint8Array }> {
  const client = makeSealClient(suiClient);
  const id = makeSealId(policyObjectIdOrAddr);
  const { encryptedObject } = await client.encrypt({
    threshold: 1,
    packageId: PACKAGE_ID,
    id,
    data: plaintext,
  });
  return { id, ciphertext: encryptedObject as unknown as Uint8Array };
}

/** Browser SessionKey: created unsigned, then signed via the wallet's
 * signPersonalMessage. Valid ~10 min; reuse across decrypts. */
export async function createSessionKey(
  suiClient: any,
  address: string,
  signPersonalMessage: (message: Uint8Array) => Promise<{ signature: string }>,
): Promise<SessionKey> {
  const sk: any = await (SessionKey as any).create({
    address,
    packageId: PACKAGE_ID,
    ttlMin: 10,
    suiClient,
  });
  const msg: Uint8Array = sk.getPersonalMessage();
  const { signature } = await signPersonalMessage(msg);
  await sk.setPersonalMessageSignature(signature);
  return sk as SessionKey;
}

// === seal_approve PTB builders (dry-run by Seal key servers) ===

export function approveTicket(tx: Transaction, id: string, ticketId: string, eventId: string) {
  tx.moveCall({
    target: `${PACKAGE_ID}::access::seal_approve_ticket`,
    arguments: [tx.pure.vector("u8", Array.from(fromHex(id))), tx.object(ticketId), tx.object(eventId)],
  });
}

export function approveSelf(tx: Transaction, id: string) {
  tx.moveCall({
    target: `${PACKAGE_ID}::access::seal_approve_self`,
    arguments: [tx.pure.vector("u8", Array.from(fromHex(id)))],
  });
}

/** Organizer-gated decrypt: caller holds the event's OrganizerCap. Lives in the
 *  `access` module at PACKAGE_ID. `seal_approve_organizer` accepts the
 *  organizer-only namespace (ORG_NS_TAG ‖ event_id; see makeOrganizerSealId)
 *  AND the bare event-id namespace (shared forum content). It is NOT
 *  interchangeable with the ticket policy for organizer-only ids: a tagged
 *  organizer id does NOT satisfy seal_approve_ticket. */
export function approveOrganizer(tx: Transaction, id: string, capId: string, eventId: string) {
  tx.moveCall({
    target: `${PACKAGE_ID}::access::seal_approve_organizer`,
    arguments: [tx.pure.vector("u8", Array.from(fromHex(id))), tx.object(capId), tx.object(eventId)],
  });
}

export async function sealDecrypt(
  suiClient: any,
  sessionKey: SessionKey,
  ciphertext: Uint8Array,
  buildApprove: (tx: Transaction) => void,
): Promise<Uint8Array> {
  const client = makeSealClient(suiClient);
  const tx = new Transaction();
  buildApprove(tx);
  const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
  return await client.decrypt({ data: ciphertext, sessionKey, txBytes });
}
