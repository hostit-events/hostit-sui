// PTB constructors for the hostit_ticket::predict module (parimutuel "sellout"
// prediction markets) — mirrors lib/ticketing.ts.
//
// Model: anyone calls `predict::create_sellout_market<T>(event)` to open a
// pool-based market that asks "will this event sell out?" (YES wins iff
// `event::minted >= strike`, where strike = `event::max_tickets` snapshot).
// Bettors stake a generic `Coin<T>` (the UI defaults T = testnet USDC,
// USDC_COIN_TYPE) on YES or NO before `expiry_ms` (= `event::start_ms`). After
// expiry anyone calls `settle<T>(market, event)` which reads `event::minted()`
// on-chain to fix the outcome trustlessly. Winners then `claim<T>(market)` to
// withdraw their stake + a pro-rata share of the losing pool. No internal market
// maker, no hub fee in v1 (parimutuel).
//
// All five mutating entry points (create/bet_yes/bet_no/settle/claim) are on the
// Enoki sponsor allowlist for gasless testnet UX. NOTE (production money-
// decision to revisit): sponsoring *bets* means the protocol pays gas for users
// to wager — fine for a testnet demo, but a real deployment should reconsider
// whether bet_yes/bet_no/claim stay sponsored or move to user-paid gas.
//
// -----------------------------------------------------------------------------
// FUTURE SWAP-IN PATH — DeepBook Predict v2 (NOT wired; documented for later).
// -----------------------------------------------------------------------------
// The verified DeepBook Predict v2 PTB surface (Sui mainnet) for the eventual
// migration off this native parimutuel module to DeepBook's CLOB-backed markets:
//   PREDICT_PACKAGE_ID = 0x... (DeepBook Predict v2 package — fill from mainnet)
//   PREDICT_REGISTRY   = 0x... (shared Predict registry object)
//   DUSDC_COIN_TYPE    = <pkg>::dusdc::DUSDC (Predict's settlement coin)
//   targets:  <pkg>::predict::mint   (mint complete YES+NO sets from DUSDC)
//             <pkg>::predict::redeem (redeem a complete set back to DUSDC)
// BLOCKER: DeepBook Predict v2 settles via *custom oracles*, which are NOT
// available on Sui testnet today. Until custom oracles ship on testnet (or we
// move to mainnet), we cannot settle DeepBook Predict markets, so v1 uses this
// native `hostit_ticket::predict` module that settles by reading
// `event::minted()` directly on-chain. Do NOT wire the DeepBook targets above
// until the oracle blocker clears.
// -----------------------------------------------------------------------------

import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { CLOCK_ID, targetLatest } from "./config";

// === Create market ===

/**
 * Permissionless: open a parimutuel sellout market for `eventId`. Snapshots
 * strike/expiry from the Event and shares a new `SelloutMarket<T>` inside the
 * call (no object returned to the sender). `coinType` is the collateral type T
 * (defaults to USDC_COIN_TYPE in the UI). The clock is currently unused on-chain
 * but kept in the signature for PTB uniformity / forward-compat.
 */
export function createSelloutMarketTx(eventId: string, coinType: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: targetLatest("predict", "create_sellout_market"),
    typeArguments: [coinType],
    arguments: [tx.object(eventId), tx.object(CLOCK_ID)],
  });
  return tx;
}

// === Bet ===

export interface BetArgs {
  marketId: string;
  coinType: string;
  /** Stake (smallest unit of T). Consumed whole by the Move call — split exact. */
  amountUnits: bigint;
  /** When sponsored, the gas coin cannot be used as a tx argument. */
  sponsored?: boolean;
}

/**
 * Stake `amountUnits` of `coinType` on YES (event sells out). Requires the
 * market to be open (`now < expiry_ms`) and unsettled; sums into the caller's
 * existing YES stake. The Move fn consumes the whole coin, so we build an exact
 * `coinWithBalance` (never the gas coin — collateral is a fungible, not SUI gas).
 */
export function betYesTx(args: BetArgs): Transaction {
  return betTx("bet_yes", args);
}

/** Same as {@link betYesTx} for the NO side (event does not sell out). */
export function betNoTx(args: BetArgs): Transaction {
  return betTx("bet_no", args);
}

function betTx(fn: "bet_yes" | "bet_no", args: BetArgs): Transaction {
  const tx = new Transaction();
  const stake = coinWithBalance({
    balance: args.amountUnits,
    type: args.coinType,
    // Collateral is a non-SUI fungible; never the gas coin (and never under
    // sponsorship, where the gas coin can't be a tx arg anyway).
    useGasCoin: false,
  })(tx);
  tx.moveCall({
    target: targetLatest("predict", fn),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.marketId), stake, tx.object(CLOCK_ID)],
  });
  return tx;
}

// === Settle ===

export interface SettleArgs {
  marketId: string;
  eventId: string;
  coinType: string;
}

/**
 * Permissionless: after expiry, fix the outcome by reading `event::minted()`
 * on-chain (YES wins iff `minted >= strike`). Requires `eventId` to match the
 * market's snapshotted event id, the market to be unsettled, and `now >=
 * expiry_ms`.
 */
export function settleTx(args: SettleArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: targetLatest("predict", "settle"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.marketId), tx.object(args.eventId), tx.object(CLOCK_ID)],
  });
  return tx;
}

// === Claim ===

export interface ClaimArgs {
  marketId: string;
  coinType: string;
  /** Where the winnings coin is sent. Defaults to the tx sender in the PTB. */
  recipient: string;
}

/**
 * Withdraw the caller's parimutuel winnings (own winning-side stake + pro-rata
 * share of the losing pool). Requires a settled market and a stake on the
 * winning side; the returned `Coin<T>` is transferred to `recipient`. A second
 * claim aborts (E_NO_STAKE) because the winning-side stake is removed first.
 */
export function claimTx(args: ClaimArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: targetLatest("predict", "claim"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.marketId)],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

// === Read-side helpers ===

type Fields = Record<string, unknown>;
function getFields(obj: {
  data?: { content?: { fields?: Fields } | unknown } | null;
}): Fields | null {
  const content = obj?.data?.content as { fields?: Fields } | undefined;
  return content?.fields ?? null;
}

/** Typed view of a `SelloutMarket<T>` shared object (post-getObject parse). */
export interface SelloutMarketView {
  eventId: string;
  eventSeq: string;
  expiryMs: bigint;
  strike: bigint;
  totalYes: bigint;
  totalNo: bigint;
  settled: boolean;
  outcomeYes: boolean;
}

/**
 * Parse a `getObject({ showContent: true })` response for a `SelloutMarket<T>`
 * into a typed view. `u64` fields arrive as JSON strings; the `ID` event_id
 * arrives as a plain hex string. Returns null if the object has no content
 * fields (wrong type / deleted / not yet indexed).
 */
export function parseMarketFields(obj: {
  data?: { content?: { fields?: Fields } | unknown } | null;
}): SelloutMarketView | null {
  const f = getFields(obj);
  if (!f) return null;
  return {
    eventId: String(f.event_id ?? ""),
    eventSeq: String(f.event_seq ?? "0"),
    expiryMs: BigInt((f.expiry_ms as string | number) ?? 0),
    strike: BigInt((f.strike as string | number) ?? 0),
    totalYes: BigInt((f.total_yes as string | number) ?? 0),
    totalNo: BigInt((f.total_no as string | number) ?? 0),
    settled: Boolean(f.settled),
    outcomeYes: Boolean(f.outcome_yes),
  };
}

/** Parimutuel implied odds (probabilities) as percentages of the combined pool. */
export interface Odds {
  yesPct: number;
  noPct: number;
}

/**
 * Compute YES/NO implied percentages from the cached pool totals. With an empty
 * combined pool there is no information, so we return a 50/50 sentinel rather
 * than NaN. Accepts bigint (raw u64 units) or number.
 */
export function computeOdds(
  totalYes: bigint | number,
  totalNo: bigint | number,
): Odds {
  const yes = Number(totalYes);
  const no = Number(totalNo);
  const total = yes + no;
  if (total <= 0) return { yesPct: 50, noPct: 50 };
  const yesPct = (yes / total) * 100;
  return { yesPct, noPct: 100 - yesPct };
}

// =============================================================================
// RangeMarket (Phase 2) — parimutuel market over N+1 minted-count BUCKETS.
// =============================================================================
//
// Model: anyone calls `predict::create_range_market<T>(event, cutoffs)` to open
// a pool-based market that asks "which bucket will the final `event::minted`
// count fall into?". `cutoffs` is a strictly-increasing vector<u64> of length N;
// N cutoffs partition the line into N+1 buckets:
//   bucket 0   = minted < cutoffs[0]
//   bucket i   = cutoffs[i-1] <= minted < cutoffs[i]   (0 < i < N)
//   bucket N   = minted >= cutoffs[N-1]                (last bucket)
// Bettors stake `Coin<T>` on a bucket via `bet_bucket` before `expiry_ms`
// (= event::start_ms snapshot). After expiry anyone `settle_range`s (reads
// `event::minted()` on-chain to fix the winning bucket); holders of the winning
// bucket then `claim_range` for their stake + pro-rata share of the losing
// pools. If the winning bucket has no stake, everyone refunds their own bets.
//
// Type/event origin + call targets all use PACKAGE_ID_LATEST (Phase-2 upgrade),
// NOT the SelloutMarket pin — see config.ts RANGE_MARKET_TYPE / EV_RANGE_*.
// All four mutating entry points are on the Enoki sponsor allowlist.

// === Create range market ===

/**
 * Permissionless: open a parimutuel range market for `eventId` with the given
 * `cutoffs` (strictly increasing; N cutoffs -> N+1 buckets). Snapshots
 * strike-less expiry from the Event and shares a new `RangeMarket<T>` inside the
 * call (no object returned to the sender). `coinType` is the collateral type T
 * (defaults to USDC_COIN_TYPE in the UI). The clock is currently unused on-chain
 * but kept in the signature (named `_clock` in Move) for PTB uniformity.
 */
export function createRangeMarketTx(
  eventId: string,
  coinType: string,
  cutoffs: bigint[] | number[],
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: targetLatest("predict", "create_range_market"),
    typeArguments: [coinType],
    arguments: [
      tx.object(eventId),
      tx.pure.vector("u64", cutoffs as (bigint | number)[]),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// === Bet bucket ===

export interface BetBucketArgs {
  marketId: string;
  coinType: string;
  /** Bucket index in [0, N] (N+1 buckets). Aborts E_BAD_BUCKET if out of range. */
  bucket: number;
  /** Stake (smallest unit of T). Consumed whole by the Move call — split exact. */
  amountUnits: bigint;
}

/**
 * Stake `amountUnits` of `coinType` on `bucket`. Requires the market to be open
 * (`now < expiry_ms`) and unsettled; sums into the caller's existing stake for
 * that bucket. The Move fn consumes the whole coin, so we build an exact
 * `coinWithBalance` (never the gas coin — collateral is a fungible, not SUI gas).
 */
export function betBucketTx(args: BetBucketArgs): Transaction {
  const tx = new Transaction();
  const stake = coinWithBalance({
    balance: args.amountUnits,
    type: args.coinType,
    // Collateral is a non-SUI fungible; never the gas coin (and never under
    // sponsorship, where the gas coin can't be a tx arg anyway).
    useGasCoin: false,
  })(tx);
  tx.moveCall({
    target: targetLatest("predict", "bet_bucket"),
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.marketId),
      tx.pure.u64(args.bucket),
      stake,
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// === Settle range ===

export interface SettleRangeArgs {
  marketId: string;
  eventId: string;
  coinType: string;
}

/**
 * Permissionless: after expiry, fix the winning bucket by reading
 * `event::minted()` on-chain. Requires `eventId` to match the market's
 * snapshotted event id, the market to be unsettled, and `now >= expiry_ms`.
 */
export function settleRangeTx(args: SettleRangeArgs): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: targetLatest("predict", "settle_range"),
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.marketId),
      tx.object(args.eventId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// === Claim range ===

export interface ClaimRangeArgs {
  marketId: string;
  coinType: string;
  /** Where the winnings coin is sent. Defaults to the tx sender in the PTB. */
  recipient: string;
}

/**
 * Withdraw the caller's parimutuel range winnings. On a settled market with a
 * funded winning bucket: own winning-bucket stake + pro-rata share of the losing
 * pools (E_NO_STAKE if no winning stake). If the winning bucket has no stake
 * (no winners), this refunds the caller's own stake across every bucket they bet
 * in. The returned `Coin<T>` is transferred to `recipient`; a second claim
 * aborts (E_NO_STAKE) because stake is removed on the first claim.
 */
export function claimRangeTx(args: ClaimRangeArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: targetLatest("predict", "claim_range"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.marketId)],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}

// === Range read-side helpers ===

/** Coerce a Move vector<u64> field (array of string|number) to bigint[]. */
function toBigIntArray(v: unknown): bigint[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => BigInt((x as string | number) ?? 0));
}

/** Typed view of a `RangeMarket<T>` shared object (post-getObject parse). */
export interface RangeMarketView {
  eventId: string;
  eventSeq: string;
  expiryMs: bigint;
  /** Strictly-increasing cutoffs (length N). */
  cutoffs: bigint[];
  /** Per-bucket cumulative stake (length N+1). */
  totals: bigint[];
  settled: boolean;
  winningBucket: number;
}

/**
 * Parse a `getObject({ showContent: true })` response for a `RangeMarket<T>`
 * into a typed view. `u64` scalars arrive as JSON strings; `vector<u64>` fields
 * arrive as arrays of strings; the `ID` event_id arrives as a plain hex string.
 * Returns null if the object has no content fields (wrong type / deleted / not
 * yet indexed).
 */
export function parseRangeFields(obj: {
  data?: { content?: { fields?: Fields } | unknown } | null;
}): RangeMarketView | null {
  const f = getFields(obj);
  if (!f) return null;
  return {
    eventId: String(f.event_id ?? ""),
    eventSeq: String(f.event_seq ?? "0"),
    expiryMs: BigInt((f.expiry_ms as string | number) ?? 0),
    cutoffs: toBigIntArray(f.cutoffs),
    totals: toBigIntArray(f.totals),
    settled: Boolean(f.settled),
    winningBucket: Number((f.winning_bucket as string | number) ?? 0),
  };
}

/**
 * Compute parimutuel implied percentages per bucket from the cached totals.
 * With an empty combined pool there is no information, so we return an equal
 * split across the buckets rather than NaN. Output length === totals.length and
 * (modulo float rounding) sums to 100.
 */
export function computeBucketOdds(totals: bigint[]): number[] {
  const n = totals.length;
  if (n === 0) return [];
  const nums = totals.map((t) => Number(t));
  const total = nums.reduce((a, b) => a + b, 0);
  if (total <= 0) return nums.map(() => 100 / n);
  return nums.map((t) => (t / total) * 100);
}

/**
 * Human-readable label for bucket `i` given `cutoffs` (length N; N+1 buckets):
 *   bucket 0     -> "0–{c0-1}"  (e.g. "0–249")
 *   bucket i     -> "{c[i-1]}–{c[i]-1}"  (e.g. "250–499")
 *   bucket N     -> "{c[N-1]}+" (e.g. "500+")
 * The final bucket is intentionally OPEN-ENDED ("N+", i.e. N up to max) — the
 * winning bucket is `minted >= cutoffs[N-1]`, so there's no closed top to imply.
 * This also keeps the degenerate-cutoffs case sane: when a tiny maxTickets
 * collapses cutoffs to a single value c (see defaultCutoffs), bucket 1 reads
 * "{c}+" rather than a misleading closed range. Uses an en-dash. Accepts
 * bigint[] | number[]. Falls back to "Bucket i" if the index is out of range.
 */
export function bucketLabel(cutoffs: bigint[] | number[], i: number): string {
  const c = (cutoffs as (bigint | number)[]).map((x) => BigInt(x));
  const n = c.length; // number of cutoffs; buckets are 0..n
  if (i < 0 || i > n) return `Bucket ${i}`;
  if (i === 0) {
    return n === 0 ? "Any" : `0–${c[0] - 1n}`;
  }
  if (i === n) {
    return `${c[n - 1]}+`;
  }
  return `${c[i - 1]}–${c[i] - 1n}`;
}
