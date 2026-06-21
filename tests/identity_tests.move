#[test_only]
/// Tests for the account identity layer (GH#96): email-hash uniqueness registry,
/// opt-in EmailGrant consent, and the `access::seal_approve_attendee_email`
/// selective-disclosure policy — including the P0-B regression that an attendee's
/// email grant must NOT reach their bare-self (KYC/drafts) namespace.
module hostit_ticket::identity_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::address;
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::identity::{Self, EmailRegistry, EmailGrant};
use hostit_ticket::access;

const ORG: address = @0x0123;
const ORG2: address = @0x0456;
const USER: address = @0xB0B;
const USER2: address = @0xB0B2;

const START: u64 = 100_000_000;
const END: u64 = 186_400_000;
const PSTART: u64 = 13_600_000;

const HASH_A: vector<u8> = b"hmac-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ORG);
    hub::init_for_testing(sc.ctx());
    identity::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create an event as `who`; returns the OrganizerCap (Event is shared).
fun make_event(sc: &mut Scenario, clock: &Clock, who: address): OrganizerCap {
    sc.next_tx(who);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub, s(b"Identity Fest"), s(b"IDN"), s(b"https://img/i.png"),
        START, END, PSTART, 100, 5, true, false, clock, sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

/// An email Seal id for `user`: EMAIL_NS_TAG ‖ user ‖ nonce.
fun email_id(user: address): vector<u8> {
    let mut id = access::email_ns_for_test(user);
    id.append(b"-nonce-7f3a");
    id
}

/// A bare-self (KYC/drafts) Seal id for `user`: address ‖ nonce.
fun self_id(user: address): vector<u8> {
    let mut id = address::to_bytes(user);
    id.append(b"-nonce-7f3a");
    id
}

// === uniqueness registry ===

#[test]
fun register_then_idempotent_same_owner() {
    let (mut sc, clock) = begin();
    sc.next_tx(USER);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    assert!(identity::is_registered(&reg, HASH_A), 0);
    assert!(identity::owner_of(&reg, HASH_A) == USER, 1);
    // same owner re-registers → no-op, no abort
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    ts::return_shared(reg);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::identity::E_EMAIL_TAKEN)]
fun register_taken_by_other_aborts() {
    let (mut sc, clock) = begin();
    sc.next_tx(USER);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    ts::return_shared(reg);

    sc.next_tx(USER2);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx()); // taken by USER -> abort
    ts::return_shared(reg);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
fun unregister_frees_slot() {
    let (mut sc, clock) = begin();
    sc.next_tx(USER);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    identity::unregister_email(&mut reg, HASH_A, sc.ctx());
    assert!(!identity::is_registered(&reg, HASH_A), 0);
    ts::return_shared(reg);

    // a different owner can now claim it
    sc.next_tx(USER2);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    assert!(identity::owner_of(&reg, HASH_A) == USER2, 1);
    ts::return_shared(reg);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::identity::E_NOT_OWNER)]
fun unregister_by_other_aborts() {
    let (mut sc, clock) = begin();
    sc.next_tx(USER);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::register_email(&mut reg, HASH_A, sc.ctx());
    ts::return_shared(reg);

    sc.next_tx(USER2);
    let mut reg = sc.take_shared<EmailRegistry>();
    identity::unregister_email(&mut reg, HASH_A, sc.ctx()); // not owner -> abort
    ts::return_shared(reg);
    clock.destroy_for_testing();
    sc.end();
}

// === grant + revoke ===

#[test]
fun grant_and_revoke() {
    let (mut sc, clock) = begin();
    let cap = make_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    sc.next_tx(USER);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    identity::grant_email_access(&ev, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(USER);
    let grant = sc.take_shared<EmailGrant>();
    assert!(identity::grant_user(&grant) == USER, 0);
    assert!(identity::grant_event_id(&grant) == eid, 1);
    identity::revoke_email_grant(grant, sc.ctx()); // owner revokes (consumes)

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::identity::E_NOT_OWNER)]
fun revoke_by_other_aborts() {
    let (mut sc, clock) = begin();
    let cap = make_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    sc.next_tx(USER);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    identity::grant_email_access(&ev, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(USER2);
    let grant = sc.take_shared<EmailGrant>();
    identity::revoke_email_grant(grant, sc.ctx()); // not the grant user -> abort

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// === seal_approve_attendee_email policy ===

#[test]
fun attendee_email_policy_ok() {
    let (mut sc, clock) = begin();
    let cap = make_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    sc.next_tx(USER);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    identity::grant_email_access(&ev, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(ORG);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    let grant = sc.take_shared<EmailGrant>();
    // organizer (cap) + grant for this event + USER's email-ns id -> OK
    access::check_attendee_email(email_id(USER), &cap, &ev, &grant);
    ts::return_shared(grant);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// P0-B regression: an email grant must NOT authorize the user's bare-self
// (KYC/drafts) namespace.
#[test, expected_failure(abort_code = hostit_ticket::access::E_NO_ACCESS)]
fun attendee_email_policy_rejects_self_namespace() {
    let (mut sc, clock) = begin();
    let cap = make_event(&mut sc, &clock, ORG);
    let eid = event::cap_event_id(&cap);

    sc.next_tx(USER);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    identity::grant_email_access(&ev, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(ORG);
    let ev = ts::take_shared_by_id<Event>(&sc, eid);
    let grant = sc.take_shared<EmailGrant>();
    access::check_attendee_email(self_id(USER), &cap, &ev, &grant); // KYC ns -> abort
    ts::return_shared(grant);
    ts::return_shared(ev);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}

// Grant minted for event A cannot unlock email when checked against event B.
#[test, expected_failure(abort_code = hostit_ticket::access::E_NO_ACCESS)]
fun attendee_email_policy_rejects_wrong_event() {
    let (mut sc, clock) = begin();
    let capA = make_event(&mut sc, &clock, ORG);
    let capB = make_event(&mut sc, &clock, ORG2);
    let eidA = event::cap_event_id(&capA);
    let eidB = event::cap_event_id(&capB);

    // USER grants for event A
    sc.next_tx(USER);
    let evA = ts::take_shared_by_id<Event>(&sc, eidA);
    identity::grant_email_access(&evA, sc.ctx());
    ts::return_shared(evA);

    sc.next_tx(ORG2);
    let evB = ts::take_shared_by_id<Event>(&sc, eidB);
    let grant = sc.take_shared<EmailGrant>(); // grant.event_id == A
    access::check_attendee_email(email_id(USER), &capB, &evB, &grant); // grant != event B -> abort
    ts::return_shared(grant);
    ts::return_shared(evB);

    destroy(capA);
    destroy(capB);
    clock.destroy_for_testing();
    sc.end();
}

// Wrong organizer cap -> assert_organizer aborts (event::E_WRONG_CAP).
#[test, expected_failure(abort_code = hostit_ticket::event::E_WRONG_CAP)]
fun attendee_email_policy_rejects_wrong_cap() {
    let (mut sc, clock) = begin();
    let capA = make_event(&mut sc, &clock, ORG);
    let capB = make_event(&mut sc, &clock, ORG2);
    let eidA = event::cap_event_id(&capA);

    sc.next_tx(USER);
    let evA = ts::take_shared_by_id<Event>(&sc, eidA);
    identity::grant_email_access(&evA, sc.ctx());
    ts::return_shared(evA);

    sc.next_tx(ORG2);
    let evA = ts::take_shared_by_id<Event>(&sc, eidA);
    let grant = sc.take_shared<EmailGrant>();
    access::check_attendee_email(email_id(USER), &capB, &evA, &grant); // capB not for event A
    ts::return_shared(grant);
    ts::return_shared(evA);

    destroy(capA);
    destroy(capB);
    clock.destroy_for_testing();
    sc.end();
}

// === own-email policy ===

#[test]
fun own_email_policy() {
    let (mut sc, clock) = begin();
    sc.next_tx(USER);
    // owner's own email id passes; their bare-self (KYC) id does not match the
    // email policy (it's served by seal_approve_self instead).
    assert!(access::check_own_email(email_id(USER), sc.ctx()), 0);
    assert!(!access::check_own_email(self_id(USER), sc.ctx()), 1);
    clock.destroy_for_testing();
    sc.end();
}
