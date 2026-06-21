// Shared (client + server) personal-message formats for account binding. NO
// secrets here — the client signs these with the connected wallet, the server
// re-derives the exact string and verifies the signature. Keep both sides on the
// same format (a mismatch silently breaks verification).

export const EMAIL_BIND_PREFIX = "HOSTIT-EMAIL-BIND-v1";
export const PROFILE_PTR_PREFIX = "HOSTIT-PROFILE-v1";

/** One-time-code lifetime for wallet email verification. */
export const OTP_TTL_MS = 10 * 60_000;

/** The exact message a wallet signs to prove it controls `address` and intends
 *  to bind `canonicalEmail`. Bound to a nonce + expiry to prevent replay. */
export function emailBindMessage(input: {
  address: string;
  canonicalEmail: string;
  nonce: string;
  expiryMs: number;
}): string {
  return [
    EMAIL_BIND_PREFIX,
    input.address,
    input.canonicalEmail,
    input.nonce,
    String(input.expiryMs),
  ].join("|");
}

/** The message a wallet signs to authorize writing its profile pointer (the
 *  non-sensitive `profile:<addr> → blobId` KV row). */
export function profilePointerMessage(address: string, blobId: string): string {
  return [PROFILE_PTR_PREFIX, address, blobId].join("|");
}
