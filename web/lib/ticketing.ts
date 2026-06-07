// PTB constructors for the hostit_ticket package (v3 — Event/Hub/OrganizerCap).
//
// Model: anyone calls `event::create_event` (→ shared Event + OrganizerCap to
// sender). Paid events set a price per coin type with `event::set_price<T>`.
// Buyers call `market::buy<T>` (paid) or `market::claim_free`. Holders refund or
// check in. Organizers (holding the OrganizerCap) manage prices, withdrawals,
// check-in signers, and the self-check-in toggle.

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
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
  const tx = new Transaction();
  const total = totalWithFee(args.priceUnits);
  const payment = coinWithBalance({
    balance: total,
    type: args.coinType,
    // gas coin can't be a tx arg under sponsorship; for SUI otherwise it's fine.
    useGasCoin: !args.sponsored && args.coinType === SUI_COIN_TYPE,
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
  return tx;
}

export interface ClaimFreeArgs {
  eventId: string;
  recipient: string;
}

export function claimFreeTx(args: ClaimFreeArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("market", "claim_free"),
    arguments: [tx.object(args.eventId), tx.pure.address(args.recipient), tx.object(CLOCK_ID)],
  });
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

// === Helpers ===

type Fields = Record<string, unknown>;
export function getFields(obj: {
  data?: { content?: { fields?: Fields } | unknown } | null;
}): Fields | null {
  const content = obj?.data?.content as { fields?: Fields } | undefined;
  return content?.fields ?? null;
}
