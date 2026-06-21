/// Proof-of-attendance collectibles (POAP). A `Poap` NFT is claimable once per
/// ticket, only after that ticket has been checked in — so it genuinely proves
/// the holder attended. One-per-ticket dedup lives on the (owned) `Ticket` via
/// its `poap_claimed` flag — a local write with no shared-object contention (the
/// old design used a single shared `PoapRegistry`, which serialized every claim
/// across all events). Renders via its own `Display<Poap>`.
#[allow(lint(self_transfer))]
module hostit_ticket::poap;

use std::string::{Self, String};
use sui::display;
use sui::event as sui_event;
use sui::package;
use hostit_ticket::event::{Self, Event};
use hostit_ticket::ticket::{Self, Ticket};

const E_WRONG_EVENT: u64 = 1;
const E_NOT_CHECKED_IN: u64 = 2;
const E_ALREADY_CLAIMED: u64 = 3;
/// POAP claiming has been disabled for this event by the organizer.
const E_POAP_DISABLED: u64 = 4;

public struct POAP has drop {} // one-time witness

public struct Poap has key, store {
    id: UID,
    event_id: ID,
    event_seq: u64,
    name: String,
    image_url: String,
}

public struct PoapClaimed has copy, drop {
    event_seq: u64,
    event_id: ID,
    ticket_id: ID,
    poap_id: ID,
    recipient: address,
}

fun init(otw: POAP, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);
    let keys = vector[
        string::utf8(b"name"),
        string::utf8(b"image_url"),
        string::utf8(b"description"),
        string::utf8(b"project_url"),
    ];
    let values = vector[
        string::utf8(b"{name} — POAP"),
        string::utf8(b"{image_url}"),
        string::utf8(b"HostIt proof of attendance"),
        string::utf8(b"https://hostit.events"),
    ];
    let mut d = display::new_with_fields<Poap>(&publisher, keys, values, ctx);
    display::update_version(&mut d);
    transfer::public_transfer(d, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
}

/// Claim a POAP for a checked-in ticket. The caller owns the ticket (passed by
/// `&mut` → a valid owned input they control), so the one-per-ticket guard is a
/// local flag on the ticket — no shared registry. Aborts if the event has POAP
/// claiming disabled, the ticket isn't checked in, or it already claimed.
public fun claim_poap(
    event: &mut Event,
    ticket: &mut Ticket,
    ctx: &mut TxContext,
) {
    assert!(ticket::event_id(ticket) == object::id(event), E_WRONG_EVENT);
    assert!(event::poap_enabled(event), E_POAP_DISABLED);
    assert!(ticket::is_checked_in(ticket), E_NOT_CHECKED_IN);
    assert!(!ticket::poap_claimed(ticket), E_ALREADY_CLAIMED);
    ticket::set_poap_claimed(ticket);
    event::inc_poap_claimed_count(event);

    let poap = Poap {
        id: object::new(ctx),
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        name: event::name_clone(event),
        image_url: event::uri_clone(event),
    };
    sui_event::emit(PoapClaimed {
        event_seq: event::event_seq(event),
        event_id: object::id(event),
        ticket_id: object::id(ticket),
        poap_id: object::id(&poap),
        recipient: ctx.sender(),
    });
    transfer::public_transfer(poap, ctx.sender());
}

public fun poap_event_seq(p: &Poap): u64 { p.event_seq }
public fun poap_name(p: &Poap): &String { &p.name }
/// Object id of the `Event` this POAP attests attendance for. Read cross-module
/// (e.g. `reviews::post_review`) to prove a POAP belongs to a given event.
public fun event_id(p: &Poap): ID { p.event_id }

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(POAP {}, ctx); }
