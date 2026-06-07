// POAP (proof-of-attendance) — claimable once per checked-in ticket.

import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, POAP_REGISTRY_ID } from "./config";

export const POAP_TYPE = `${PACKAGE_ID}::poap::Poap`;

export function claimPoapTx(eventId: string, ticketId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::poap::claim_poap`,
    arguments: [tx.object(POAP_REGISTRY_ID), tx.object(eventId), tx.object(ticketId)],
  });
  return tx;
}
