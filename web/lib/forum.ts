// Per-event forum: messages are Seal-encrypted (ticket-gated), stored on Walrus,
// and anchored on-chain via `forum::post`. Readers query PostCreated events and
// decrypt bodies they're authorized for.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import type { SessionKey } from "@mysten/seal";
import { PACKAGE_ID, CLOCK_ID } from "./config";
import { storeBlob, readBlob } from "./walrus";
import { sealEncrypt, sealDecrypt, approveTicket } from "./seal";

export const EV_FORUM_POST = `${PACKAGE_ID}::forum::PostCreated`;

export const FORUM_CHANNELS = [
  { id: "general", label: "general", icon: "ic:round-tag" },
  { id: "lineup", label: "lineup", icon: "ion:musical-notes" },
  { id: "rideshare", label: "ride-share", icon: "ic:round-directions-car" },
  { id: "market", label: "market", icon: "ic:round-sell" },
];

export interface ForumBody {
  text: string;
  author: string;
  ts: number;
}

/** Encrypt a message body for an event (ticket-gated) and store on Walrus. */
export async function encryptForumMessage(
  suiClient: any,
  eventId: string,
  body: ForumBody,
): Promise<string> {
  const { id, ciphertext } = await sealEncrypt(
    suiClient,
    eventId,
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const envelope = JSON.stringify({ id, ct: toBase64(ciphertext) });
  return storeBlob(new TextEncoder().encode(envelope));
}

export function forumPostTx(
  eventId: string,
  ticketId: string,
  channel: string,
  blobId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::forum::post`,
    arguments: [
      tx.object(eventId),
      tx.object(ticketId),
      tx.pure.string(channel),
      tx.pure.string(blobId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/** Fetch + decrypt a message body. Requires a SessionKey and a ticket for the event. */
export async function decryptForumMessage(
  suiClient: any,
  sessionKey: SessionKey,
  blobId: string,
  ticketId: string,
  eventId: string,
): Promise<ForumBody> {
  const env = JSON.parse(new TextDecoder().decode(await readBlob(blobId))) as {
    id: string;
    ct: string;
  };
  const ct = fromBase64(env.ct);
  const pt = await sealDecrypt(suiClient, sessionKey, ct, (tx) =>
    approveTicket(tx, env.id, ticketId, eventId),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as ForumBody;
}
