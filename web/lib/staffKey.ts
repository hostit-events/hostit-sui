// Staff check-in voucher signing (client-side only).
//
// At the door, a staff device holds an ed25519 keypair whose *public* key the
// organizer has registered on the Event (`event::add_checkin_signer`). To admit
// an attendee the staff device signs an ed25519 voucher over the exact bytes the
// Move `checkin::check_in` path verifies, and that voucher (signature + pubkey +
// expiry) gates the on-chain check-in.
//
// SECURITY: the staff *private* key never leaves this device — it is held only in
// localStorage on the staff device and used to sign locally. It is never logged
// and never sent to any server (sponsorship only ever sees the public voucher).

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { bcs } from "@mysten/sui/bcs";
import { fromHex, normalizeSuiObjectId, isValidSuiObjectId } from "@mysten/sui/utils";

// localStorage key. Per-device, not per-event: one staff key can be registered on
// many events. Holds the bech32 `suiprivkey1…` secret string.
const STAFF_KEY_STORAGE = "hostit.staffSigner.secret";

/**
 * The exact voucher message bytes the Move `checkin::build_voucher_msg` builds:
 * `event_id (32) || ticket_id (32) || expiry_ms (8, little-endian)`.
 * Both ids are normalized to a 32-byte object id then taken as raw bytes; the
 * expiry is BCS-serialized as a little-endian u64 (matches `bcs::to_bytes`).
 */
export function buildVoucherMessage(
  eventId: string,
  ticketId: string,
  expiryMs: bigint,
): Uint8Array {
  const ev = fromHex(normalizeSuiObjectId(eventId)); // 32 bytes
  const tk = fromHex(normalizeSuiObjectId(ticketId)); // 32 bytes
  const exp = bcs.u64().serialize(expiryMs).toBytes(); // 8 bytes, little-endian
  const msg = new Uint8Array(ev.length + tk.length + exp.length);
  msg.set(ev, 0);
  msg.set(tk, ev.length);
  msg.set(exp, ev.length + tk.length);
  return msg;
}

export interface SignedVoucher {
  /** 32-byte registered staff public key. */
  signerPubkey: number[];
  /** 64-byte ed25519 signature over the voucher message. */
  signature: number[];
  /** Voucher expiry (ms since epoch). */
  voucherExpiryMs: bigint;
}

/**
 * Sign a check-in voucher for `ticketId` at `eventId` with the staff `keypair`.
 * Produces the three arguments `checkInTx` needs. The signature is a raw 64-byte
 * ed25519 signature, exactly what `sui::ed25519::ed25519_verify` expects.
 */
export async function signVoucher(
  keypair: Ed25519Keypair,
  eventId: string,
  ticketId: string,
  expiryMs: bigint,
): Promise<SignedVoucher> {
  const msg = buildVoucherMessage(eventId, ticketId, expiryMs);
  const signature = await keypair.sign(msg);
  return {
    signerPubkey: Array.from(keypair.getPublicKey().toRawBytes()),
    signature: Array.from(signature),
    voucherExpiryMs: expiryMs,
  };
}

// === Per-device staff key management (localStorage) ===

/** Load the saved staff keypair from this device, or null if none/invalid. */
export function loadStaffKeypair(): Ed25519Keypair | null {
  if (typeof window === "undefined") return null;
  const secret = window.localStorage.getItem(STAFF_KEY_STORAGE);
  if (!secret) return null;
  try {
    return Ed25519Keypair.fromSecretKey(secret);
  } catch {
    return null;
  }
}

/** Generate a fresh staff keypair and persist it on this device. */
export function generateStaffKeypair(): Ed25519Keypair {
  const kp = Ed25519Keypair.generate();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STAFF_KEY_STORAGE, kp.getSecretKey());
  }
  return kp;
}

/**
 * Import a staff keypair from a bech32 `suiprivkey1…` secret string and persist
 * it on this device. Throws if the string isn't a valid secret key.
 */
export function importStaffKeypair(secret: string): Ed25519Keypair {
  const kp = Ed25519Keypair.fromSecretKey(secret.trim());
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STAFF_KEY_STORAGE, kp.getSecretKey());
  }
  return kp;
}

/** Forget the staff key on this device. */
export function clearStaffKeypair(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STAFF_KEY_STORAGE);
  }
}

/** The 0x-prefixed hex of a keypair's 32-byte ed25519 public key (for registration). */
export function staffPubkeyHex(keypair: Ed25519Keypair): string {
  const bytes = keypair.getPublicKey().toRawBytes();
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Best-effort extraction of a Sui object id (a ticket id) from a scanned QR
 * payload. Accepts a bare `0x…` id, a `…/ticket/<id>` or `?ticket=<id>` URL, or
 * a JSON blob containing a `ticketId`/`ticket_id`/`id` field. Returns the
 * normalized id, or null if no valid object id is found.
 */
export function extractTicketId(raw: string): string | null {
  const s = raw.trim();
  // Direct object id.
  if (isValidSuiObjectId(s)) return normalizeSuiObjectId(s);
  // JSON payload.
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      for (const k of ["ticketId", "ticket_id", "id"]) {
        const v = obj[k];
        if (typeof v === "string" && isValidSuiObjectId(v)) return normalizeSuiObjectId(v);
      }
    } catch {
      /* fall through */
    }
  }
  // Any 0x-prefixed 64-hex substring (covers URLs and arbitrary wrappers).
  const m = s.match(/0x[0-9a-fA-F]{64}/);
  if (m && isValidSuiObjectId(m[0])) return normalizeSuiObjectId(m[0]);
  return null;
}
