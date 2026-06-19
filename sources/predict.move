/// Native, trustless "will this event sell out?" prediction markets — generic
/// over collateral `Coin<T>`. NOT DeepBook Predict (custom oracles aren't on
/// testnet); this settles purely by reading `event::minted()` on-chain against a
/// strike snapshotted from `event::max_tickets()` at market creation.
///
/// Design (v1, deliberately minimal):
/// - Parimutuel (pool-based). No internal market maker, no hub fee. Winners
///   collectively receive `winning_pool + losing_pool`, split pro-rata by their
///   winning-side stake; losers receive nothing.
/// - Outcome is `minted >= strike` (YES = "sold out / hit max"). The strike is
///   snapshotted at creation so a later `update_max_tickets` can't move the goal
///   posts for an already-open market.
/// - Betting closes AT `expiry_ms` (snapshotted from `event::start_ms`): once the
///   doors open, you can't keep betting on the sellout.
/// - Multiple markets per event are allowed on-chain; the UI dedups for v1.
///
/// Trust model: anyone can `create_sellout_market`, `bet_*`, `settle`, and
/// `claim` — fully permissionless, matching the rest of this package. Settlement
/// is a pure read of the canonical `Event`; no privileged settler.
///
/// Sponsorship: all five entry fns (`create_sellout_market`, `bet_yes`,
/// `bet_no`, `settle`, `claim`) go on the Enoki allowlist for gasless UX on
/// testnet. NOTE: sponsoring *bets* means the platform pays gas for users to
/// stake — a production money-decision to revisit (rate-limit / drop from the
/// allowlist before mainnet).
#[allow(lint(self_transfer))]
module hostit_ticket::predict;

use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event as sui_event;
use sui::table::{Self, Table};
use hostit_ticket::event::{Self, Event};

// === Errors ===

const E_ALREADY_SETTLED: u64 = 1;
const E_NOT_EXPIRED: u64 = 2;
/// Betting is closed: `now >= expiry_ms` (doors are open).
const E_STILL_OPEN: u64 = 3;
const E_WRONG_EVENT: u64 = 4;
const E_NOT_SETTLED: u64 = 5;
const E_NO_STAKE: u64 = 6;
/// `cutoffs` empty or not strictly increasing.
const E_BAD_CUTOFFS: u64 = 7;
/// `bucket` index out of range (`>= len(pools)`).
const E_BAD_BUCKET: u64 = 8;

// === Objects ===

/// Shared parimutuel market for one (event, strike) sellout question.
///
/// Invariant: `total_yes == balance::value(&yes_pool)` and
/// `total_no == balance::value(&no_pool)` at all times (bets only ever join;
/// pools are only drained by `claim`, which decrements via stake removal).
public struct SelloutMarket<phantom T> has key {
    id: UID,
    /// The `Event` this market tracks (`object::id(event)` at creation).
    event_id: ID,
    /// Snapshot of `event::event_seq` for off-chain indexing/UX.
    event_seq: u64,
    /// Betting closes when `now >= expiry_ms` (= `event::start_ms` snapshot).
    expiry_ms: u64,
    /// Settlement is legal only when `now >= settle_after_ms` (= `event::end_ms`
    /// snapshot at creation, so a later `update_times` can't move the goal posts).
    settle_after_ms: u64,
    /// YES wins iff `event::minted >= strike` (= `event::max_tickets` snapshot).
    strike: u64,
    yes_pool: Balance<T>,
    no_pool: Balance<T>,
    /// Running totals = the corresponding pool value (cached for cheap reads /
    /// pro-rata math after pools start draining on claim).
    total_yes: u64,
    total_no: u64,
    /// `bettor -> summed YES stake`. Removed on claim to block double-claim.
    yes_stakes: Table<address, u64>,
    /// `bettor -> summed NO stake`. Removed on claim to block double-claim.
    no_stakes: Table<address, u64>,
    settled: bool,
    outcome_yes: bool,
}

// === Events ===

public struct MarketCreated has copy, drop {
    market_id: ID,
    event_id: ID,
    event_seq: u64,
    expiry_ms: u64,
    strike: u64,
}

public struct Bet has copy, drop {
    market_id: ID,
    bettor: address,
    yes: bool,
    amount: u64,
}

public struct Settled has copy, drop {
    market_id: ID,
    outcome_yes: bool,
    /// `event::minted()` observed at settlement (the resolved supply).
    minted: u64,
}

// === Create ===

/// Permissionless: open a sellout market for `event`. Snapshots the strike
/// (`max_tickets`), the betting deadline (`start_ms`), and the event identity so
/// later organizer edits can't retroactively change this market's question.
public fun create_sellout_market<T>(
    event: &Event,
    _clock: &Clock,
    ctx: &mut TxContext,
) {
    let event_id = object::id(event);
    let event_seq = event::event_seq(event);
    let expiry_ms = event::start_ms(event);
    let settle_after_ms = event::end_ms(event);
    let strike = event::max_tickets(event);

    let market = SelloutMarket<T> {
        id: object::new(ctx),
        event_id,
        event_seq,
        expiry_ms,
        settle_after_ms,
        strike,
        yes_pool: balance::zero<T>(),
        no_pool: balance::zero<T>(),
        total_yes: 0,
        total_no: 0,
        yes_stakes: table::new(ctx),
        no_stakes: table::new(ctx),
        settled: false,
        outcome_yes: false,
    };
    let market_id = object::id(&market);

    sui_event::emit(MarketCreated {
        market_id,
        event_id,
        event_seq,
        expiry_ms,
        strike,
    });

    transfer::share_object(market);
}

// === Bet ===

/// Stake `T` on YES ("this event will sell out / hit max"). Open only while
/// `now < expiry_ms` and the market is unsettled. Re-betting sums into the
/// caller's existing YES stake.
public fun bet_yes<T>(
    market: &mut SelloutMarket<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    place_bet(market, stake, true, clock, ctx);
}

/// Stake `T` on NO ("this event will NOT sell out"). Same window/rules as YES.
public fun bet_no<T>(
    market: &mut SelloutMarket<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    place_bet(market, stake, false, clock, ctx);
}

// === Settle ===

/// Resolve the market by reading the canonical `Event`. Permissionless: anyone
/// can settle once `now >= settle_after_ms` (= `end_ms` snapshot at creation).
/// YES wins iff `minted >= strike`.
public fun settle<T>(
    market: &mut SelloutMarket<T>,
    event: &Event,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    assert!(object::id(event) == market.event_id, E_WRONG_EVENT);
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now >= market.settle_after_ms, E_NOT_EXPIRED);

    let m = event::minted(event);
    let outcome_yes = m >= market.strike;
    market.outcome_yes = outcome_yes;
    market.settled = true;

    sui_event::emit(Settled {
        market_id: object::id(market),
        outcome_yes,
        minted: m,
    });
}

// === Claim ===

/// Withdraw the caller's parimutuel winnings. Requires a settled market and a
/// non-zero stake on the *winning* side. Payout = own stake back from the
/// winning pool + pro-rata share of the losing pool
/// (`floor(stake * losing_total / winning_total)`). The caller's winning-side
/// stake is removed first, so a second claim aborts with `E_NO_STAKE`. Losers
/// hold stake only on the losing side and thus can never claim.
public fun claim<T>(
    market: &mut SelloutMarket<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(market.settled, E_NOT_SETTLED);
    let caller = ctx.sender();

    // Winning vs losing totals (snapshotted; pools are what we actually split).
    let (winning_total, losing_total) = if (market.outcome_yes) {
        (market.total_yes, market.total_no)
    } else {
        (market.total_no, market.total_yes)
    };

    // No bettors on the resolved winning side: nobody can win, so the pot is
    // refunded — each caller reclaims their own stake from whichever side(s)
    // they bet. Mirrors `claim_range`'s no-winner branch so funds never lock.
    if (winning_total == 0) {
        let mut refund = balance::zero<T>();
        let ys = remove_stake_for(&mut market.yes_stakes, caller);
        if (ys > 0) {
            balance::join(&mut refund, balance::split(&mut market.yes_pool, ys));
        };
        let ns = remove_stake_for(&mut market.no_stakes, caller);
        if (ns > 0) {
            balance::join(&mut refund, balance::split(&mut market.no_pool, ns));
        };
        assert!(balance::value(&refund) > 0, E_NO_STAKE);
        return coin::from_balance(refund, ctx)
    };

    // Remove the caller's stake from the WINNING side's table (zero-out first to
    // prevent double-claim). Reading the losing table here is intentionally
    // impossible — losers simply have no entry on the winning side.
    let stake = remove_winning_stake(market, caller);
    assert!(stake > 0, E_NO_STAKE);

    // Pro-rata share of the losing pool. `winning_total > 0` is guaranteed
    // because this caller had stake > 0 on the winning side. If `losing_total`
    // is 0 (one-sided market), winners just reclaim their own stake.
    let loser_share = if (losing_total > 0) {
        (((stake as u128) * (losing_total as u128)) / (winning_total as u128)) as u64
    } else {
        0
    };

    // Pull `stake` from the winning pool and `loser_share` from the losing pool,
    // then merge and hand the caller a single coin.
    let (winning_pool_mut, losing_pool_mut) = winning_losing_pools_mut(market);
    let mut payout_bal = balance::split(winning_pool_mut, stake);
    if (loser_share > 0) {
        balance::join(&mut payout_bal, balance::split(losing_pool_mut, loser_share));
    };

    coin::from_balance(payout_bal, ctx)
}

// === Internal ===

/// Remove and return `caller`'s stake from `tbl` (0 if none). Removal blocks a
/// second claim/refund (next read sees 0).
fun remove_stake_for(tbl: &mut Table<address, u64>, caller: address): u64 {
    if (table::contains(tbl, caller)) {
        table::remove(tbl, caller)
    } else {
        0
    }
}

/// Shared bet logic for YES/NO.
fun place_bet<T>(
    market: &mut SelloutMarket<T>,
    stake: Coin<T>,
    yes: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now < market.expiry_ms, E_STILL_OPEN);

    let amt = coin::value(&stake);
    let bal = coin::into_balance(stake);

    if (yes) {
        balance::join(&mut market.yes_pool, bal);
        market.total_yes = market.total_yes + amt;
        upsert_stake(&mut market.yes_stakes, ctx.sender(), amt);
    } else {
        balance::join(&mut market.no_pool, bal);
        market.total_no = market.total_no + amt;
        upsert_stake(&mut market.no_stakes, ctx.sender(), amt);
    };

    sui_event::emit(Bet {
        market_id: object::id(market),
        bettor: ctx.sender(),
        yes,
        amount: amt,
    });
}

/// Add `amt` to `who`'s entry in `tbl`, creating it if absent.
fun upsert_stake(tbl: &mut Table<address, u64>, who: address, amt: u64) {
    if (table::contains(tbl, who)) {
        let v = table::borrow_mut(tbl, who);
        *v = *v + amt;
    } else {
        table::add(tbl, who, amt);
    }
}

/// Remove and return `caller`'s stake from the *winning* side table (0 if none).
/// Removal here is what makes a second `claim` abort with `E_NO_STAKE`.
fun remove_winning_stake<T>(market: &mut SelloutMarket<T>, caller: address): u64 {
    if (market.outcome_yes) {
        remove_stake_for(&mut market.yes_stakes, caller)
    } else {
        remove_stake_for(&mut market.no_stakes, caller)
    }
}

/// Mutable refs to (winning_pool, losing_pool) per the resolved outcome.
fun winning_losing_pools_mut<T>(
    market: &mut SelloutMarket<T>,
): (&mut Balance<T>, &mut Balance<T>) {
    if (market.outcome_yes) {
        (&mut market.yes_pool, &mut market.no_pool)
    } else {
        (&mut market.no_pool, &mut market.yes_pool)
    }
}

// === Reads ===

public fun event_id<T>(market: &SelloutMarket<T>): ID { market.event_id }
public fun event_seq<T>(market: &SelloutMarket<T>): u64 { market.event_seq }
public fun expiry_ms<T>(market: &SelloutMarket<T>): u64 { market.expiry_ms }
public fun settle_after_ms<T>(market: &SelloutMarket<T>): u64 { market.settle_after_ms }
public fun strike<T>(market: &SelloutMarket<T>): u64 { market.strike }
public fun total_yes<T>(market: &SelloutMarket<T>): u64 { market.total_yes }
public fun total_no<T>(market: &SelloutMarket<T>): u64 { market.total_no }
public fun yes_pool_value<T>(market: &SelloutMarket<T>): u64 {
    balance::value(&market.yes_pool)
}
public fun no_pool_value<T>(market: &SelloutMarket<T>): u64 {
    balance::value(&market.no_pool)
}
public fun is_settled<T>(market: &SelloutMarket<T>): bool { market.settled }
public fun outcome_yes<T>(market: &SelloutMarket<T>): bool { market.outcome_yes }
/// The caller's recorded stake on a given side (0 if none / already claimed).
public fun yes_stake_of<T>(market: &SelloutMarket<T>, who: address): u64 {
    if (table::contains(&market.yes_stakes, who)) {
        *table::borrow(&market.yes_stakes, who)
    } else { 0 }
}
public fun no_stake_of<T>(market: &SelloutMarket<T>, who: address): u64 {
    if (table::contains(&market.no_stakes, who)) {
        *table::borrow(&market.no_stakes, who)
    } else { 0 }
}

// ============================================================================
// RangeMarket — parimutuel VERTICAL-RANGE market on the final tickets-sold count
// ============================================================================
//
// Same parimutuel/permissionless/snapshot design as `SelloutMarket`, but the
// outcome space is N+1 mutually-exclusive buckets over `event::minted()` instead
// of a binary YES/NO. `cutoffs` is a strictly-increasing vector of boundaries;
// for `N` cutoffs there are `N+1` buckets:
//   - bucket 0           : `minted < cutoffs[0]`
//   - bucket i (0<i<N)   : `cutoffs[i-1] <= minted < cutoffs[i]`
//   - bucket N (last)    : `minted >= cutoffs[N-1]`
// Exactly one bucket wins. Winners split `sum(all pools)` pro-rata by their
// stake in the winning bucket. If the winning bucket has NO bettors, every
// bettor reclaims their own stake from each bucket they bet in (refund path) so
// no funds are ever locked.

// === Objects ===

/// Shared parimutuel range market for one event's final `minted` count.
///
/// Invariant: `totals[i] == balance::value(&pools[i])` for every `i` until
/// `claim_range` starts draining (bets only ever join; pools drain only via
/// claim, which decrements via stake removal). `pools`, `stakes`, `totals` all
/// have length `N+1` where `N == vector::length(&cutoffs)`.
public struct RangeMarket<phantom T> has key {
    id: UID,
    /// The `Event` this market tracks (`object::id(event)` at creation).
    event_id: ID,
    /// Snapshot of `event::event_seq` for off-chain indexing/UX.
    event_seq: u64,
    /// Betting closes when `now >= expiry_ms` (= `event::start_ms` snapshot).
    expiry_ms: u64,
    /// Settlement is legal only when `now >= settle_after_ms` (= `event::end_ms`
    /// snapshot at creation, so a later `update_times` can't move the goal posts).
    settle_after_ms: u64,
    /// Strictly-increasing bucket boundaries over `minted` (length `N`).
    cutoffs: vector<u64>,
    /// Per-bucket collateral pools (length `N+1`).
    pools: vector<Balance<T>>,
    /// Per-bucket `bettor -> summed stake`; removed on claim to block re-claim.
    stakes: vector<Table<address, u64>>,
    /// Per-bucket running totals (= the corresponding pool value).
    totals: vector<u64>,
    settled: bool,
    /// Resolved winning bucket index (valid only once `settled`).
    winning_bucket: u64,
}

// === Events ===

public struct RangeMarketCreated has copy, drop {
    market_id: ID,
    event_id: ID,
    event_seq: u64,
    expiry_ms: u64,
    cutoffs: vector<u64>,
}

public struct RangeBet has copy, drop {
    market_id: ID,
    bettor: address,
    bucket: u64,
    amount: u64,
}

public struct RangeSettled has copy, drop {
    market_id: ID,
    /// `event::minted()` observed at settlement (the resolved supply).
    minted: u64,
    winning_bucket: u64,
}

// === Create ===

/// Permissionless: open a range market for `event`. `cutoffs` must be non-empty
/// and strictly increasing; `N` cutoffs create `N+1` empty buckets. Snapshots
/// the betting deadline (`start_ms`) and event identity at creation.
public fun create_range_market<T>(
    event: &Event,
    cutoffs: vector<u64>,
    _clock: &Clock,
    ctx: &mut TxContext,
) {
    let n = vector::length(&cutoffs);
    assert!(n > 0, E_BAD_CUTOFFS);
    // Strictly increasing.
    let mut i = 1;
    while (i < n) {
        assert!(*vector::borrow(&cutoffs, i - 1) < *vector::borrow(&cutoffs, i), E_BAD_CUTOFFS);
        i = i + 1;
    };

    let event_id = object::id(event);
    let event_seq = event::event_seq(event);
    let expiry_ms = event::start_ms(event);
    let settle_after_ms = event::end_ms(event);

    // Build N+1 empty pools / tables / totals.
    let buckets = n + 1;
    let mut pools = vector<Balance<T>>[];
    let mut stakes = vector<Table<address, u64>>[];
    let mut totals = vector<u64>[];
    let mut k = 0;
    while (k < buckets) {
        vector::push_back(&mut pools, balance::zero<T>());
        vector::push_back(&mut stakes, table::new<address, u64>(ctx));
        vector::push_back(&mut totals, 0);
        k = k + 1;
    };

    let market = RangeMarket<T> {
        id: object::new(ctx),
        event_id,
        event_seq,
        expiry_ms,
        settle_after_ms,
        cutoffs,
        pools,
        stakes,
        totals,
        settled: false,
        winning_bucket: 0,
    };
    let market_id = object::id(&market);

    sui_event::emit(RangeMarketCreated {
        market_id,
        event_id,
        event_seq,
        expiry_ms,
        cutoffs: market.cutoffs,
    });

    transfer::share_object(market);
}

// === Bet ===

/// Stake `T` on `bucket`. Open only while `now < expiry_ms` and unsettled; the
/// index must be in range (`bucket < N+1`). Re-betting sums into the caller's
/// existing stake for that bucket.
public fun bet_bucket<T>(
    market: &mut RangeMarket<T>,
    bucket: u64,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now < market.expiry_ms, E_STILL_OPEN);
    assert!(bucket < vector::length(&market.pools), E_BAD_BUCKET);

    let amt = coin::value(&stake);
    let bal = coin::into_balance(stake);

    balance::join(vector::borrow_mut(&mut market.pools, bucket), bal);
    let total = vector::borrow_mut(&mut market.totals, bucket);
    *total = *total + amt;
    upsert_stake(vector::borrow_mut(&mut market.stakes, bucket), ctx.sender(), amt);

    sui_event::emit(RangeBet {
        market_id: object::id(market),
        bettor: ctx.sender(),
        bucket,
        amount: amt,
    });
}

// === Settle ===

/// Resolve the market by reading the canonical `Event`. Permissionless: anyone
/// can settle once `now >= expiry_ms`. The winning bucket is the first `i` in
/// `0..N-1` with `minted < cutoffs[i]`, else the last bucket `N`.
public fun settle_range<T>(
    market: &mut RangeMarket<T>,
    event: &Event,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    assert!(object::id(event) == market.event_id, E_WRONG_EVENT);
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now >= market.settle_after_ms, E_NOT_EXPIRED);

    let m = event::minted(event);
    let n = vector::length(&market.cutoffs);
    let mut winning = n; // default: last bucket (minted >= cutoffs[N-1])
    let mut i = 0;
    while (i < n) {
        if (m < *vector::borrow(&market.cutoffs, i)) {
            winning = i;
            break
        };
        i = i + 1;
    };

    market.winning_bucket = winning;
    market.settled = true;

    sui_event::emit(RangeSettled {
        market_id: object::id(market),
        minted: m,
        winning_bucket: winning,
    });
}

// === Claim ===

/// Withdraw the caller's parimutuel winnings (or refund). Requires a settled
/// market.
///
/// - Winners present (`totals[winning_bucket] > 0`): the caller must have a
///   non-zero stake in the winning bucket (`E_NO_STAKE`). Payout = own stake
///   back + `floor(stake * losing_total / winning_total)` drawn pro-rata from
///   the losing pools, where `losing_total = sum(totals) - totals[winning]`.
///   The winning-bucket stake is removed first, so a second claim aborts.
/// - No winners (`totals[winning_bucket] == 0`): REFUND path. The caller
///   reclaims their own stake from every bucket they bet in (each removed as
///   taken), so no funds are ever locked.
public fun claim_range<T>(
    market: &mut RangeMarket<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(market.settled, E_NOT_SETTLED);
    let caller = ctx.sender();
    let wb = market.winning_bucket;
    let winning_total = *vector::borrow(&market.totals, wb);

    if (winning_total > 0) {
        // --- Normal parimutuel payout from the winning bucket. ---
        let stake = remove_bucket_stake(market, wb, caller);
        assert!(stake > 0, E_NO_STAKE);

        // losing_total = sum(totals) - totals[wb].
        let losing_total = sum_totals(market) - winning_total;
        let loser_share = if (losing_total > 0) {
            (((stake as u128) * (losing_total as u128)) / (winning_total as u128)) as u64
        } else {
            0
        };

        // Take own stake from the winning pool.
        let mut payout_bal = balance::split(
            vector::borrow_mut(&mut market.pools, wb),
            stake,
        );

        // Draw `loser_share` pro-rata across the losing pools, weighted by each
        // losing bucket's ORIGINAL total (`market.totals[b]`), not its live
        // remaining balance (which earlier claimants have already drained).
        // Each per-bucket draw is `floor(loser_share * totals[b] / losing_total)`
        // and is clamped to what the pool still holds; `remaining` caps the
        // cumulative draw so the sum never exceeds `loser_share`. Across all
        // winners these floored per-bucket shares sum to <= each losing bucket's
        // total, so nothing overdraws and only sub-unit rounding dust can remain.
        if (loser_share > 0) {
            let mut remaining = loser_share;
            let buckets = vector::length(&market.pools);
            let mut b = 0;
            while (b < buckets && remaining > 0) {
                if (b != wb) {
                    let orig = *vector::borrow(&market.totals, b);
                    if (orig > 0) {
                        // Pro-rata of THIS losing bucket by original weight.
                        let want = (((loser_share as u128) * (orig as u128))
                            / (losing_total as u128)) as u64;
                        let pool_val = balance::value(vector::borrow(&market.pools, b));
                        // Clamp to remaining budget and to what's actually left.
                        let mut take = if (want > remaining) { remaining } else { want };
                        if (take > pool_val) { take = pool_val };
                        if (take > 0) {
                            balance::join(
                                &mut payout_bal,
                                balance::split(vector::borrow_mut(&mut market.pools, b), take),
                            );
                            remaining = remaining - take;
                        };
                    };
                };
                b = b + 1;
            };
        };

        coin::from_balance(payout_bal, ctx)
    } else {
        // --- No winners: refund the caller's own stake from every bucket. ---
        let buckets = vector::length(&market.pools);
        let mut refund_bal = balance::zero<T>();
        let mut b = 0;
        while (b < buckets) {
            let s = remove_bucket_stake(market, b, caller);
            if (s > 0) {
                balance::join(
                    &mut refund_bal,
                    balance::split(vector::borrow_mut(&mut market.pools, b), s),
                );
            };
            b = b + 1;
        };
        assert!(balance::value(&refund_bal) > 0, E_NO_STAKE);
        coin::from_balance(refund_bal, ctx)
    }
}

// === Internal (range) ===

/// Remove and return `caller`'s stake from bucket `b`'s table (0 if none).
/// Removal here is what blocks a second `claim_range` (next call sees 0).
fun remove_bucket_stake<T>(market: &mut RangeMarket<T>, b: u64, caller: address): u64 {
    let tbl = vector::borrow_mut(&mut market.stakes, b);
    if (table::contains(tbl, caller)) {
        table::remove(tbl, caller)
    } else {
        0
    }
}

/// Sum of all bucket totals (the combined distributable pot).
fun sum_totals<T>(market: &RangeMarket<T>): u64 {
    let mut acc = 0;
    let n = vector::length(&market.totals);
    let mut i = 0;
    while (i < n) {
        acc = acc + *vector::borrow(&market.totals, i);
        i = i + 1;
    };
    acc
}

// === Reads (range) ===

public fun range_event_id<T>(market: &RangeMarket<T>): ID { market.event_id }
public fun range_event_seq<T>(market: &RangeMarket<T>): u64 { market.event_seq }
public fun range_expiry_ms<T>(market: &RangeMarket<T>): u64 { market.expiry_ms }
public fun range_settle_after_ms<T>(market: &RangeMarket<T>): u64 { market.settle_after_ms }
public fun range_cutoffs<T>(market: &RangeMarket<T>): vector<u64> { market.cutoffs }
/// Number of buckets (`N+1`).
public fun range_num_buckets<T>(market: &RangeMarket<T>): u64 {
    vector::length(&market.pools)
}
public fun range_total<T>(market: &RangeMarket<T>, bucket: u64): u64 {
    *vector::borrow(&market.totals, bucket)
}
public fun range_pool_value<T>(market: &RangeMarket<T>, bucket: u64): u64 {
    balance::value(vector::borrow(&market.pools, bucket))
}
public fun range_is_settled<T>(market: &RangeMarket<T>): bool { market.settled }
public fun range_winning_bucket<T>(market: &RangeMarket<T>): u64 { market.winning_bucket }
/// The caller's recorded stake in `bucket` (0 if none / already claimed).
public fun range_stake_of<T>(market: &RangeMarket<T>, bucket: u64, who: address): u64 {
    let tbl = vector::borrow(&market.stakes, bucket);
    if (table::contains(tbl, who)) {
        *table::borrow(tbl, who)
    } else { 0 }
}
