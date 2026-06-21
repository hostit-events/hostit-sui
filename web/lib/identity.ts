// PTB constructors for hostit_ticket::identity (account email layer, GH#96):
// one-account-one-email uniqueness + opt-in email-share grants. Email plaintext
// never goes on-chain — only the server-computed opaque HMAC hash + grant flags.

import { Transaction } from "@mysten/sui/transactions";
import { EMAIL_REGISTRY_ID, PACKAGE_ID, target } from "./config";

/** `identity::EmailGrantCreated` log — discover an attendee's share grant id. */
export const EV_EMAIL_GRANT_CREATED = `${PACKAGE_ID}::identity::EmailGrantCreated`;

/** Register the caller's opaque email hash (HMAC bytes) in the uniqueness registry. */
export function registerEmailTx(emailHash: number[]): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("identity", "register_email"),
    arguments: [tx.object(EMAIL_REGISTRY_ID), tx.pure.vector("u8", emailHash)],
  });
  return tx;
}

/** Free the caller's email hash (the on-chain step of "delete my email data"). */
export function unregisterEmailTx(emailHash: number[]): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("identity", "unregister_email"),
    arguments: [tx.object(EMAIL_REGISTRY_ID), tx.pure.vector("u8", emailHash)],
  });
  return tx;
}

/** Opt in to share your email with `eventId`'s organizer (shares an EmailGrant). */
export function grantEmailAccessTx(eventId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("identity", "grant_email_access"),
    arguments: [tx.object(eventId)],
  });
  return tx;
}

/** Revoke a previously-granted email share (forward-only — deletes the grant). */
export function revokeEmailGrantTx(grantId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("identity", "revoke_email_grant"),
    arguments: [tx.object(grantId)],
  });
  return tx;
}
