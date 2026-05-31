#[test_only]
module hostit_ticket::hostit_ticket_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use std::string;
use hostit_ticket::hub::{Self, Hub, PlatformCap};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};
use hostit_ticket::market;
use hostit_ticket::checkin;
use hostit_ticket::poap::{Self, Poap, PoapRegistry};
use hostit_ticket::access;

const ADMIN: address = @0xA1;
const ORG: address = @0x0123;
const BUYER: address = @0xB0B;
const BUYER2: address = @0xB0B2;

// Time line (ms). start > create_now; end = start + day; purchase_start + day <= start.
const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000;
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BUY_NOW: u64 = 50_000_000; // in [PSTART, END]
const USE_NOW: u64 = 120_000_000; // in [START, END]; day 0
const REFUND_NOW: u64 = 250_000_000; // in [END, END + 3d]
const WITHDRAW_NOW: u64 = 500_000_000; // > END + 3d (445_600_000)
const PRICE: u64 = 1_000_000;
const HOSTIT_FEE: u64 = 30_000; // PRICE * 300 / 10000

// === Helpers ===

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create an event as ORG with the standard timeline; returns the OrganizerCap.
fun create_event(
    sc: &mut Scenario,
    clock: &Clock,
    max_tickets: u64,
    max_per_user: u64,
    is_free: bool,
    is_refundable: bool,
): OrganizerCap {
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Sui Overflow"),
        s(b"SUIO"),
        s(b"https://img/ticket.png"),
        START,
        END,
        PSTART,
        max_tickets,
        max_per_user,
        is_free,
        is_refundable,
        clock,
        sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

fun mint(amount: u64, sc: &mut Scenario): Coin<SUI> {
    coin::mint_for_testing<SUI>(amount, sc.ctx())
}

// === create_event ===

#[test]
fun create_and_reads() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);

    sc.next_tx(ORG);
    let ev = sc.take_shared<Event>();
    assert!(event::event_seq(&ev) == 1, 0);
    assert!(event::organizer(&ev) == ORG, 1);
    assert!(event::max_tickets(&ev) == 100, 2);
    assert!(event::minted(&ev) == 0, 3);
    assert!(event::is_refundable(&ev), 4);
    assert!(!event::is_free(&ev), 5);
    assert!(event::cap_event_id(&cap) == object::id(&ev), 6);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_EMPTY_NAME)]
fun create_empty_name_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b""), s(b"X"), s(b"uri"),
        START, END, PSTART, 10, 1, false, false, &clock, sc.ctx(),
    );
    destroy(cap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_START_MUST_BE_AHEAD)]
fun create_start_not_ahead_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(START + 1); // now after start
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"E"), s(b"X"), s(b"uri"),
        START, END, PSTART, 10, 1, false, false, &clock, sc.ctx(),
    );
    destroy(cap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_END_TOO_EARLY)]
fun create_end_too_early_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"E"), s(b"X"), s(b"uri"),
        START, START + 1, PSTART, 10, 1, false, false, &clock, sc.ctx(),
    );
    destroy(cap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_PURCHASE_START_TOO_LATE)]
fun create_purchase_too_late_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"E"), s(b"X"), s(b"uri"),
        START, END, START - 1, 10, 1, false, false, &clock, sc.ctx(),
    );
    destroy(cap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_MAX_TICKETS_ZERO)]
fun create_max_tickets_zero_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"E"), s(b"X"), s(b"uri"),
        START, END, PSTART, 0, 1, false, false, &clock, sc.ctx(),
    );
    destroy(cap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

// === pricing + buy ===

#[test]
fun set_price_and_buy() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);

    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    assert!(event::has_price<SUI>(&ev), 0);
    ts::return_shared(ev);

    // buy exactly, as BUYER
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    assert!(event::minted(&ev) == 1, 1);
    assert!(event::escrow_value<SUI>(&ev) == PRICE, 2);
    assert!(hub::platform_balance<SUI>(&hub) == HOSTIT_FEE, 3);
    ts::return_shared(hub);
    ts::return_shared(ev);

    // BUYER received a ticket
    sc.next_tx(BUYER);
    let t = sc.take_from_sender<Ticket>();
    assert!(ticket::serial(&t) == 1, 4);
    assert!(ticket::paid(&t) == PRICE, 5);
    assert!(ticket::is_issued(&t), 6);
    sc.return_to_sender(t);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun buy_returns_change() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE + 777, &mut sc); // overpay 777
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let change = sc.take_from_sender<Coin<SUI>>();
    assert!(coin::value(&change) == 777, 0);
    coin::burn_for_testing(change);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_PURCHASE_WINDOW)]
fun buy_before_window_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(PSTART - 1); // before purchase window
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_SOLD_OUT)]
fun buy_sold_out_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 1, 5, false, false); // supply 1
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let p1 = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, p1, BUYER, &clock, sc.ctx());
    let p2 = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, p2, BUYER2, &clock, sc.ctx()); // sold out
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_MAX_TICKETS_HELD)]
fun buy_max_per_user_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 1, false, false); // max 1 per user
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let p1 = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, p1, BUYER, &clock, sc.ctx());
    let p2 = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, p2, BUYER, &clock, sc.ctx()); // second for same user
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_FEE_NOT_ENABLED)]
fun buy_fee_not_enabled_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    // no set_price
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_INSUFFICIENT_PAYMENT)]
fun buy_insufficient_payment_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE, &mut sc); // missing fee
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_IS_FREE_EVENT)]
fun buy_on_free_event_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false); // free
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun claim_free_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    assert!(event::minted(&ev) == 1, 0);
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let t = sc.take_from_sender<Ticket>();
    assert!(ticket::paid(&t) == 0, 1);
    sc.return_to_sender(t);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_NOT_FREE_EVENT)]
fun claim_free_on_paid_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_EVENT_IS_FREE)]
fun set_price_on_free_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_ZERO_PRICE)]
fun set_price_zero_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, 0);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun set_price_wrong_cap_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let capA = create_event(&mut sc, &clock, 100, 5, false, false);
    let capB = create_event(&mut sc, &clock, 100, 5, false, false);
    // take event A by id, set price with cap B
    sc.next_tx(ORG);
    let mut evA = sc.take_shared_by_id<Event>(event::cap_event_id(&capA));
    event::set_price<SUI>(&capB, &mut evA, PRICE); // wrong cap
    ts::return_shared(evA);
    destroy(capA);
    destroy(capB);
    clock.destroy_for_testing();
    sc.end();
}

// === refund ===

#[test]
fun refund_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    // refund within window
    clock.set_for_testing(REFUND_NOW);
    sc.next_tx(BUYER);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let t = sc.take_from_sender<Ticket>();
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    assert!(coin::value(&refunded) == PRICE, 0);
    assert!(event::escrow_value<SUI>(&ev) == 0, 1);
    coin::burn_for_testing(refunded);
    ts::return_shared(hub);
    ts::return_shared(ev);

    // ticket moved to organizer, marked refunded
    sc.next_tx(ORG);
    let t = sc.take_from_address<Ticket>(ORG);
    assert!(ticket::status(&t) == ticket::status_refunded(), 2);
    destroy(t);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_NOT_REFUNDABLE)]
fun refund_not_refundable_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false); // not refundable
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    clock.set_for_testing(REFUND_NOW);
    sc.next_tx(BUYER);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let t = sc.take_from_sender<Ticket>();
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    coin::burn_for_testing(refunded);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_REFUND_WINDOW_NOT_STARTED)]
fun refund_too_early_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    clock.set_for_testing(USE_NOW); // before END
    sc.next_tx(BUYER);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let t = sc.take_from_sender<Ticket>();
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    coin::burn_for_testing(refunded);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_REFUND_WINDOW_EXPIRED)]
fun refund_expired_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    clock.set_for_testing(WITHDRAW_NOW); // past END + 3d
    sc.next_tx(BUYER);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let t = sc.take_from_sender<Ticket>();
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    coin::burn_for_testing(refunded);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === withdrawals ===

#[test]
fun withdraw_nonrefundable_immediate() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    // withdraw immediately (non-refundable, still during sale)
    sc.next_tx(ORG);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let out = market::withdraw_event_balance<SUI>(&cap, &mut ev, &hub, &clock, sc.ctx());
    assert!(coin::value(&out) == PRICE, 0);
    assert!(event::escrow_value<SUI>(&ev) == 0, 1);
    coin::burn_for_testing(out);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::market::E_WITHDRAW_PERIOD_NOT_REACHED)]
fun withdraw_refundable_too_early_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, true);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    clock.set_for_testing(REFUND_NOW); // before refund window closes
    sc.next_tx(ORG);
    let hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let out = market::withdraw_event_balance<SUI>(&cap, &mut ev, &hub, &clock, sc.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(hub);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun withdraw_wrong_cap_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let capA = create_event(&mut sc, &clock, 100, 5, false, false);
    let capB = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut evA = sc.take_shared_by_id<Event>(event::cap_event_id(&capA));
    let hub = sc.take_shared<Hub>();
    let out = market::withdraw_event_balance<SUI>(&capB, &mut evA, &hub, &clock, sc.ctx());
    coin::burn_for_testing(out);
    ts::return_shared(hub);
    ts::return_shared(evA);
    destroy(capA);
    destroy(capB);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun withdraw_platform_fee() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, false, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_price<SUI>(&cap, &mut ev, PRICE);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let mut ev = sc.take_shared<Event>();
    let pay = mint(PRICE + HOSTIT_FEE, &mut sc);
    market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
    ts::return_shared(hub);
    ts::return_shared(ev);

    sc.next_tx(ADMIN);
    let mut hub = sc.take_shared<Hub>();
    let pcap = sc.take_from_sender<PlatformCap>();
    let out = hub::withdraw_platform_balance<SUI>(&mut hub, &pcap, HOSTIT_FEE, ADMIN, sc.ctx());
    assert!(coin::value(&out) == HOSTIT_FEE, 0);
    assert!(hub::platform_balance<SUI>(&hub) == 0, 1);
    coin::burn_for_testing(out);
    sc.return_to_sender(pcap);
    ts::return_shared(hub);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === check-in ===

#[test]
fun self_checkin_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
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
    assert!(ticket::is_checked_in(&t), 0);
    assert!(event::is_checked_in(&ev, BUYER), 1);
    assert!(event::is_checked_in_for_day(&ev, 0, BUYER), 2);
    sc.return_to_sender(t);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::checkin::E_SELF_CHECKIN_DISABLED)]
fun self_checkin_disabled_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
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
    sc.return_to_sender(t);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::checkin::E_USE_NOT_STARTED)]
fun self_checkin_before_window_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW); // before START
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t = sc.take_from_sender<Ticket>();
    checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
    sc.return_to_sender(t);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_ALREADY_CHECKED_IN_DAY)]
fun self_checkin_twice_same_day_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    // BUYER holds two issued tickets for the same day. Check in #0 (records the
    // day), then #1 (same day, same attendee) must hit the once-per-day guard.
    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let ids = ts::ids_for_sender<Ticket>(&sc);
    let mut ev = sc.take_shared<Event>();
    let mut t1 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(0));
    checkin::self_check_in(&mut ev, &mut t1, &clock, sc.ctx());
    sc.return_to_sender(t1);
    let mut t2 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(1));
    checkin::self_check_in(&mut ev, &mut t2, &clock, sc.ctx()); // abort
    sc.return_to_sender(t2);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::checkin::E_NOT_AUTHORIZED_SIGNER)]
fun checkin_unauthorized_signer_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t = sc.take_from_sender<Ticket>();
    // pubkey never registered
    checkin::check_in(&mut ev, &mut t, b"unregistered_pubkey", b"sig", USE_NOW + 1000, &clock, sc.ctx());
    sc.return_to_sender(t);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::checkin::E_BAD_VOUCHER)]
fun checkin_bad_voucher_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    // register a non-zero 32-byte pubkey (the all-zero key is a degenerate
    // ed25519 point that verifies any message — avoid it in tests)
    let pubkey = x"0100000000000000000000000000000000000000000000000000000000000000";
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::add_checkin_signer(&cap, &mut ev, pubkey);
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
    // registered signer, but invalid 64-byte signature -> verify returns false
    let badsig = x"0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    checkin::check_in(&mut ev, &mut t, pubkey, badsig, USE_NOW + 1000, &clock, sc.ctx());
    sc.return_to_sender(t);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === Param tuning ===

#[test]
fun platform_cap_tunes_params() {
    let (mut sc, mut clock) = begin();
    sc.next_tx(ADMIN);
    let mut hub = sc.take_shared<Hub>();
    let pcap = sc.take_from_sender<PlatformCap>();
    hub::set_fee_bps(&mut hub, &pcap, 250);
    hub::set_royalty_bps(&mut hub, &pcap, 100);
    assert!(hub::royalty_bps(&hub) == 100, 0);
    sc.return_to_sender(pcap);
    ts::return_shared(hub);
    clock.destroy_for_testing();
    sc.end();
}

// === Multi-day check-in (parity-restoring regression test) ===

#[test]
fun checkin_multiday_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    let mut t = sc.take_from_sender<Ticket>();
    // day 0
    clock.set_for_testing(USE_NOW);
    checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
    assert!(event::is_checked_in_for_day(&ev, 0, BUYER), 0);
    // day 1 (now == END → day = DAY_MS/DAY_MS = 1, still within [start, end])
    clock.set_for_testing(END);
    checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
    assert!(event::is_checked_in_for_day(&ev, 1, BUYER), 1);
    assert!(ticket::is_checked_in(&t), 2);
    sc.return_to_sender(t);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === POAP + Seal access ===

#[test]
fun poap_claim_after_checkin_ok() {
    let (mut sc, mut clock) = begin();
    poap::init_for_testing(sc.ctx());
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
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
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let ev = sc.take_shared<Event>();
    let mut reg = sc.take_shared<PoapRegistry>();
    poap::claim_poap(&mut reg, &ev, &t, sc.ctx());
    assert!(poap::has_claimed(&reg, object::id(&t)), 0);
    sc.return_to_sender(t);
    ts::return_shared(reg);
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let p = sc.take_from_sender<Poap>();
    assert!(poap::poap_event_seq(&p) == 1, 1);
    destroy(p);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::poap::E_NOT_CHECKED_IN)]
fun poap_claim_not_checked_in_fails() {
    let (mut sc, mut clock) = begin();
    poap::init_for_testing(sc.ctx());
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let ev = sc.take_shared<Event>();
    let mut reg = sc.take_shared<PoapRegistry>();
    let t = sc.take_from_sender<Ticket>();
    poap::claim_poap(&mut reg, &ev, &t, sc.ctx()); // not checked in -> abort
    sc.return_to_sender(t);
    ts::return_shared(reg);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun access_prefix_works() {
    assert!(access::check_prefix(b"abc", b"abcdef"), 0);
    assert!(!access::check_prefix(b"abd", b"abcdef"), 1);
    assert!(!access::check_prefix(b"abcdefg", b"abcdef"), 2);
    assert!(access::check_prefix(b"", b"anything"), 3);
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_INVALID_SIGNER_KEY)]
fun add_signer_bad_key_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::add_checkin_signer(&cap, &mut ev, b"too_short"); // not 32 bytes
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
