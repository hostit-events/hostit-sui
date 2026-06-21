#[test_only]
/// Tests for the manage-page v2 Move additions (GH#87): cancellation, cumulative
/// per-coin revenue accounting, free/refundable flips, end-time extension,
/// price removal, the POAP-enabled toggle, and the checked-in counter.
module hostit_ticket::manage_v2_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};
use hostit_ticket::market;
use hostit_ticket::checkin;
use hostit_ticket::poap::{Self, Poap};

const ORG: address = @0x0123;
const BUYER: address = @0xB0B;
const BUYER2: address = @0xB0B2;

const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000;
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BUY_NOW: u64 = 50_000_000; // in [PSTART, END]
const USE_NOW: u64 = 120_000_000; // in [START, END]; day 0
const WITHDRAW_NOW: u64 = 500_000_000; // > END + 3d
const PRICE: u64 = 1_000_000;
const HOSTIT_FEE: u64 = 30_000; // PRICE * 300 / 10000

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ORG);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }
fun mint(amount: u64, sc: &mut Scenario): Coin<SUI> { coin::mint_for_testing<SUI>(amount, sc.ctx()) }

/// Create an event as ORG with the standard timeline; returns the OrganizerCap.
fun create_event(
    sc: &mut Scenario,
    clock: &Clock,
    is_free: bool,
    is_refundable: bool,
): OrganizerCap {
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"Manage Fest"), s(b"MNG"), s(b"https://img/m.png"),
        START, END, PSTART, 100, 5, is_free, is_refundable, clock, sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

/// ORG sets a SUI price on the event behind `cap`.
fun set_price(sc: &mut Scenario, cap: &OrganizerCap, price: u64) {
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(cap, &mut ev, price);
    ts::return_shared(ev);
}

/// BUYER buys one paid ticket at BUY_NOW.
fun buy_one(sc: &mut Scenario, clock: &mut Clock, who: address) {
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(who);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, who, clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);
}

// === Revenue accounting (survives withdrawal) ===

#[test]
fun revenue_accounting_and_stored_fee() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    // gross/fee accumulate; escrow holds the price.
    sc.next_tx(ORG);
    let ev = sc.take_shared<Event>();
    assert!(event::gross_value<SUI>(&ev) == PRICE, 0);
    assert!(event::fee_value<SUI>(&ev) == HOSTIT_FEE, 1);
    assert!(event::escrow_value<SUI>(&ev) == PRICE, 2);
    assert!(event::refunded_value<SUI>(&ev) == 0, 3);
    ts::return_shared(ev);

    // The exact fee is stored on the ticket (drift-proof refunds).
    sc.next_tx(BUYER);
    let t = sc.take_from_sender<Ticket>();
    assert!(ticket::fee_paid(&t) == HOSTIT_FEE, 4);
    sc.return_to_sender(t);

    // Withdraw drains escrow but lifetime gross/fee remain.
    clock.set_for_testing(WITHDRAW_NOW);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    let hub = sc.take_shared<Hub>();
    let out = market::withdraw_event_balance<SUI>(&cap, &mut ev, &hub, &clock, sc.ctx());
    assert!(coin::value(&out) == PRICE, 5);
    assert!(event::escrow_value<SUI>(&ev) == 0, 6);
    assert!(event::gross_value<SUI>(&ev) == PRICE, 7);
    assert!(event::fee_value<SUI>(&ev) == HOSTIT_FEE, 8);
    coin::burn_for_testing(out);
    ts::return_shared(hub);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Cancellation ===

#[test]
fun cancel_opens_refund_for_nonrefundable() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false); // NOT refundable
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    // organizer cancels
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_cancelled(&cap, &mut ev, true);
    assert!(event::is_cancelled(&ev), 0);
    ts::return_shared(ev);

    // holder refunds immediately (before END, despite non-refundable) — cancel opens it.
    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let t = sc.take_from_sender<Ticket>();
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    assert!(coin::value(&refunded) == PRICE, 1);
    assert!(event::refunded_value<SUI>(&ev) == PRICE, 2);
    coin::burn_for_testing(refunded);
    ts::return_shared(hub);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_CANCELLED)]
fun cancel_blocks_buy() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_cancelled(&cap, &mut ev, true);
    ts::return_shared(ev);

    buy_one(&mut sc, &mut clock, BUYER); // -> E_CANCELLED
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_CANCELLED)]
fun cancel_blocks_withdraw() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_cancelled(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(WITHDRAW_NOW);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    let hub = sc.take_shared<Hub>();
    let out = market::withdraw_event_balance<SUI>(&cap, &mut ev, &hub, &clock, sc.ctx()); // -> E_CANCELLED
    coin::burn_for_testing(out);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Free / refundable flips ===

#[test]
fun set_is_free_before_sales_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false); // free
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_is_free(&cap, &mut ev, false);
    assert!(!event::is_free(&ev), 0);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_HAS_SALES)]
fun set_is_free_after_sales_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_is_free(&cap, &mut ev, true); // minted > 0 -> abort
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_HAS_SALES)]
fun revoke_refundable_after_sales_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, true); // refundable
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_is_refundable(&cap, &mut ev, false); // can't revoke after a sale
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun grant_refundable_after_sales_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false); // non-refundable
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_is_refundable(&cap, &mut ev, true); // buyer-friendly, allowed after sales
    assert!(event::is_refundable(&ev), 0);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === End-time extension (post-start) ===

#[test]
fun update_end_time_extends_after_start() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    clock.set_for_testing(USE_NOW); // after START — update_times would be locked
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::update_end_time(&cap, &mut ev, 300_000_000, &clock);
    assert!(event::end_ms(&ev) == 300_000_000, 0);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_END_TOO_EARLY)]
fun update_end_time_in_past_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    clock.set_for_testing(USE_NOW); // now = 120M
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::update_end_time(&cap, &mut ev, 110_000_000, &clock); // < now -> abort
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Price removal ===

#[test]
fun remove_price_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    assert!(event::has_price<SUI>(&ev), 0);
    event::remove_price<SUI>(&cap, &mut ev);
    assert!(!event::has_price<SUI>(&ev), 1);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_HAS_ESCROW)]
fun remove_price_with_escrow_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, false, false);
    set_price(&mut sc, &cap, PRICE);
    buy_one(&mut sc, &mut clock, BUYER); // escrow now > 0

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::remove_price<SUI>(&cap, &mut ev); // escrow > 0 -> abort
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === POAP toggle + checked-in counter ===

#[test, expected_failure(abort_code = hostit_ticket::poap::E_POAP_DISABLED)]
fun poap_disabled_claim_aborts() {
    let (mut sc, mut clock) = begin();
    poap::init_for_testing(sc.ctx());
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    // enable self check-in, disable POAP
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    event::set_poap_enabled(&cap, &mut ev, false);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t = sc.take_from_sender<Ticket>();
    checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
    poap::claim_poap(&mut ev, &mut t, sc.ctx()); // POAP disabled -> abort
    sc.return_to_sender(t);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun checked_in_count_tracks_unique_tickets() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    // two wallets each claim a free ticket
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);
    sc.next_tx(BUYER2);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER2, &clock, sc.ctx());
    ts::return_shared(ev);

    // both check in
    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t1 = sc.take_from_sender<Ticket>();
    checkin::self_check_in(&mut ev, &mut t1, &clock, sc.ctx());
    // checking the SAME ticket in again (idempotent status) must NOT double-count.
    ts::return_shared(ev);
    sc.return_to_sender(t1);

    sc.next_tx(BUYER2);
    let mut ev = sc.take_shared<Event>();
    let mut t2 = sc.take_from_sender<Ticket>();
    checkin::self_check_in(&mut ev, &mut t2, &clock, sc.ctx());
    assert!(event::checked_in_count(&ev) == 2, 0);
    ts::return_shared(ev);
    sc.return_to_sender(t2);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Organizer-side check-in (GH#96 will-call) ===

#[test]
fun organizer_check_in_marks_attendance() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_organizer_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    // grab the ticket id (BUYER tx), then organizer checks in by id (ORG tx).
    sc.next_tx(BUYER);
    let t = sc.take_from_sender<Ticket>();
    let tid = object::id(&t);
    sc.return_to_sender(t);

    clock.set_for_testing(USE_NOW);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    checkin::organizer_check_in(&cap, &mut ev, tid, BUYER, &clock);
    assert!(event::is_checked_in(&ev, BUYER), 0);
    assert!(event::checked_in_count(&ev) == 1, 1);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::checkin::E_ORGANIZER_CHECKIN_DISABLED)]
fun organizer_check_in_disabled_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false); // flag off by default

    clock.set_for_testing(USE_NOW);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    checkin::organizer_check_in(&cap, &mut ev, object::id_from_address(@0xCAFE), BUYER, &clock);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun organizer_check_in_wrong_cap_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let capA = create_event(&mut sc, &clock, true, false);
    let capB = create_event(&mut sc, &clock, true, false);
    let eidA = event::cap_event_id(&capA);

    clock.set_for_testing(USE_NOW);
    sc.next_tx(ORG);
    let mut evA = ts::take_shared_by_id<Event>(&sc, eidA);
    checkin::organizer_check_in(&capB, &mut evA, object::id_from_address(@0xCAFE), BUYER, &clock);
    ts::return_shared(evA);
    destroy(capA);
    destroy(capB);
    clock.destroy_for_testing();
    sc.end();
}

// POAP reconciliation: an organizer check-in (Event-side only) lets the holder
// claim a POAP even though the ticket's own status was never flipped.
#[test]
fun poap_claim_after_organizer_checkin() {
    let (mut sc, mut clock) = begin();
    poap::init_for_testing(sc.ctx());
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, true, false);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_organizer_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let t = sc.take_from_sender<Ticket>();
    let tid = object::id(&t);
    sc.return_to_sender(t);

    clock.set_for_testing(USE_NOW);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    checkin::organizer_check_in(&cap, &mut ev, tid, BUYER, &clock);
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t = sc.take_from_sender<Ticket>();
    assert!(!ticket::is_checked_in(&t), 0); // organizer check-in did NOT flip the ticket
    poap::claim_poap(&mut ev, &mut t, sc.ctx());
    assert!(ticket::poap_claimed(&t), 1);
    assert!(event::poap_claimed_count(&ev) == 1, 2);
    sc.return_to_sender(t);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
