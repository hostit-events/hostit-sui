// Event drafts (GH#46) — client-side only. A draft is the in-progress
// Create-Event form, Seal-encrypted and stored as a single Walrus blob; a tiny
// per-address INDEX of those blobs lives in localStorage so the owner can list
// and reopen them.
//
// There is NO API route, NO server and NO database here: encryption happens in
// the browser (Seal), the ciphertext lives on Walrus, and the only local state
// is the index. Saving needs no signature (Seal encrypt is public-key-free for
// a self policy); only LOADING needs a SessionKey, because decryption is gated
// by `access::seal_approve_self` (the owner proves they are the address the blob
// was encrypted for).
//
// === v1 CEILINGS (intentional, documented; revisit in a later phase) ===========
//  • DEVICE-LOCAL INDEX. The list of drafts is keyed by address in this browser's
//    localStorage (`hostit:drafts:${addr}`). Drafts do NOT follow the user to
//    another device/browser, and clearing site data drops the index (the Walrus
//    blob survives until its TTL, but becomes unreachable without its index id).
//  • WALRUS TTL EXPIRY. Blobs are stored for WALRUS_DRAFT_EPOCHS only; after that
//    the ciphertext is garbage-collected and `loadDraft` will fail even though
//    the index entry still lists it. No auto-renew in v1.
//  • PLAINTEXT TITLE + TIMESTAMP IN THE LOCAL INDEX. So we can render the drafts
//    list without decrypting every blob, the index stores `title`/`savedAt`/
//    `mode` in the CLEAR (only on this device). The sensitive form fields stay
//    encrypted in the Walrus blob; do not put PII in the title.

import { toBase64, fromBase64 } from "@mysten/sui/utils";
import type { SessionKey } from "@mysten/seal";
import { sealEncrypt, sealDecrypt, approveSelf } from "./seal";
import { storeBlob, readBlob } from "./walrus";
import { WALRUS_DRAFT_EPOCHS } from "./config";

// ── Types ──────────────────────────────────────────────────────────────────

/** The raw Create-Event form payload (quick or advanced). Strings mirror the
 *  controlled inputs verbatim — parsing/validation happens at publish time. */
export interface EventDraftForm {
  name: string;
  category: string;
  tag?: string;
  start: string;
  end: string;
  venue?: string;
  city?: string;
  description?: string;
  basePrice: string;
  coinType: string;
  maxTickets: string;
  maxPerUser: string;
  isFree: boolean;
  tiers?: unknown[];
  poap?: boolean;
  refundable?: boolean;
  web3?: boolean;
  coverBlobId?: string;
}

/** The full draft document that gets Seal-encrypted and stored on Walrus. */
export interface EventDraft {
  v: 1;
  mode: "quick" | "advanced";
  title: string;
  savedAt: number;
  form: EventDraftForm;
}

/** One row of the device-local index (localStorage). `blobId` points at the
 *  encrypted Walrus blob; `title`/`mode`/`savedAt` are plaintext for listing. */
export interface DraftIndexEntry {
  id: string;
  blobId: string;
  title: string;
  mode: "quick" | "advanced";
  savedAt: number;
}

/** Seal envelope persisted on Walrus (same shape SettingsScreen uses for KYC):
 *  { id, ct } where `ct` = base64(ciphertext). The `id` carries the random Seal
 *  nonce and MUST be persisted — it is not recoverable from the plaintext and is
 *  required to rebuild the `seal_approve_self` PTB on decrypt. */
interface DraftEnvelope {
  id: string;
  ct: string;
}

// ── localStorage index helpers ──────────────────────────────────────────────

const indexKey = (addr: string) => `hostit:drafts:${addr}`;

const te = new TextEncoder();
const td = new TextDecoder();

function bytesToB64(bytes: Uint8Array): string {
  return toBase64(bytes);
}

function b64ToBytes(b64: string): Uint8Array {
  return fromBase64(b64);
}

async function deriveIndexKey(addr: string): Promise<CryptoKey> {
  const material = te.encode(`${window.location.origin}|hostit:drafts|${addr}`);
  const hash = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptIndex(addr: string, list: DraftIndexEntry[]): Promise<string> {
  const key = await deriveIndexKey(addr);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = te.encode(JSON.stringify(list));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(ciphertext) });
}

async function decryptIndex(addr: string, raw: string): Promise<DraftIndexEntry[] | null> {
  try {
    const parsed = JSON.parse(raw) as { v?: number; iv?: string; ct?: string };
    if (parsed?.v !== 1 || !parsed.iv || !parsed.ct) return null;
    const key = await deriveIndexKey(addr);
    const iv = b64ToBytes(parsed.iv);
    const ct = b64ToBytes(parsed.ct);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
    const list = JSON.parse(td.decode(plaintext)) as unknown;
    return Array.isArray(list) ? (list as DraftIndexEntry[]) : [];
  } catch {
    return null;
  }
}

/** SSR-safe, never-throws read of the per-address index. */
async function readIndex(addr: string): Promise<DraftIndexEntry[]> {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(indexKey(addr));
    if (!raw) return [];

    const decrypted = await decryptIndex(addr, raw);
    if (decrypted) return decrypted;

    // Backward-compat: accept legacy plaintext JSON index and migrate on next write.
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DraftIndexEntry[]) : [];
  } catch {
    return [];
  }
}

/** SSR-safe, never-throws write of the per-address index. */
async function writeIndex(addr: string, list: DraftIndexEntry[]): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const enc = await encryptIndex(addr, list);
    window.localStorage.setItem(indexKey(addr), enc);
  } catch {
    /* quota / private mode — fail silently */
  }
}

// ── PURE index logic (exported so tests cover it with no network) ────────────

/** Insert `entry`, or REPLACE the existing one with the same `id` IN PLACE (no
 *  duplicates, order preserved). Returns a new array (does not mutate `list`). */
export function upsertEntry(list: DraftIndexEntry[], entry: DraftIndexEntry): DraftIndexEntry[] {
  const idx = list.findIndex((e) => e.id === entry.id);
  if (idx === -1) return [...list, entry];
  const next = list.slice();
  next[idx] = entry;
  return next;
}

/** Drop the entry with `id`; a no-op (returns an equivalent array) for an id
 *  that isn't present. Returns a new array (does not mutate `list`). */
export function removeEntry(list: DraftIndexEntry[], id: string): DraftIndexEntry[] {
  return list.filter((e) => e.id !== id);
}

// ── Public API ───────────────────────────────────────────────────────────────

/** List this address's drafts (newest-stored detail lives in the entries).
 *  Sync — reads only the device-local index, no network. */
export async function listDrafts(addr: string): Promise<DraftIndexEntry[]> {
  return readIndex(addr);
}

/**
 * Encrypt a draft with Seal (self policy), store the {id, ct} envelope as a
 * single Walrus blob, and upsert the device-local index. Needs NO signature —
 * Seal encryption only needs the owner address. Passing `existingId` REPLACES
 * that draft in place (same index id, no duplicate); omitting it creates a new
 * draft id. Returns the index entry that was written.
 */
export async function saveDraft(
  client: unknown,
  addr: string,
  draft: EventDraft,
  existingId?: string,
): Promise<DraftIndexEntry> {
  // Seal encrypt against the owner address → a fresh `id` carrying the nonce.
  const plaintext = new TextEncoder().encode(JSON.stringify(draft));
  const { id, ciphertext } = await sealEncrypt(client, addr, plaintext);

  // Wrap as the envelope and store the JSON on Walrus.
  const envelope: DraftEnvelope = { id, ct: toBase64(ciphertext) };
  const blobId = await storeBlob(
    new TextEncoder().encode(JSON.stringify(envelope)),
    WALRUS_DRAFT_EPOCHS,
  );

  // Upsert the device-local index. The index `id` is stable across re-saves of
  // the same draft (so the row updates in place); it is independent of the Seal
  // envelope `id`, which is fresh per encryption.
  const entry: DraftIndexEntry = {
    id: existingId ?? crypto.randomUUID(),
    blobId,
    title: draft.title,
    mode: draft.mode,
    savedAt: draft.savedAt,
  };
  const current = await readIndex(addr);
  await writeIndex(addr, upsertEntry(current, entry));
  return entry;
}

/**
 * Load and decrypt a draft by its index id. Reads the index → fetches the
 * Walrus blob → parses the envelope → Seal-decrypts using the envelope's `id`
 * (the persisted nonce) in the `seal_approve_self` PTB. Requires a SessionKey
 * (the owner signs a personal message once per ~10-min session).
 */
export async function loadDraft(
  client: unknown,
  addr: string,
  id: string,
  sessionKey: SessionKey,
): Promise<EventDraft> {
  const entry = readIndex(addr).find((e) => e.id === id);
  if (!entry) throw new Error("Draft not found");

  // The Walrus blob may have lapsed (TTL) or be corrupt — fetch + parse + shape-
  // check defensively so the caller gets a clear "unavailable" error (and can
  // offer to delete the dangling index entry) instead of a cryptic crypto fault.
  let envelope: DraftEnvelope;
  try {
    const raw = await readBlob(entry.blobId);
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<DraftEnvelope>;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.ct !== "string") {
      throw new Error("missing id/ct");
    }
    envelope = parsed as DraftEnvelope;
  } catch (e) {
    throw new Error(
      `Draft is unavailable (expired or corrupt): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // CRITICAL: approveSelf MUST be built with the envelope's persisted `id` — the
  // random Seal nonce is not recoverable from the plaintext, so passing the
  // wrong id makes the key servers reject the decrypt.
  const plaintext = await sealDecrypt(
    client,
    sessionKey,
    fromBase64(envelope.ct),
    (tx) => approveSelf(tx, envelope.id),
  );
  const draft = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<EventDraft>;
  if (draft?.v !== 1 || !draft.form || (draft.mode !== "quick" && draft.mode !== "advanced")) {
    throw new Error("Draft format not recognized");
  }
  return draft as EventDraft;
}

/** Remove a draft from the device-local index. Does NOT delete the Walrus blob
 *  (it lapses on its own TTL); the entry simply stops being listed/openable. */
export function deleteDraft(addr: string, id: string): void {
  writeIndex(addr, removeEntry(readIndex(addr), id));
}
