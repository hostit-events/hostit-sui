/// The ticket NFT. One global `Ticket` type serves every event (the EVM design
/// cloned a fresh ERC721 per event; Move types are static, so per-event identity
/// is the `event_id` field, not the type). A single `Display<Ticket>` renders
/// all of them. `key + store` so tickets are ordinary owned objects: freely
/// transferable peer-to-peer and Kiosk-listable.
module hostit_ticket::ticket;

use std::ascii;
use std::string::{Self, String};
use sui::display::{Self, Display};
use sui::package::Publisher;

// === Status ===
// ISSUED:      never used.
// CHECKED_IN:  used at least once. Mirrors the EVM `_used` flag — a "has been
//              used" marker that gates resale (v2 policy). It is NOT the per-day
//              entry gate: multi-day attendance is tracked per (day, attendee)
//              on the Event, so a CHECKED_IN ticket can still be checked in on a
//              later day (matching the EVM, whose `useTicket` was idempotent).
// REFUNDED:    returned to the organizer; terminal, not checkable.
const STATUS_ISSUED: u8 = 0;
const STATUS_CHECKED_IN: u8 = 1;
const STATUS_REFUNDED: u8 = 2;

public struct Ticket has key, store {
    id: UID,
    /// EVM-style sequential event id (parity + Display). The Event object id is
    /// the real binding (`event_id`).
    event_seq: u64,
    /// Object id of the `Event` this ticket belongs to. Checked everywhere a
    /// ticket and an event meet.
    event_id: ID,
    /// 1-indexed per-event serial == the event's `minted` count at mint time
    /// (parity with EVM `tokenId == soldTickets`).
    serial: u64,
    status: u8,
    /// Amount paid at mint, in the coin's smallest unit (0 for free tickets).
    /// Stored so refunds return exactly what was paid (the EVM refunded the
    /// *current* fee, which can drift — storing `paid` is the safer port).
    paid: u64,
    /// Fully-qualified coin type the ticket was paid in (e.g. `0x2::sui::SUI`).
    /// `refund<T>` asserts `T` matches this.
    paid_type: ascii::String,
    name: String,
    image_url: String,
}

// === Display (called from hub::init with the package Publisher) ===

public(package) fun init_display(publisher: &Publisher, ctx: &mut TxContext): Display<Ticket> {
    let keys = vector[
        string::utf8(b"name"),
        string::utf8(b"image_url"),
        string::utf8(b"description"),
        string::utf8(b"serial"),
        string::utf8(b"project_url"),
    ];
    let values = vector[
        string::utf8(b"{name} #{serial}"),
        string::utf8(b"{image_url}"),
        string::utf8(b"Ticket on HostIt"),
        string::utf8(b"{serial}"),
        string::utf8(b"https://hostit.events"),
    ];
    let mut d = display::new_with_fields<Ticket>(publisher, keys, values, ctx);
    display::update_version(&mut d);
    d
}

// === Mint / lifecycle (package-internal; market & checkin drive these) ===

public(package) fun mint(
    event_seq: u64,
    event_id: ID,
    serial: u64,
    paid: u64,
    paid_type: ascii::String,
    name: String,
    image_url: String,
    ctx: &mut TxContext,
): Ticket {
    Ticket {
        id: object::new(ctx),
        event_seq,
        event_id,
        serial,
        status: STATUS_ISSUED,
        paid,
        paid_type,
        name,
        image_url,
    }
}

/// Idempotent "has been used" marker. Safe to call on an already-CHECKED_IN
/// ticket (multi-day re-entry) — the per-day gate lives on the Event.
public(package) fun set_checked_in(t: &mut Ticket) {
    t.status = STATUS_CHECKED_IN;
}

public(package) fun set_refunded(t: &mut Ticket) {
    t.status = STATUS_REFUNDED;
}

// === Reads ===

public fun event_id(t: &Ticket): ID { t.event_id }
public fun event_seq(t: &Ticket): u64 { t.event_seq }
public fun serial(t: &Ticket): u64 { t.serial }
public fun status(t: &Ticket): u8 { t.status }
public fun paid(t: &Ticket): u64 { t.paid }
public fun paid_type(t: &Ticket): ascii::String { t.paid_type }
public fun is_issued(t: &Ticket): bool { t.status == STATUS_ISSUED }
public fun is_checked_in(t: &Ticket): bool { t.status == STATUS_CHECKED_IN }
public fun is_refunded(t: &Ticket): bool { t.status == STATUS_REFUNDED }

public fun status_issued(): u8 { STATUS_ISSUED }
public fun status_checked_in(): u8 { STATUS_CHECKED_IN }
public fun status_refunded(): u8 { STATUS_REFUNDED }
