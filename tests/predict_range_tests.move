#[test_only]
module hostit_ticket::predict_range_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::market;
use hostit_ticket::predict::{Self, RangeMarket};

// === Collateral coin used for predict range tests ===
public struct USD has drop {}

const ADMIN: address = @0xA1;
const ORG: address = @0x0123;
const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA401;
const DAVE: address = @0xDA7E;

// Timeline (ms). Mirrors the sellout test suite so events validate.
const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000; // == expiry_ms (betting closes here)
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BET_NOW: u64 = 50_000_000; // in [.., START); betting open
const SETTLE_NOW: u64 = 200_000_000; // >= END; settle allowed (settle gated on end_ms)

const MAX_TICKETS: u64 = 1000;
const DURING_EVENT: u64 = 150_000_000; // in [START, END); door-sales window

// === Helpers ===

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create a free event as ORG. Free so we can mint tickets without coins to
/// drive `minted`. Returns the OrganizerCap.
fun create_event(sc: &mut Scenario, clock: &Clock, max_tickets: u64): OrganizerCap {
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Range Test"),
        s(b"RANGE"),
        s(b"https://img/t.png"),
        START,
        END,
        PSTART,
        max_tickets,
        max_tickets, // max_per_user = max so one address can buy them all
        true, // is_free
        false, // is_refundable
        clock,
        sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

/// Open a range market over the shared Event as `who`.
fun open_market(sc: &mut Scenario, clock: &Clock, who: address, cutoffs: vector<u64>) {
    sc.next_tx(who);
    let ev = sc.take_shared<Event>();
    predict::create_range_market<USD>(&ev, cutoffs, clock, sc.ctx());
    ts::return_shared(ev);
}

/// Mint `n` free tickets to drive `event::minted` (each to a fresh recipient so
/// the per-user cap is never the binding constraint).
fun mint_tickets(sc: &mut Scenario, clock: &mut Clock, n: u64) {
    clock.set_for_testing(BET_NOW); // within [PSTART, END]
    let mut i = 0;
    while (i < n) {
        sc.next_tx(ORG);
        let mut ev = sc.take_shared<Event>();
        let recipient = sui::address::from_u256((1000 + i) as u256);
        market::claim_free(&mut ev, recipient, clock, sc.ctx());
        ts::return_shared(ev);
        i = i + 1;
    };
}

fun place_bet(sc: &mut Scenario, clock: &Clock, who: address, bucket: u64, amount: u64) {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<RangeMarket<USD>>();
    let c = coin::mint_for_testing<USD>(amount, sc.ctx());
    predict::bet_bucket<USD>(&mut mkt, bucket, c, clock, sc.ctx());
    ts::return_shared(mkt);
}

fun settle(sc: &mut Scenario, clock: &Clock) {
    sc.next_tx(ORG);
    let mut mkt = sc.take_shared<RangeMarket<USD>>();
    let ev = sc.take_shared<Event>();
    predict::settle_range<USD>(&mut mkt, &ev, clock, sc.ctx());
    ts::return_shared(ev);
    ts::return_shared(mkt);
}

/// Claim as `who`, returning the payout amount (coin destroyed).
fun claim_amount(sc: &mut Scenario, who: address): u64 {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<RangeMarket<USD>>();
    let out = predict::claim_range<USD>(&mut mkt, sc.ctx());
    let v = coin::value(&out);
    destroy(out);
    ts::return_shared(mkt);
    v
}

// === Multi-bucket payout: winning bucket has 2 bettors, other buckets fund it ===
//
// cutoffs = [100, 500] -> 3 buckets:
//   bucket 0: minted < 100
//   bucket 1: 100 <= minted < 500
//   bucket 2: minted >= 500
// Bets: ALICE -> bucket 1 (300), BOB -> bucket 1 (100) => totals[1] = 400.
//       CAROL -> bucket 0 (200), DAVE -> bucket 2 (100) => losing_total = 300.
// minted = 250 -> winning bucket = 1. Combined pot = 700.
// ALICE: 300 + floor(300*300/400) = 300 + 225 = 525.
// BOB:   100 + floor(100*300/400) = 100 + 75  = 175.
// 525 + 175 = 700 (all funds out, none locked).
#[test]
fun multi_bucket_prorata() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 1, 300);
    place_bet(&mut sc, &clock, BOB, 1, 100);
    place_bet(&mut sc, &clock, CAROL, 0, 200);
    place_bet(&mut sc, &clock, DAVE, 2, 100);

    // Drive minted = 250 -> bucket 1 wins.
    mint_tickets(&mut sc, &mut clock, 250);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_is_settled(&mkt), 0);
    assert!(predict::range_winning_bucket(&mkt) == 1, 1);
    assert!(predict::range_num_buckets(&mkt) == 3, 2);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, ALICE) == 525, 3);
    assert!(claim_amount(&mut sc, BOB) == 175, 4);

    // All pools fully drained.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_pool_value(&mkt, 0) == 0, 5);
    assert!(predict::range_pool_value(&mkt, 1) == 0, 6);
    assert!(predict::range_pool_value(&mkt, 2) == 0, 7);
    ts::return_shared(mkt);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === No-winner refund: winning bucket empty -> each bettor reclaims own stake ===
//
// cutoffs = [100, 500] -> 3 buckets. Bets only in bucket 0 (CAROL 200) and
// bucket 2 (DAVE 100). minted = 250 -> winning bucket = 1, which has NO bettors.
// Refund path: CAROL gets 200 back, DAVE gets 100 back; nothing locked.
#[test]
fun no_winner_refund() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, CAROL, 0, 200);
    place_bet(&mut sc, &clock, DAVE, 2, 100);

    mint_tickets(&mut sc, &mut clock, 250); // winning bucket 1 is empty

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_winning_bucket(&mkt) == 1, 0);
    assert!(predict::range_total(&mkt, 1) == 0, 1);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, CAROL) == 200, 2);
    assert!(claim_amount(&mut sc, DAVE) == 100, 3);

    // All pools drained -> nothing locked.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_pool_value(&mkt, 0) == 0, 4);
    assert!(predict::range_pool_value(&mkt, 1) == 0, 5);
    assert!(predict::range_pool_value(&mkt, 2) == 0, 6);
    ts::return_shared(mkt);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Settle picks the correct bucket for a sample minted value ===
//
// cutoffs = [100, 500] -> minted = 500 lands in last bucket (minted >= 500).
#[test]
fun settle_picks_last_bucket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 2, 50);

    // minted = 500 -> >= cutoffs[1] -> last bucket (index 2).
    mint_tickets(&mut sc, &mut clock, 500);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_winning_bucket(&mkt) == 2, 0);
    ts::return_shared(mkt);

    // Single winner, no losing pools -> reclaims exactly own stake.
    assert!(claim_amount(&mut sc, ALICE) == 50, 1);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Double-claim aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NO_STAKE)]
fun double_claim_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 1, 100);
    place_bet(&mut sc, &clock, CAROL, 0, 100);

    mint_tickets(&mut sc, &mut clock, 250); // bucket 1 wins
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    let _ = claim_amount(&mut sc, ALICE); // first claim ok
    let _ = claim_amount(&mut sc, ALICE); // second aborts E_NO_STAKE

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Bet invalid bucket aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_BAD_BUCKET)]
fun bet_invalid_bucket_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    // 2 cutoffs -> 3 buckets (indices 0,1,2). Bucket 3 is out of range.
    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 3, 10);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Zero-value bet aborts (range path) ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_ZERO_BET)]
fun zero_bet_bucket_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE, vector[100, 500]);
    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 0, 0); // bucket 0, zero stake -> abort
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Bet after expiry aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_STILL_OPEN)]
fun bet_after_expiry_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    // now == START == expiry_ms -> betting closed.
    clock.set_for_testing(START);
    place_bet(&mut sc, &clock, ALICE, 1, 10);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Non-increasing cutoffs aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_BAD_CUTOFFS)]
fun non_increasing_cutoffs_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    // 500 then 100 is decreasing -> abort.
    open_market(&mut sc, &clock, ALICE, vector[500, 100]);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Empty cutoffs aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_BAD_CUTOFFS)]
fun empty_cutoffs_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[]);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Settle picks first bucket (minted below first cutoff) ===
#[test]
fun settle_picks_first_bucket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 0, 70);

    // minted = 50 < cutoffs[0]=100 -> bucket 0.
    mint_tickets(&mut sc, &mut clock, 50);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_winning_bucket(&mkt) == 0, 0);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, ALICE) == 70, 1);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

/// Mint `n` free tickets with the clock set to `when` (lets us mint AFTER
/// betting closes but before `end_ms`, the door-sales case).
fun mint_tickets_at(sc: &mut Scenario, clock: &mut Clock, n: u64, when: u64) {
    clock.set_for_testing(when);
    let mut i = 0;
    while (i < n) {
        sc.next_tx(ORG);
        let mut ev = sc.take_shared<Event>();
        let recipient = sui::address::from_u256((2000 + i) as u256);
        market::claim_free(&mut ev, recipient, clock, sc.ctx());
        ts::return_shared(ev);
        i = i + 1;
    };
}

// === Settle is illegal after betting closes but before the event ends ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NOT_EXPIRED)]
fun settle_range_after_start_before_end_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE, vector[100, 500]);
    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 0, 10);
    // now in [START, END): betting closed, but settle must still abort.
    clock.set_for_testing(DURING_EVENT);
    settle(&mut sc, &clock);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Door sales DURING the event move the winning bucket upward ===
#[test]
fun late_sales_move_winning_bucket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE, vector[100, 500]);

    clock.set_for_testing(BET_NOW);
    place_bet(&mut sc, &clock, ALICE, 0, 30); // bets bucket 0 (low)
    place_bet(&mut sc, &clock, CAROL, 2, 70); // bets bucket 2 (high)
    // Before start: only 50 sold -> bucket 0 would win. Old code would give
    // ALICE the pot. The fix waits until end_ms.
    mint_tickets(&mut sc, &mut clock, 50);
    // During the event: 600 more sold (total 650 > 500 cutoff) -> bucket 2 wins.
    mint_tickets_at(&mut sc, &mut clock, 600, DURING_EVENT);

    clock.set_for_testing(SETTLE_NOW); // >= END
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<RangeMarket<USD>>();
    assert!(predict::range_winning_bucket(&mkt) == 2, 0);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, CAROL) == 100, 1); // CAROL wins the pot

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

