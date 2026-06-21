import "server-only";
import { createHmac } from "node:crypto";
import { canonicalizeEmail } from "./emailCanonical";

// SERVER-ONLY one-account-one-email hashing. The on-chain EmailRegistry key is
// HMAC-SHA256(pepper, canonical(email)) — opaque even against full enumeration
// of the (low-entropy) email space, because the pepper is a server secret never
// shipped to the client or written on-chain. A pepper leak only downgrades to
// plain-hash enumeration; it never reveals an email directly. Versioned so the
// pepper can be rotated (old rows keep their version tag).

export const EMAIL_HASH_VERSION = 1;

/** The pepper (≥32 bytes recommended). Read at call time; server env only. */
function pepper(): string | null {
  const p = process.env.EMAIL_HASH_PEPPER?.trim();
  return p && p.length >= 16 ? p : null;
}

/** True iff the hashing secret is configured (gates the email routes). */
export function emailHashConfigured(): boolean {
  return pepper() !== null;
}

export interface EmailHash {
  hashHex: string;
  /** Byte array form for `identity::register_email` (Move `vector<u8>`). */
  hashBytes: number[];
  version: number;
}

/**
 * `HMAC-SHA256(pepper, "v<version>:" + canonical(email))`. Returns null if the
 * email is malformed or the pepper is unset. The version is bound INTO the hash
 * input so a future pepper/scheme change can't collide with old rows.
 */
export function emailHash(rawEmail: string): EmailHash | null {
  const p = pepper();
  if (!p) return null;
  const canon = canonicalizeEmail(rawEmail);
  if (!canon) return null;
  const digest = createHmac("sha256", p).update(`v${EMAIL_HASH_VERSION}:${canon}`).digest();
  return {
    hashHex: digest.toString("hex"),
    hashBytes: Array.from(digest),
    version: EMAIL_HASH_VERSION,
  };
}
