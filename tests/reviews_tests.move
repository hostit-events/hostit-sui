#[test_only]
module hostit_ticket::reviews_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::Ticket;
use hostit_ticket::market;
use hostit_ticket::checkin;
use hostit_ticket::poap::{Self, Poap};
use hostit_ticket::reviews;

const ORG: address = @0x0123;
const ORG2: address = @0x0456;
const BUYER: address = @0xB0B;
const BUYER2: address = @0xB0B2;

// Time line (ms): start > create_now; end = start + day; purchase_start + day <= start.
const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000;
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BUY_NOW: u64 = 50_000_000; // in [PSTART, END]
const USE_NOW: u64 = 120_000_000; // in [START, END]; day 0

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ORG);
    hub::init_for_testing(sc.ctx());
    poap::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create a FREE event as `who`; returns that organizer's cap. Free + self
/// check-in so BUYER can claim a ticket, self-check-in, and claim a POAP.
fun create_free_event(sc: &mut Scenario, clock: &Clock, who: address): OrganizerCap {
    sc.next_tx(who);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Review Fest"),
        s(b"REVW"),
        s(b"https://img/review.png"),
        START,
        END,
        PSTART,
        100,
        5,
        true, // is_free
        false,
        clock,
        sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

/// Drive `who` to OWN a `Poap` for the event behind `cap`: enable self check-in,
/// claim a free ticket, self-check-in, claim the POAP. Leaves `who` holding the
/// `Poap` (and the spent `Ticket`). Mirrors the POAP flow in hostit_ticket_tests.
fun attend_and_claim_poap(
    sc: &mut Scenario,
    clock: &mut Clock,
    cap: &OrganizerCap,
    eid: ID,
    who: address,
) {
    // organizer enables self check-in
    sc.next_tx(ORG);
    let mut ev = ts::take_shared_by_id<Event>(sc, eid);
    event::set_allow_self_checkin(cap, &mut ev, true);
    ts::return_shared(ev);

    // claim free ticket (advance the clock only forward — this helper may be
    // called for several wallets in one test, and the test clock can't rewind).
    if (BUY_NOW > clock::timestamp_ms(clock)) clock.set_for_testing(BUY_NOW);
    sc.next_tx(who);
    let mut ev = ts::take_shared_by_id<Event>(sc, eid);
    market::claim_free(&mut ev, who, clock, sc.ctx());
    ts::return_shared(ev);

    // self check-in
    if (USE_NOW > clock::timestamp_ms(clock)) clock.set_for_testing(USE_NOW);
    sc.next_tx(who);
    let mut ev = ts::take_shared_by_id<Event>(sc, eid);
    let mut t = sc.take_from_sender<Ticket>();
    checkin::self_check_in(&mut ev, &mut t, clock, sc.ctx());
    ts::return_shared(ev);

    // claim POAP for the checked-in ticket
    sc.next_tx(who);
    let mut ev = ts::take_shared_by_id<Event>(sc, eid);
    poap::claim_poap(&mut ev, &mut t, sc.ctx());
    sc.return_to_sender(t);
    ts::return_shared(ev);
}

// === happy path ===

#[test]
fun post_review_with_matching_poap_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER);

    // BUYER posts a review with their POAP + a valid rating.
    sc.next_tx(BUYER);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap, 5, s(b"blob-review-1"), &clock, sc.ctx());
    assert!(event::has_reviewed(&ev, BUYER), 0);
    sc.return_to_sender(poap);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// Boundary ratings 1 and 5 are both valid (inclusive range). One review per
// wallet is enforced on-chain, so the two boundary reviews come from two wallets.
#[test]
fun post_review_boundary_ratings_ok() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER);
    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER2);

    sc.next_tx(BUYER);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap, 1, s(b"blob-min"), &clock, sc.ctx());
    sc.return_to_sender(poap);
    ts::return_shared(ev);

    sc.next_tx(BUYER2);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap2 = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap2, 5, s(b"blob-max"), &clock, sc.ctx());
    sc.return_to_sender(poap2);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// One review per wallet: a second review from the same wallet aborts.
#[test, expected_failure(abort_code = hostit_ticket::reviews::E_ALREADY_REVIEWED)]
fun post_review_twice_same_wallet_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER);

    sc.next_tx(BUYER);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap, 4, s(b"blob-1"), &clock, sc.ctx());
    reviews::post_review(&mut ev, &poap, 2, s(b"blob-2"), &clock, sc.ctx()); // second -> abort
    sc.return_to_sender(poap);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === wrong-event POAP ===

// A POAP claimed for event A cannot review event B -> E_WRONG_EVENT.
#[test, expected_failure(abort_code = hostit_ticket::reviews::E_WRONG_EVENT)]
fun post_review_wrong_event_poap_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap_a = create_free_event(&mut sc, &clock, ORG); // event A
    let cap_b = create_free_event(&mut sc, &clock, ORG2); // event B
    let eid_a = event::cap_event_id(&cap_a);
    let eid_b = event::cap_event_id(&cap_b);

    // BUYER attends + claims a POAP for event A only.
    attend_and_claim_poap(&mut sc, &mut clock, &cap_a, eid_a, BUYER);

    // Try to review event B with event A's POAP -> abort.
    sc.next_tx(BUYER);
    let mut ev_b = ts::take_shared_by_id<Event>(&sc, eid_b);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev_b, &poap, 4, s(b"blob-x"), &clock, sc.ctx());
    sc.return_to_sender(poap);
    ts::return_shared(ev_b);

    destroy(cap_a);
    destroy(cap_b);
    clock.destroy_for_testing();
    sc.end();
}

// === bad rating ===

#[test, expected_failure(abort_code = hostit_ticket::reviews::E_BAD_RATING)]
fun post_review_rating_zero_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER);

    sc.next_tx(BUYER);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap, 0, s(b"blob-0"), &clock, sc.ctx()); // 0 < MIN_RATING
    sc.return_to_sender(poap);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::reviews::E_BAD_RATING)]
fun post_review_rating_six_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    attend_and_claim_poap(&mut sc, &mut clock, &cap, eid, BUYER);

    sc.next_tx(BUYER);
    let mut ev = ts::take_shared_by_id<Event>(&sc, eid);
    let poap = sc.take_from_sender<Poap>();
    reviews::post_review(&mut ev, &poap, 6, s(b"blob-6"), &clock, sc.ctx()); // 6 > MAX_RATING
    sc.return_to_sender(poap);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
