// PTB constructors for the hostit_ticket package (v3 — Event/Hub/OrganizerCap).
//
// Model: anyone calls `event::create_event` (→ shared Event + OrganizerCap to
// sender). Paid events set a price per coin type with `event::set_price<T>`.
// Buyers call `market::buy<T>` (paid) or `market::claim_free`. Holders refund or
// check in. Organizers (holding the OrganizerCap) manage prices, withdrawals,
// check-in signers, and the self-check-in toggle.

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { CLOCK_ID, HUB_ID, SUI_COIN_TYPE, FEE_BPS, target } from "./config";

// === Create event ===

export interface CreateEventArgs {
  name: string;
  symbol: string;
  uri: string;
  startMs: bigint;
  endMs: bigint;
  purchaseStartMs: bigint;
  maxTickets: bigint;
  maxPerUser: bigint;
  isFree: boolean;
  isRefundable: boolean;
}

/** Returns the OrganizerCap to `sender`; the Event is shared inside the call. */
export function createEventTx(args: CreateEventArgs, sender: string): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: target("event", "create_event"),
    arguments: [
      tx.object(HUB_ID),
      tx.pure.string(args.name),
      tx.pure.string(args.symbol),
      tx.pure.string(args.uri),
      tx.pure.u64(args.startMs),
      tx.pure.u64(args.endMs),
      tx.pure.u64(args.purchaseStartMs),
      tx.pure.u64(args.maxTickets),
      tx.pure.u64(args.maxPerUser),
      tx.pure.bool(args.isFree),
      tx.pure.bool(args.isRefundable),
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([cap], sender);
  return tx;
}

// === Pricing ===

export interface SetPriceArgs {
  capId: string;
  eventId: string;
  coinType: string;
  price: bigint;
}

export function setPriceTx(args: SetPriceArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_price"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.u64(args.price)],
  });
  return tx;
}

export interface CreateEventWithPriceArgs {
  name: string;
  symbol: string;
  uri: string;
  startMs: bigint;
  endMs: bigint;
  purchaseStartMs: bigint;
  maxTickets: bigint;
  maxPerUser: bigint;
  isRefundable: boolean;
  coinType: string;
  price: bigint;
}

/**
 * Atomic paid-event creation (#68): create the event AND set its `coinType`
 * price in a single tx — a paid event can never be left priced-less/un-buyable.
 * Returns the OrganizerCap to `sender`; the Event is shared inside the call.
 * Inherently paid — use `createEventTx` for free events.
 */
export function createEventWithPriceTx(args: CreateEventWithPriceArgs, sender: string): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: target("event", "create_event_with_price"),
    typeArguments: [args.coinType],
    arguments: [
      tx.object(HUB_ID),
      tx.pure.string(args.name),
      tx.pure.string(args.symbol),
      tx.pure.string(args.uri),
      tx.pure.u64(args.startMs),
      tx.pure.u64(args.endMs),
      tx.pure.u64(args.purchaseStartMs),
      tx.pure.u64(args.maxTickets),
      tx.pure.u64(args.maxPerUser),
      tx.pure.bool(args.isRefundable),
      tx.pure.u64(args.price),
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([cap], sender);
  return tx;
}

// === Buy / claim ===

export interface BuyArgs {
  eventId: string;
  coinType: string;
  /** Base price (smallest unit). The 3% platform fee is added on top. */
  priceUnits: bigint;
  recipient: string;
  /** When sponsored, the gas coin cannot be used as a tx argument. */
  sponsored?: boolean;
}

/** Total the buyer must provide = price + 3% platform fee. */
export function totalWithFee(priceUnits: bigint): bigint {
  return priceUnits + (priceUnits * BigInt(FEE_BPS)) / 10_000n;
}

export function buyTx(args: BuyArgs): Transaction {
  return buyManyTx({ ...args, quantity: 1 });
}

export interface BuyManyArgs extends BuyArgs {
  /** How many tickets to mint in this one PTB (1..max_per_user). */
  quantity: number;
}

/**
 * Mint `quantity` paid tickets in a SINGLE programmable transaction: one
 * `market::buy<T>` call per ticket, each funded by its own `coinWithBalance`
 * input of `price + 3% fee`. Each `buy` returns its own change, so no manual
 * coin-splitting math is needed — the builder allocates exact per-call coins.
 * `quantity = 1` is the plain single-buy path. The per-user cap and sold-out
 * checks are enforced on-chain (and surfaced via `humanizeError`).
 */
export function buyManyTx(args: BuyManyArgs): Transaction {
  const tx = new Transaction();
  const total = totalWithFee(args.priceUnits);
  const qty = Math.max(1, Math.trunc(args.quantity));
  // The gas coin can be used as a tx arg only when NOT sponsored AND there is a
  // single SUI payment; with multiple SUI coins we cannot reuse the gas coin for
  // every call, so fall back to balance-sourced coins.
  const useGasCoin = !args.sponsored && args.coinType === SUI_COIN_TYPE && qty === 1;
  for (let i = 0; i < qty; i++) {
    const payment = coinWithBalance({
      balance: total,
      type: args.coinType,
      useGasCoin,
    })(tx);
    tx.moveCall({
      target: target("market", "buy"),
      typeArguments: [args.coinType],
      arguments: [
        tx.object(args.eventId),
        tx.object(HUB_ID),
        payment,
        tx.pure.address(args.recipient),
        tx.object(CLOCK_ID),
      ],
    });
  }
  return tx;
}

export interface ClaimFreeArgs {
  eventId: string;
  recipient: string;
}

export function claimFreeTx(args: ClaimFreeArgs): Transaction {
  return claimFreeManyTx({ ...args, quantity: 1 });
}

export interface ClaimFreeManyArgs extends ClaimFreeArgs {
  /** How many free tickets to claim in this one PTB (1..max_per_user). */
  quantity: number;
}

/**
 * Claim `quantity` free tickets in a SINGLE PTB: one `market::claim_free` call
 * per ticket. No coins are involved, so this just repeats the move call. The
 * per-user cap / sold-out checks are enforced on-chain.
 */
export function claimFreeManyTx(args: ClaimFreeManyArgs): Transaction {
  const tx = new Transaction();
  const qty = Math.max(1, Math.trunc(args.quantity));
  for (let i = 0; i < qty; i++) {
    tx.moveCall({
      target: target("market", "claim_free"),
      arguments: [tx.object(args.eventId), tx.pure.address(args.recipient), tx.object(CLOCK_ID)],
    });
  }
  return tx;
}

// === Refund ===

export interface RefundArgs {
  eventId: string;
  ticketId: string;
  coinType: string;
  recipient: string;
}

export function refundTx(args: RefundArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: target("market", "refund"),
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.eventId),
      tx.object(HUB_ID),
      tx.object(args.ticketId),
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

// === Check-in ===

export interface SelfCheckInArgs {
  eventId: string;
  ticketId: string;
}

export function selfCheckInTx(args: SelfCheckInArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("checkin", "self_check_in"),
    arguments: [tx.object(args.eventId), tx.object(args.ticketId), tx.object(CLOCK_ID)],
  });
  return tx;
}

export interface CheckInVoucherArgs {
  eventId: string;
  ticketId: string;
  signerPubkey: number[]; // 32 bytes
  signature: number[]; // 64 bytes
  voucherExpiryMs: bigint;
}

export function checkInTx(args: CheckInVoucherArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("checkin", "check_in"),
    arguments: [
      tx.object(args.eventId),
      tx.object(args.ticketId),
      tx.pure.vector("u8", args.signerPubkey),
      tx.pure.vector("u8", args.signature),
      tx.pure.u64(args.voucherExpiryMs),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// === Organizer admin (OrganizerCap-gated) ===

export interface WithdrawEventBalanceArgs {
  capId: string;
  eventId: string;
  coinType: string;
  recipient: string;
}

export function withdrawEventBalanceTx(args: WithdrawEventBalanceArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: target("market", "withdraw_event_balance"),
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.capId),
      tx.object(args.eventId),
      tx.object(HUB_ID),
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

export interface SetAllowSelfCheckinArgs {
  capId: string;
  eventId: string;
  allow: boolean;
}

export function setAllowSelfCheckinTx(args: SetAllowSelfCheckinArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_allow_self_checkin"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.bool(args.allow)],
  });
  return tx;
}

export interface AddCheckinSignerArgs {
  capId: string;
  eventId: string;
  pubkey: number[]; // 32 bytes
}

export function addCheckinSignerTx(args: AddCheckinSignerArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "add_checkin_signer"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.vector("u8", args.pubkey)],
  });
  return tx;
}

export interface UpdateMaxTicketsArgs {
  capId: string;
  eventId: string;
  maxTickets: bigint;
}

export function updateMaxTicketsTx(args: UpdateMaxTicketsArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "update_max_tickets"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.u64(args.maxTickets)],
  });
  return tx;
}

// === Organizer edits (issue #69) ===

export interface UpdateMetadataArgs {
  capId: string;
  eventId: string;
  name: string;
  symbol: string;
  /** New Walrus metadata blob id (image/description/location/category/tag). */
  uri: string;
}

export function updateMetadataTx(args: UpdateMetadataArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "update_metadata"),
    arguments: [
      tx.object(args.capId),
      tx.object(args.eventId),
      tx.pure.string(args.name),
      tx.pure.string(args.symbol),
      tx.pure.string(args.uri),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export interface UpdateTimesArgs {
  capId: string;
  eventId: string;
  startMs: bigint;
  endMs: bigint;
  purchaseStartMs: bigint;
}

export function updateTimesTx(args: UpdateTimesArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "update_times"),
    arguments: [
      tx.object(args.capId),
      tx.object(args.eventId),
      tx.pure.u64(args.startMs),
      tx.pure.u64(args.endMs),
      tx.pure.u64(args.purchaseStartMs),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export interface UpdateMaxPerUserArgs {
  capId: string;
  eventId: string;
  maxPerUser: bigint;
}

export function updateMaxPerUserTx(args: UpdateMaxPerUserArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "update_max_per_user"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.u64(args.maxPerUser)],
  });
  return tx;
}

// === Organizer admin v2 (manage command center, #87) ===

export interface RemoveCheckinSignerArgs {
  capId: string;
  eventId: string;
  pubkey: number[]; // 32 bytes
}

/** Revoke a check-in signer (e.g. a lost/compromised staff device key). */
export function removeCheckinSignerTx(args: RemoveCheckinSignerArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "remove_checkin_signer"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.vector("u8", args.pubkey)],
  });
  return tx;
}

export interface CapEventBoolArgs {
  capId: string;
  eventId: string;
  value: boolean;
}

/** Cancel (or un-cancel) the event: opens refunds for all holders, blocks sales
 *  + organizer withdrawal. */
export function setCancelledTx(args: CapEventBoolArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_cancelled"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.bool(args.value)],
  });
  return tx;
}

/** Enable/disable POAP claiming for checked-in holders. */
export function setPoapEnabledTx(args: CapEventBoolArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_poap_enabled"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.bool(args.value)],
  });
  return tx;
}

/** Flip free/paid. Only valid before any ticket is sold (Move asserts minted==0). */
export function setIsFreeTx(args: CapEventBoolArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_is_free"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.bool(args.value)],
  });
  return tx;
}

/** Set refundability. Revoking (→false) is only valid before any sale. */
export function setIsRefundableTx(args: CapEventBoolArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "set_is_refundable"),
    arguments: [tx.object(args.capId), tx.object(args.eventId), tx.pure.bool(args.value)],
  });
  return tx;
}

export interface UpdateEndTimeArgs {
  capId: string;
  eventId: string;
  endMs: bigint;
}

/** Extend ONLY the end time — valid even after the event has started. */
export function updateEndTimeTx(args: UpdateEndTimeArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "update_end_time"),
    arguments: [
      tx.object(args.capId),
      tx.object(args.eventId),
      tx.pure.u64(args.endMs),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

export interface RemovePriceArgs {
  capId: string;
  eventId: string;
  coinType: string;
}

/** Delist a coin's price. Move asserts that coin's escrow is empty. */
export function removePriceTx(args: RemovePriceArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("event", "remove_price"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.capId), tx.object(args.eventId)],
  });
  return tx;
}

// === Per-coin on-chain reads (escrow + lifetime accounting) ===
// `escrow_value`/`gross_value`/`fee_value`/`refunded_value<T>` live in dynamic
// fields (generic over the coin type), so `getObject`/`getFields` can't surface
// them — we read them with `devInspect` (a free, gas-less dry run) and BCS-decode
// the returned u64. The view fns themselves return 0 when the field is absent.

/** BCS-decode a devInspect u64 return value (little-endian bytes) to a bigint. */
export function decodeU64(bytes: number[] | Uint8Array): bigint {
  return BigInt(bcs.u64().parse(Uint8Array.from(bytes)));
}

export interface CoinStats {
  /** Live withdrawable escrow (drops to 0 after withdrawal / refunds). */
  escrow: bigint;
  /** Lifetime gross (sum of prices, pre-fee). */
  gross: bigint;
  /** Lifetime platform fee paid by buyers (3% on top of price). */
  fee: bigint;
  /** Lifetime amount refunded to holders. */
  refunded: bigint;
}

const ZERO_STATS: CoinStats = { escrow: 0n, gross: 0n, fee: 0n, refunded: 0n };

interface DevInspectClient {
  devInspectTransactionBlock: (p: {
    sender: string;
    transactionBlock: Transaction;
  }) => Promise<{ results?: { returnValues?: [number[], string][] }[] } | null>;
}

/**
 * Read a coin's `{escrow, gross, fee, refunded}` for an event in ONE devInspect
 * (four view calls, four return values). Returns all zeros if the dry run fails
 * — callers should treat a failed escrow read as "unknown" and NOT enable a
 * withdraw on it.
 */
export async function readEventCoinStats(
  client: DevInspectClient,
  eventId: string,
  coinType: string,
  sender: string,
): Promise<CoinStats> {
  const fns = ["escrow_value", "gross_value", "fee_value", "refunded_value"] as const;
  const tx = new Transaction();
  for (const fn of fns) {
    tx.moveCall({
      target: target("event", fn),
      typeArguments: [coinType],
      arguments: [tx.object(eventId)],
    });
  }
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const read = (i: number): bigint => {
    const rv = res?.results?.[i]?.returnValues?.[0];
    return rv ? decodeU64(rv[0]) : 0n;
  };
  // Any missing result block → treat the whole read as failed (zeros).
  if (!res?.results || res.results.length < fns.length) return ZERO_STATS;
  return { escrow: read(0), gross: read(1), fee: read(2), refunded: read(3) };
}

// === Helpers ===

type Fields = Record<string, unknown>;
export function getFields(obj: {
  data?: { content?: { fields?: Fields } | unknown } | null;
}): Fields | null {
  const content = obj?.data?.content as { fields?: Fields } | undefined;
  return content?.fields ?? null;
}
