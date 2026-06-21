// POAP (proof-of-attendance) — claimable once per checked-in ticket.

import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, target } from "./config";

export const POAP_TYPE = `${PACKAGE_ID}::poap::Poap`;

/** Claim a POAP for a checked-in ticket. Dedup is a flag on the ticket now, so
 *  there's no registry arg — just the (mutable) event + the holder's ticket. */
export function claimPoapTx(eventId: string, ticketId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("poap", "claim_poap"),
    arguments: [tx.object(eventId), tx.object(ticketId)],
  });
  return tx;
}
