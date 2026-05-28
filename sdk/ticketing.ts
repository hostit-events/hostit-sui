import { Transaction } from "@mysten/sui/transactions";
import { CLOCK_ID, target } from "./config.ts";

// === Issuer lifecycle ===

export interface RegisterIssuerArgs {
  name: string;
  metadata?: Uint8Array;
}

/** Returns a `Transaction` that calls `register_issuer` and transfers the resulting IssuerCap to `sender`. */
export function registerIssuer(args: RegisterIssuerArgs, sender: string): Transaction {
  const tx = new Transaction();
  const cap = tx.moveCall({
    target: target("register_issuer"),
    arguments: [
      tx.pure.string(args.name),
      tx.pure.vector("u8", args.metadata ?? new Uint8Array()),
    ],
  });
  tx.transferObjects([cap], sender);
  return tx;
}

export interface CreateKindConfig {
  name: string;
  description: string;
  imageUrl: string;
  supplyCap: number | bigint;
  priceMist: number | bigint;
  validFromMs: number | bigint;
  validUntilMs: number | bigint;
  refundPolicy: number; // 0 | 1
  keepAsSouvenir: boolean;
  /** Coin type C; e.g. "0x2::sui::SUI" */
  currencyType: string;
}

// Note on composition: `register_issuer` and `create_ticket_kind` cannot be combined
// into a single PTB. `register_issuer` shares the new Issuer object inside the call,
// and shared objects are only addressable by their ObjectID *after* the tx finalizes —
// so the second call has no handle to pass. Onboarding is two transactions; the
// `buy_ticket` composed PTB below is where the composability win shows up.

export interface CreateTicketKindArgs {
  issuerCapId: string;
  issuerId: string;
  config: CreateKindConfig;
}

export function createTicketKind(args: CreateTicketKindArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("create_ticket_kind"),
    typeArguments: [args.config.currencyType],
    arguments: [
      tx.object(args.issuerCapId),
      tx.object(args.issuerId),
      tx.pure.string(args.config.name),
      tx.pure.string(args.config.description),
      tx.pure.string(args.config.imageUrl),
      tx.pure.u64(args.config.supplyCap),
      tx.pure.u64(args.config.priceMist),
      tx.pure.u64(args.config.validFromMs),
      tx.pure.u64(args.config.validUntilMs),
      tx.pure.u8(args.config.refundPolicy),
      tx.pure.bool(args.config.keepAsSouvenir),
    ],
  });
  return tx;
}

// === Buy ===

export interface BuyTicketArgs {
  kindId: string;
  /** Currency type; must match the TicketKind<C> generic. */
  currencyType: string;
  priceMist: number | bigint;
  /** Recipient address; defaults to sender. */
  recipient?: string;
}

/** Composed PTB: split gas, call buy_ticket, transfer resulting Ticket. One signature. */
export function buyTicket(args: BuyTicketArgs, sender: string): Transaction {
  const tx = new Transaction();
  const [payment] = tx.splitCoins(tx.gas, [args.priceMist]);
  const ticket = tx.moveCall({
    target: target(args.recipient ? "buy_ticket_for" : "buy_ticket"),
    typeArguments: [args.currencyType],
    arguments: args.recipient
      ? [
          tx.object(args.kindId),
          payment,
          tx.pure.address(args.recipient),
          tx.object(CLOCK_ID),
        ]
      : [tx.object(args.kindId), payment, tx.object(CLOCK_ID)],
  });
  tx.transferObjects([ticket], args.recipient ?? sender);
  return tx;
}

// === Use ===

export interface UseTicketArgs {
  ticketId: string;
  kindId: string;
  currencyType: string;
}

export function useTicket(args: UseTicketArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("use_ticket"),
    typeArguments: [args.currencyType],
    arguments: [tx.object(args.ticketId), tx.object(args.kindId), tx.object(CLOCK_ID)],
  });
  return tx;
}

// === Refund ===

export interface RefundArgs {
  ticketId: string;
  kindId: string;
  currencyType: string;
  /** Where to send the refunded coin. */
  recipient: string;
}

export function refund(args: RefundArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: target("refund"),
    typeArguments: [args.currencyType],
    arguments: [tx.object(args.ticketId), tx.object(args.kindId), tx.object(CLOCK_ID)],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

// === Withdraw revenue ===

export interface WithdrawRevenueArgs {
  issuerCapId: string;
  kindId: string;
  currencyType: string;
  amountMist: number | bigint;
  recipient: string;
}

export function withdrawRevenue(args: WithdrawRevenueArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: target("withdraw_revenue"),
    typeArguments: [args.currencyType],
    arguments: [
      tx.object(args.issuerCapId),
      tx.object(args.kindId),
      tx.pure.u64(args.amountMist),
    ],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

// === Kind admin ===

export function pauseKind(args: { issuerCapId: string; kindId: string; currencyType: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: target("pause_kind"),
    typeArguments: [args.currencyType],
    arguments: [tx.object(args.issuerCapId), tx.object(args.kindId)],
  });
  return tx;
}

export function resumeKind(args: { issuerCapId: string; kindId: string; currencyType: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: target("resume_kind"),
    typeArguments: [args.currencyType],
    arguments: [tx.object(args.issuerCapId), tx.object(args.kindId)],
  });
  return tx;
}
