"use client";

import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { PACKAGE_ID, PACKAGE_ID_LATEST } from "./config";

/**
 * Move-call targets sponsored by `/api/sponsor`. The server enforces the
 * authoritative allowlist; this client-side copy is for UI hints only.
 */
// Keep in sync with the server-authoritative list in app/api/sponsor/route.ts.
// The client never sends this — it's a hint for UI badges and for documenting
// what the dapp expects the server (and Enoki portal) to allow.
export const SPONSORED_TARGETS = [
  // hostit_ticket v3 entry points (onboarding + holder actions)
  `${PACKAGE_ID}::event::create_event`,
  `${PACKAGE_ID}::event::set_price`,
  // organizer admin actions (gas-sponsored so hosts never need SUI)
  `${PACKAGE_ID}::event::set_allow_self_checkin`,
  `${PACKAGE_ID}::event::add_checkin_signer`,
  `${PACKAGE_ID}::market::withdraw_event_balance`,
  `${PACKAGE_ID}::market::buy`,
  `${PACKAGE_ID}::market::buy_with_sui`,
  `${PACKAGE_ID}::market::claim_free`,
  `${PACKAGE_ID}::market::refund`,
  `${PACKAGE_ID}::checkin::self_check_in`,
  `${PACKAGE_ID}::checkin::check_in`,
  // proof-of-attendance + community forum (holder actions, gas-sponsored)
  `${PACKAGE_ID}::poap::claim_poap`,
  `${PACKAGE_ID}::forum::post`,
  // prediction markets (parimutuel sellout bets, settled on-chain via event::minted)
  // NOTE: sponsoring speculative bets is a production money-decision to revisit.
  `${PACKAGE_ID_LATEST}::predict::create_sellout_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_yes`,
  `${PACKAGE_ID_LATEST}::predict::bet_no`,
  `${PACKAGE_ID_LATEST}::predict::settle`,
  `${PACKAGE_ID_LATEST}::predict::claim`,
  // range markets (parimutuel bucket bets over final minted count)
  `${PACKAGE_ID_LATEST}::predict::create_range_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_bucket`,
  `${PACKAGE_ID_LATEST}::predict::settle_range`,
  `${PACKAGE_ID_LATEST}::predict::claim_range`,
  // framework calls emitted by the SDK's coinWithBalance intent
  "0x2::coin::zero",
  "0x2::coin::redeem_funds",
  "0x2::coin::into_balance",
  "0x2::coin::send_funds",
  "0x2::coin::destroy_zero",
  "0x2::balance::zero",
  "0x2::balance::redeem_funds",
] as const;

export const SPONSORABLE = new Set<string>(SPONSORED_TARGETS);

export interface SponsorAndExecuteArgs {
  transaction: Transaction;
  sender: string;
  /** A Sui client compatible with `Transaction.build({ client })`. */
  suiClient: ClientWithCoreApi;
  /** Wallet-side signer. Receives the sponsored tx bytes and returns the user's signature. */
  signTransactionBytes: (bytes: Uint8Array) => Promise<{ signature: string }>;
}

interface ApiErrorBody {
  error?: string;
  details?: unknown;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiErrorBody;
    const detail = err.details ? ` (${JSON.stringify(err.details)})` : "";
    throw new Error(`${path} ${res.status}: ${err.error ?? res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

export async function sponsorAndExecute(
  args: SponsorAndExecuteArgs,
): Promise<{ digest: string }> {
  args.transaction.setSender(args.sender);
  const kindBytes = await args.transaction.build({
    client: args.suiClient,
    onlyTransactionKind: true,
  });

  const sponsored = await postJson<{ bytes: string; digest: string }>(
    "/api/sponsor",
    { transactionKindBytes: toBase64(kindBytes), sender: args.sender },
  );

  const { signature } = await args.signTransactionBytes(fromBase64(sponsored.bytes));

  const result = await postJson<{ digest: string }>("/api/sponsor/execute", {
    digest: sponsored.digest,
    signature,
  });
  return { digest: result.digest };
}
