#[test_only]
module hostit_ticket::forum_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::Ticket;
use hostit_ticket::market;
use hostit_ticket::forum;

const ORG: address = @0x0123;
const ORG2: address = @0x0456;
const BUYER: address = @0xB0B;

const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000;
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const NOW: u64 = 50_000_000; // in [PSTART, END]

const ACTION_HIDE: u8 = 0;

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ORG);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create a FREE event as `who`; returns that organizer's cap. Free so a buyer
/// can `claim_free` a real Ticket for the ticket-path test.
fun create_free_event(sc: &mut Scenario, clock: &Clock, who: address): OrganizerCap {
    sc.next_tx(who);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Forum Fest"),
        s(b"FORUM"),
        s(b"https://img/forum.png"),
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

// === post_as_organizer ===

#[test]
fun organizer_posts_without_ticket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    clock.set_for_testing(NOW);

    sc.next_tx(ORG);
    let ev = sc.take_shared<Event>();
    // ORG holds no Ticket — the cap alone authorizes the post.
    forum::post_as_organizer(&ev, &cap, s(b"general"), s(b"blob-org-1"), &clock, sc.ctx());
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun post_as_organizer_wrong_cap_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap_a = create_free_event(&mut sc, &clock, ORG); // event A
    let cap_b = create_free_event(&mut sc, &clock, ORG2); // event B (different cap)
    clock.set_for_testing(NOW);

    // Take event A specifically and try to post with event B's cap → E_WRONG_CAP.
    let eid_a = event::cap_event_id(&cap_a);
    sc.next_tx(ORG2);
    let ev_a = ts::take_shared_by_id<Event>(&sc, eid_a);
    forum::post_as_organizer(&ev_a, &cap_b, s(b"general"), s(b"x"), &clock, sc.ctx());

    // unreachable (aborts above)
    ts::return_shared(ev_a);
    destroy(cap_a);
    destroy(cap_b);
    clock.destroy_for_testing();
    sc.end();
}

// === moderate ===

#[test]
fun organizer_moderates() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    clock.set_for_testing(NOW);

    sc.next_tx(ORG);
    let ev = sc.take_shared<Event>();
    forum::moderate(&ev, &cap, s(b"blob-to-hide"), ACTION_HIDE, &clock, sc.ctx());
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::forum::E_BAD_ACTION)]
fun moderate_unknown_action_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    clock.set_for_testing(NOW);

    sc.next_tx(ORG);
    let ev = sc.take_shared<Event>();
    forum::moderate(&ev, &cap, s(b"blob"), 9, &clock, sc.ctx()); // 9 > MAX_ACTION

    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun moderate_wrong_cap_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap_a = create_free_event(&mut sc, &clock, ORG);
    let cap_b = create_free_event(&mut sc, &clock, ORG2);
    clock.set_for_testing(NOW);

    let eid_a = event::cap_event_id(&cap_a);
    sc.next_tx(ORG2);
    let ev_a = ts::take_shared_by_id<Event>(&sc, eid_a);
    forum::moderate(&ev_a, &cap_b, s(b"blob"), ACTION_HIDE, &clock, sc.ctx());

    ts::return_shared(ev_a);
    destroy(cap_a);
    destroy(cap_b);
    clock.destroy_for_testing();
    sc.end();
}

// === ticket-holder post still works ===

#[test]
fun ticket_holder_posts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock, ORG);
    clock.set_for_testing(NOW);

    // BUYER claims a free ticket.
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    // BUYER posts with that ticket.
    sc.next_tx(BUYER);
    let ev = sc.take_shared<Event>();
    let ticket = sc.take_from_sender<Ticket>();
    forum::post(&ev, &ticket, s(b"general"), s(b"blob-buyer-1"), &clock, sc.ctx());
    sc.return_to_sender(ticket);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
