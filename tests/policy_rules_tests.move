#[test_only]
/// Tests for the HostIt `TransferPolicy<Ticket>` rules (ISSUES #5 royalty+lock,
/// #6 not_used). Each rule gets a positive (allowed) and negative (aborts) case.
module hostit_ticket::policy_rules_tests;

use sui::test_scenario::{Self as ts, Scenario};
use std::unit_test::destroy;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::kiosk;
use sui::sui::SUI;
use sui::transfer_policy::{Self as policy, TransferPolicy, TransferPolicyCap};
use std::string;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Ticket};
use hostit_ticket::market;
use hostit_ticket::checkin;
use hostit_ticket::policy_rules;

const ADMIN: address = @0xA1;
const ORG: address = @0x0123;
const BUYER: address = @0xB0B;

const CREATE_NOW: u64 = 1_000_000;
const START: u64 = 100_000_000;
const END: u64 = 186_400_000; // START + DAY
const PSTART: u64 = 13_600_000; // START - DAY
const BUY_NOW: u64 = 50_000_000; // in [PSTART, END]
const USE_NOW: u64 = 120_000_000; // in [START, END]; day 0

// === Helpers ===

fun begin(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    hub::init_for_testing(sc.ctx());
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun s(b: vector<u8>): string::String { string::utf8(b) }

/// Create a free event as ORG (free events let us `claim_free` a Ticket without
/// wiring up payment/escrow — the policy rules don't care about price).
fun create_free_event(sc: &mut Scenario, clock: &Clock): OrganizerCap {
    sc.next_tx(ORG);
    let mut hub = sc.take_shared<Hub>();
    let cap = event::create_event(
        &mut hub,
        s(b"Sui Overflow"),
        s(b"SUIO"),
        s(b"https://img/ticket.png"),
        START, END, PSTART, 100, 5,
        true, // free
        false,
        clock,
        sc.ctx(),
    );
    ts::return_shared(hub);
    cap
}

/// Mint a fresh Ticket to BUYER via the free-claim path; returns it taken.
fun claim_ticket(sc: &mut Scenario, clock: &Clock): Ticket {
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, clock, sc.ctx());
    ts::return_shared(ev);
    sc.next_tx(BUYER);
    sc.take_from_sender<Ticket>()
}

// === not_used rule (#6) ===

#[test]
/// Positive: an ISSUED (unused) ticket proves not-used and the request confirms.
fun not_used_allows_unused_ticket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);
    clock.set_for_testing(BUY_NOW);
    let t = claim_ticket(&mut sc, &clock);

    sc.next_tx(BUYER);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_not_used_rule(&mut tp, &tp_cap);

    let mut req = policy::new_request<Ticket>(object::id(&t), 0, object::id(&t));
    policy_rules::prove_not_used(&mut req, &t);
    policy::confirm_request(&tp, req);

    destroy(t);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::policy_rules::E_TICKET_USED)]
/// Negative: a CHECKED_IN ("used") ticket aborts when proving not-used.
fun not_used_blocks_checked_in_ticket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);

    // enable self check-in
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    let mut t = claim_ticket(&mut sc, &clock);

    // check the ticket in -> status becomes CHECKED_IN
    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
    ts::return_shared(ev);

    sc.next_tx(BUYER);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_not_used_rule(&mut tp, &tp_cap);

    let mut req = policy::new_request<Ticket>(object::id(&t), 0, object::id(&t));
    policy_rules::prove_not_used(&mut req, &t); // aborts: ticket used

    policy::confirm_request(&tp, req);
    destroy(t);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::policy_rules::E_WRONG_ITEM)]
/// Negative: proving with a ticket whose id != request.item aborts (anti-swap).
fun not_used_blocks_mismatched_item() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);
    clock.set_for_testing(BUY_NOW);
    let t = claim_ticket(&mut sc, &clock);

    sc.next_tx(BUYER);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_not_used_rule(&mut tp, &tp_cap);

    // request references some *other* id
    let other = object::id_from_address(@0xDEAD);
    let mut req = policy::new_request<Ticket>(other, 0, other);
    policy_rules::prove_not_used(&mut req, &t); // aborts: wrong item

    policy::confirm_request(&tp, req);
    destroy(t);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}

// === royalty rule (#5) ===

#[test]
/// Positive: royalty fee is split off the payment and accrues to the policy.
fun royalty_charges_fee() {
    let (mut sc, _clock) = begin();
    sc.next_tx(ADMIN);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    // 5% royalty
    policy_rules::add_royalty_rule(&mut tp, &tp_cap, 500);
    assert!(policy_rules::royalty_amount_bp(&tp) == 500, 0);

    // sale price 100_000 -> 5% = 5_000 fee
    let item = object::id_from_address(@0xABC);
    let mut req = policy::new_request<Ticket>(item, 100_000, item);
    let mut pay = coin::mint_for_testing<SUI>(10_000, sc.ctx());
    policy_rules::pay_royalty(&mut tp, &mut req, &mut pay, sc.ctx());
    assert!(coin::value(&pay) == 5_000, 1); // 10_000 - 5_000

    policy::confirm_request(&tp, req);
    coin::burn_for_testing(pay);

    sc.next_tx(ADMIN);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    assert!(coin::value(&profits) == 5_000, 2);
    coin::burn_for_testing(profits);
    _clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::policy_rules::E_INSUFFICIENT_ROYALTY)]
/// Negative: payment smaller than the required royalty fee aborts.
fun royalty_insufficient_payment_fails() {
    let (mut sc, _clock) = begin();
    sc.next_tx(ADMIN);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_royalty_rule(&mut tp, &tp_cap, 500); // 5%

    let item = object::id_from_address(@0xABC);
    let mut req = policy::new_request<Ticket>(item, 100_000, item); // fee = 5_000
    let mut pay = coin::mint_for_testing<SUI>(4_999, sc.ctx()); // too little
    policy_rules::pay_royalty(&mut tp, &mut req, &mut pay, sc.ctx()); // aborts

    policy::confirm_request(&tp, req);
    coin::burn_for_testing(pay);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    _clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::policy_rules::E_BPS_TOO_HIGH)]
/// Negative: configuring royalty above 100% aborts at attach time.
fun royalty_bps_too_high_fails() {
    let (mut sc, _clock) = begin();
    sc.next_tx(ADMIN);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_royalty_rule(&mut tp, &tp_cap, 10_001); // > 100%

    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    _clock.destroy_for_testing();
    sc.end();
}

// === lock rule (#5) ===

#[test]
/// Positive: a ticket locked into a Kiosk proves the lock requirement.
fun lock_allows_locked_ticket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);
    clock.set_for_testing(BUY_NOW);
    let t = claim_ticket(&mut sc, &clock);
    let item = object::id(&t);

    sc.next_tx(BUYER);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_lock_rule(&mut tp, &tp_cap);

    // lock the ticket into a kiosk (the destination the buyer would lock into)
    let (mut k, k_cap) = kiosk::new(sc.ctx());
    kiosk::lock(&mut k, &k_cap, &tp, t);

    let mut req = policy::new_request<Ticket>(item, 0, item);
    policy_rules::prove_locked(&mut req, &k);
    policy::confirm_request(&tp, req);

    // tidy up: list+take needs the lock cleared; just destroy the kiosk contents
    // via take after delist is not possible while locked, so drop kiosk as-is.
    transfer::public_share_object(k);
    destroy(k_cap);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = hostit_ticket::policy_rules::E_NOT_IN_KIOSK)]
/// Negative: a ticket NOT locked into the Kiosk fails the lock proof.
fun lock_blocks_unlocked_ticket() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);
    clock.set_for_testing(BUY_NOW);
    let t = claim_ticket(&mut sc, &clock);
    let item = object::id(&t);

    sc.next_tx(BUYER);
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    policy_rules::add_lock_rule(&mut tp, &tp_cap);

    // empty kiosk — the ticket was never locked in
    let (k, k_cap) = kiosk::new(sc.ctx());

    let mut req = policy::new_request<Ticket>(item, 0, item);
    policy_rules::prove_locked(&mut req, &k); // aborts: not in kiosk

    policy::confirm_request(&tp, req);
    destroy(t);
    transfer::public_share_object(k);
    destroy(k_cap);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}

// === full rule set (#5 + #6 together) ===

#[test]
/// Positive end-to-end: all three rules attached, all three receipts added,
/// request confirms — the shape a real resale PTB produces.
fun full_ruleset_confirms() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_free_event(&mut sc, &clock);
    clock.set_for_testing(BUY_NOW);
    let t = claim_ticket(&mut sc, &clock);
    let item = object::id(&t);

    sc.next_tx(BUYER);
    let mut hub = sc.take_shared<Hub>();
    let (mut tp, tp_cap) = policy::new_for_testing<Ticket>(sc.ctx());
    // seed from hub.royalty_bps (default 500 = 5%) + not_used + lock
    policy_rules::setup_ticket_policy(&mut tp, &tp_cap, &hub);
    assert!(policy_rules::royalty_amount_bp(&tp) == (hub::royalty_bps(&hub) as u16), 0);
    ts::return_shared(hub);

    // pay royalty on a 100_000 sale, prove not-used, then lock + prove lock
    let mut req = policy::new_request<Ticket>(item, 100_000, item);
    let mut pay = coin::mint_for_testing<SUI>(100_000, sc.ctx());
    policy_rules::pay_royalty(&mut tp, &mut req, &mut pay, sc.ctx());
    policy_rules::prove_not_used(&mut req, &t);

    let (mut k, k_cap) = kiosk::new(sc.ctx());
    kiosk::lock(&mut k, &k_cap, &tp, t);
    policy_rules::prove_locked(&mut req, &k);

    policy::confirm_request(&tp, req);

    coin::burn_for_testing(pay);
    transfer::public_share_object(k);
    destroy(k_cap);
    destroy(cap);
    let profits = tp.destroy_and_withdraw(tp_cap, sc.ctx());
    assert!(coin::value(&profits) == 5_000, 1); // 5% of 100_000
    coin::burn_for_testing(profits);
    clock.destroy_for_testing();
    sc.end();
}
