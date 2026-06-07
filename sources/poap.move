/// Proof-of-attendance collectibles (POAP). A `Poap` NFT is claimable once per
/// ticket, only after that ticket has been checked in — so it genuinely proves
/// the holder attended. Dedup is tracked in a shared `PoapRegistry` so no change
/// to the `Event`/`Ticket` structs is needed. Renders via its own `Display<Poap>`.
#[allow(lint(self_transfer))]
module hostit_ticket::poap;

use std::string::{Self, String};
use sui::display;
use sui::event as sui_event;
use sui::package;
use sui::table::{Self, Table};
use hostit_ticket::event::{Self, Event};
use hostit_ticket::ticket::{Self, Ticket};

const E_WRONG_EVENT: u64 = 1;
const E_NOT_CHECKED_IN: u64 = 2;
const E_ALREADY_CLAIMED: u64 = 3;

public struct POAP has drop {} // one-time witness

public struct Poap has key, store {
    id: UID,
    event_id: ID,
    event_seq: u64,
    name: String,
    image_url: String,
}

/// Shared dedup registry: one POAP per ticket.
public struct PoapRegistry has key {
    id: UID,
    claimed: Table<ID, bool>,
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

    transfer::share_object(PoapRegistry { id: object::new(ctx), claimed: table::new(ctx) });
}

/// Claim a POAP for a checked-in ticket. The caller must own the ticket (passed
/// by ref → must be a valid owned input). One claim per ticket.
public fun claim_poap(
    reg: &mut PoapRegistry,
    event: &Event,
    ticket: &Ticket,
    ctx: &mut TxContext,
) {
    assert!(ticket::event_id(ticket) == object::id(event), E_WRONG_EVENT);
    assert!(ticket::is_checked_in(ticket), E_NOT_CHECKED_IN);
    let tid = object::id(ticket);
    assert!(!table::contains(&reg.claimed, tid), E_ALREADY_CLAIMED);
    table::add(&mut reg.claimed, tid, true);

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
        ticket_id: tid,
        poap_id: object::id(&poap),
        recipient: ctx.sender(),
    });
    transfer::public_transfer(poap, ctx.sender());
}

public fun has_claimed(reg: &PoapRegistry, ticket_id: ID): bool {
    table::contains(&reg.claimed, ticket_id)
}

public fun poap_event_seq(p: &Poap): u64 { p.event_seq }
public fun poap_name(p: &Poap): &String { &p.name }

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(POAP {}, ctx); }
