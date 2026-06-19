#[test_only]
module hostit_ticket::predict_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::market;
use hostit_ticket::predict::{Self, SelloutMarket};

// === Collateral coin used for predict tests ===
public struct USD has drop {}

const ADMIN: address = @0xA1;
const ORG: address = @0x0123;
const ALICE: address = @0xA11CE; // YES bettor
const BOB: address = @0xB0B; // YES bettor
const CAROL: address = @0xCA401; // NO bettor

// Timeline (ms). Mirrors the main test suite so events validate.
const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000; // == expiry_ms (betting closes here)
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BET_NOW: u64 = 50_000_000; // in [.., START); betting open
const SETTLE_NOW: u64 = 200_000_000; // >= END; settle allowed (settle gated on end_ms)

const MAX_TICKETS: u64 = 100;
const DURING_EVENT: u64 = 150_000_000; // in [START, END); door-sales window

// === Helpers ===

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create a free event as ORG (free so we can mint tickets without coins to
/// drive `minted` for sellout outcomes). Returns the OrganizerCap.
fun create_event(sc: &mut Scenario, clock: &Clock, max_tickets: u64): OrganizerCap {
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Sellout Test"),
        s(b"SELL"),
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

/// Open a market over the shared Event as `who`.
fun open_market(sc: &mut Scenario, clock: &Clock, who: address) {
    sc.next_tx(who);
    let ev = sc.take_shared<Event>();
    predict::create_sellout_market<USD>(&ev, clock, sc.ctx());
    ts::return_shared(ev);
}

/// Mint `n` free tickets to drive `event::minted` (each to a fresh recipient so
/// the per-user cap is never the binding constraint).
fun mint_tickets(sc: &mut Scenario, clock: &mut Clock, n: u64) {
    clock.set_for_testing(BET_NOW); // within [PSTART, END]; betting window still open
    let mut i = 0;
    while (i < n) {
        sc.next_tx(ORG);
        let mut ev = sc.take_shared<Event>();
        // recipient address derived from i; addresses are arbitrary distinct values
        let recipient = sui::address::from_u256((1000 + i) as u256);
        market::claim_free(&mut ev, recipient, clock, sc.ctx());
        ts::return_shared(ev);
        i = i + 1;
    };
}

fun place_yes(sc: &mut Scenario, clock: &Clock, who: address, amount: u64) {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    let c = coin::mint_for_testing<USD>(amount, sc.ctx());
    predict::bet_yes<USD>(&mut mkt, c, clock, sc.ctx());
    ts::return_shared(mkt);
}

fun place_no(sc: &mut Scenario, clock: &Clock, who: address, amount: u64) {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    let c = coin::mint_for_testing<USD>(amount, sc.ctx());
    predict::bet_no<USD>(&mut mkt, c, clock, sc.ctx());
    ts::return_shared(mkt);
}

fun settle(sc: &mut Scenario, clock: &Clock) {
    sc.next_tx(ORG);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    let ev = sc.take_shared<Event>();
    predict::settle<USD>(&mut mkt, &ev, clock, sc.ctx());
    ts::return_shared(ev);
    ts::return_shared(mkt);
}

/// Claim as `who`, returning the payout amount (coin destroyed).
fun claim_amount(sc: &mut Scenario, who: address): u64 {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    let out = predict::claim<USD>(&mut mkt, sc.ctx());
    let v = coin::value(&out);
    destroy(out);
    ts::return_shared(mkt);
    v
}

// === YES wins: pro-rata across two YES + one NO bettor ===
//
// YES pool: ALICE 30, BOB 10 -> total_yes 40. NO pool: CAROL 60 -> total_no 60.
// minted hits MAX -> YES wins. Total distributable = 100.
// ALICE: 30 + floor(30*60/40)=30+45=75. BOB: 10 + floor(10*60/40)=10+15=25.
// 75 + 25 = 100 (all funds out, none locked).
#[test]
fun yes_wins_prorata() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 30);
    place_yes(&mut sc, &clock, BOB, 10);
    place_no(&mut sc, &clock, CAROL, 60);

    // Drive a full sellout (minted == MAX_TICKETS >= strike).
    mint_tickets(&mut sc, &mut clock, MAX_TICKETS);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    // Confirm outcome.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::is_settled(&mkt), 0);
    assert!(predict::outcome_yes(&mkt), 1);
    assert!(predict::strike(&mkt) == MAX_TICKETS, 2);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, ALICE) == 75, 3);
    assert!(claim_amount(&mut sc, BOB) == 25, 4);

    // Pools fully drained.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 5);
    assert!(predict::no_pool_value(&mkt) == 0, 6);
    ts::return_shared(mkt);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === NO wins: not sold out ===
//
// YES: ALICE 40. NO: BOB 10, CAROL 30 -> total_no 40. minted < strike -> NO wins.
// BOB: 10 + floor(10*40/40)=10+40... wait: losing_total = total_yes = 40,
// winning_total = total_no = 40. BOB: 10 + floor(10*40/40)=10+10=20.
// CAROL: 30 + floor(30*40/40)=30+30=60. 20+60 = 80 = total pool.
#[test]
fun no_wins_prorata() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 40);
    place_no(&mut sc, &clock, BOB, 10);
    place_no(&mut sc, &clock, CAROL, 30);

    // Only mint a few tickets -> minted < strike -> NO wins. (No mints needed,
    // but mint a couple to be explicit it's still under strike.)
    mint_tickets(&mut sc, &mut clock, 5);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(!predict::outcome_yes(&mkt), 0);
    ts::return_shared(mkt);

    assert!(claim_amount(&mut sc, BOB) == 20, 1);
    assert!(claim_amount(&mut sc, CAROL) == 60, 2);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 3);
    assert!(predict::no_pool_value(&mkt) == 0, 4);
    ts::return_shared(mkt);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === One-sided pool: losing side empty -> winners get exactly their stake ===
//
// Only YES bets (ALICE 100). Event sells out -> YES wins, losing_total = 0.
// ALICE reclaims exactly 100.
#[test]
fun one_sided_winner_reclaims_stake() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 100);

    mint_tickets(&mut sc, &mut clock, MAX_TICKETS);

    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    assert!(claim_amount(&mut sc, ALICE) == 100, 0);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 1);
    ts::return_shared(mkt);

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

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 50);
    place_no(&mut sc, &clock, CAROL, 50);

    mint_tickets(&mut sc, &mut clock, MAX_TICKETS);
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    let _ = claim_amount(&mut sc, ALICE); // first claim ok
    let _ = claim_amount(&mut sc, ALICE); // second aborts E_NO_STAKE

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Loser cannot claim from the winning pool ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NO_STAKE)]
fun loser_claim_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 50);
    place_no(&mut sc, &clock, CAROL, 50);

    mint_tickets(&mut sc, &mut clock, MAX_TICKETS); // YES wins
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    // CAROL bet NO and lost -> no winning-side stake -> abort.
    let _ = claim_amount(&mut sc, CAROL);

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

    open_market(&mut sc, &clock, ALICE);

    // now == START == expiry_ms -> betting closed (now >= expiry).
    clock.set_for_testing(START);
    place_yes(&mut sc, &clock, ALICE, 10);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Settle before expiry aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NOT_EXPIRED)]
fun settle_before_expiry_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);

    // now == BET_NOW < START == expiry -> E_NOT_EXPIRED.
    settle(&mut sc, &clock);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Claim before settle aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NOT_SETTLED)]
fun claim_before_settle_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);

    open_market(&mut sc, &clock, ALICE);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);

    let _ = claim_amount(&mut sc, ALICE); // not settled -> abort

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Settle with wrong event aborts ===
#[test, expected_failure(abort_code = hostit_ticket::predict::E_WRONG_EVENT)]
fun settle_wrong_event_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap1 = create_event(&mut sc, &clock, MAX_TICKETS);

    // Market over event #1.
    open_market(&mut sc, &clock, ALICE);

    // A second, different event.
    let cap2 = create_event(&mut sc, &clock, MAX_TICKETS);

    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);

    clock.set_for_testing(SETTLE_NOW);
    // Settle using the WRONG (second) event object.
    sc.next_tx(ORG);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    // Grab the second event by id via cap2.
    let wrong_event_id = event::cap_event_id(&cap2);
    let ev2 = ts::take_shared_by_id<Event>(&sc, wrong_event_id);
    predict::settle<USD>(&mut mkt, &ev2, &clock, sc.ctx());
    ts::return_shared(ev2);
    ts::return_shared(mkt);

    destroy(cap1);
    destroy(cap2);
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
fun settle_after_start_before_end_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);
    // now in [START, END): betting closed, but settle must still abort.
    clock.set_for_testing(DURING_EVENT);
    settle(&mut sc, &clock);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Door sales DURING the event are counted: under-strike at start,
//     over-strike by end -> YES wins (the bug: old code settled NO on the
//     start-time count). ===
#[test]
fun late_sales_during_event_decide_outcome() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 50); // bets it WILL sell out
    place_no(&mut sc, &clock, CAROL, 50);
    // Before start: only a few sold (under strike). Old code would settle NO.
    mint_tickets(&mut sc, &mut clock, 10);
    // During the event: the rest sell out (crosses strike). 10 + 90 == MAX.
    mint_tickets_at(&mut sc, &mut clock, MAX_TICKETS - 10, DURING_EVENT);
    clock.set_for_testing(SETTLE_NOW); // >= END
    settle(&mut sc, &clock);
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::outcome_yes(&mkt), 0); // YES: final count hit strike
    ts::return_shared(mkt);
    assert!(claim_amount(&mut sc, ALICE) == 100, 1); // YES bettor wins the pot
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// Winning side has zero bettors -> losing-side bettors are refunded, not locked.
// Everyone bets NO ("won't sell out"); the event sells out -> YES wins, but the
// YES side is empty. Before this fix every claim aborted and the NO pool locked.
#[test]
fun winning_side_empty_refunds() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_no(&mut sc, &clock, CAROL, 50);
    place_no(&mut sc, &clock, BOB, 30); // only NO bets
    mint_tickets(&mut sc, &mut clock, MAX_TICKETS); // sells out -> YES wins (empty)
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::outcome_yes(&mkt), 0);
    assert!(predict::total_yes(&mkt) == 0, 1); // winning side empty
    ts::return_shared(mkt);
    assert!(claim_amount(&mut sc, CAROL) == 50, 2); // own stake refunded
    assert!(claim_amount(&mut sc, BOB) == 30, 3);
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::no_pool_value(&mkt) == 0, 4); // nothing locked
    ts::return_shared(mkt);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// A refund can only be taken once (stake removed on first claim).
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NO_STAKE)]
fun double_refund_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_no(&mut sc, &clock, CAROL, 50);
    mint_tickets(&mut sc, &mut clock, MAX_TICKETS); // YES wins, YES empty
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);
    let _ = claim_amount(&mut sc, CAROL); // refund ok
    let _ = claim_amount(&mut sc, CAROL); // second aborts E_NO_STAKE
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
