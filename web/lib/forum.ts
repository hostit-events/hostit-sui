// Per-event forum: messages are Seal-encrypted, stored on Walrus, and anchored
// on-chain via `forum::post` (ticket holders) or `forum::post_as_organizer` (the
// event's organizer). Organizers also `forum::moderate` (hide/pin) — tombstones
// clients fold over the immutable post log. Readers query PostCreated +
// PostModerated and decrypt bodies they're authorized for (ticket OR organizer).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import type { SessionKey } from "@mysten/seal";
import { PACKAGE_ID, CLOCK_ID } from "./config";
import { storeBlob, readBlob } from "./walrus";
import { sealEncrypt, sealDecrypt, approveTicket, approveOrganizer } from "./seal";

export const EV_FORUM_POST = `${PACKAGE_ID}::forum::PostCreated`;
// PostModerated lives in the single package (fresh-publish model).
export const EV_FORUM_MODERATED = `${PACKAGE_ID}::forum::PostModerated`;

export interface ForumChannel {
  id: string;
  label: string;
  icon: string;
  /** Organizer-only channel: only the event organizer posts; everyone else reads.
   *  Enforced client-side — the composer is hidden for non-organizers AND the feed
   *  is filtered to organizer-authored posts, so a ticket holder can't inject by
   *  crafting a raw `post` with this channel string. (The Move layer already
   *  supports organizer posting via `post_as_organizer`.) */
  organizerOnly?: boolean;
}

export const FORUM_CHANNELS: ForumChannel[] = [
  { id: "announcement", label: "announcements", icon: "ic:round-campaign", organizerOnly: true },
  { id: "general", label: "general", icon: "ic:round-tag" },
  { id: "lineup", label: "lineup", icon: "ion:musical-notes" },
  { id: "rideshare", label: "ride-share", icon: "ic:round-directions-car" },
  { id: "market", label: "market", icon: "ic:round-sell" },
];

/** Channel users land on by default — the chatty one (announcements is read-only
 *  for everyone but the organizer, so it's a poor first impression as a landing). */
export const DEFAULT_FORUM_CHANNEL = "general";

// Moderation action codes — MUST mirror forum.move's client-side mapping.
export const MOD_HIDE = 0;
export const MOD_UNHIDE = 1;
export const MOD_PIN = 2;
export const MOD_UNPIN = 3;

export interface ForumBody {
  text: string;
  author: string;
  ts: number;
}

/** The credential a caller decrypts/posts with: a Ticket for the event, or the
 *  event's OrganizerCap. Both satisfy the Seal policy on the same ciphertext. */
export type ForumCredential =
  | { kind: "ticket"; ticketId: string }
  | { kind: "organizer"; capId: string };

/** Encrypt a message body for an event (event-id-gated) and store on Walrus. */
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

/** Post as the organizer (OrganizerCap-gated, no ticket). */
export function forumPostAsOrganizerTx(
  eventId: string,
  capId: string,
  channel: string,
  blobId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::forum::post_as_organizer`,
    arguments: [
      tx.object(eventId),
      tx.object(capId),
      tx.pure.string(channel),
      tx.pure.string(blobId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/** Moderate a post by its Walrus blob id (hide/unhide/pin/unpin). */
export function forumModerateTx(
  eventId: string,
  capId: string,
  targetBlobId: string,
  action: number,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::forum::moderate`,
    arguments: [
      tx.object(eventId),
      tx.object(capId),
      tx.pure.string(targetBlobId),
      tx.pure.u8(action),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/** Fetch + decrypt a message body. Requires a SessionKey and a credential
 *  (ticket OR organizer cap) authorized for the event. */
export async function decryptForumMessage(
  suiClient: any,
  sessionKey: SessionKey,
  blobId: string,
  cred: ForumCredential,
  eventId: string,
): Promise<ForumBody> {
  const env = JSON.parse(new TextDecoder().decode(await readBlob(blobId))) as {
    id: string;
    ct: string;
  };
  const ct = fromBase64(env.ct);
  const pt = await sealDecrypt(suiClient, sessionKey, ct, (tx) =>
    cred.kind === "ticket"
      ? approveTicket(tx, env.id, cred.ticketId, eventId)
      : approveOrganizer(tx, env.id, cred.capId, eventId),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as ForumBody;
}

// === Moderation tombstones (PostModerated) ===

export interface ModerationJson {
  event_id: string;
  target_blob_id: string;
  action: number | string;
  by: string;
  ts_ms: string | number;
}

export interface ModerationState {
  hidden: boolean;
  pinned: boolean;
}

/**
 * Fold `PostModerated` events into per-blob state — the LATEST action per blob
 * wins (hide/unhide toggle `hidden`, pin/unpin toggle `pinned`). Pure + sorted
 * by timestamp internally so callers can pass events in any order. This is how
 * clients honor moderation over the immutable post log.
 */
export function foldModeration(events: ModerationJson[]): Map<string, ModerationState> {
  const sorted = [...events].sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));
  const m = new Map<string, ModerationState>();
  for (const e of sorted) {
    const cur = m.get(e.target_blob_id) ?? { hidden: false, pinned: false };
    const a = Number(e.action);
    if (a === MOD_HIDE) cur.hidden = true;
    else if (a === MOD_UNHIDE) cur.hidden = false;
    else if (a === MOD_PIN) cur.pinned = true;
    else if (a === MOD_UNPIN) cur.pinned = false;
    m.set(e.target_blob_id, cur);
  }
  return m;
}
