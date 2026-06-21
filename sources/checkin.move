/// Proof of attendance. Replaces the EVM CheckInFacet.
///
/// EVM impedance: an admin there flips `_used[tokenId]` in global storage. On
/// Sui a `Ticket` is an *owned* object, so a staff member's transaction can't
/// touch it. We keep the ticket owned by the attendee (who signs the check-in
/// tx, gas-sponsorable for a one-tap UX) and gate it with an off-chain
/// **ed25519 voucher** the staff device signs: `{event_id, ticket_id, expiry}`.
/// On-chain we verify the voucher against the event's registered signer set —
/// so both parties authorize, in a single attendee-signed transaction.
///
/// `self_check_in` is the lean fallback (attendee-only, no staff voucher) and is
/// off unless the organizer enables `allow_self_checkin`.
///
/// Multi-day events: a ticket can be checked in once *per day* across the event
/// window (the EVM's `useTicket` was idempotent and never blocked re-entry; the
/// real gate was the per-day owner set). We accept any non-refunded ticket and
/// rely on the Event's per-(day, ticket) guard — a wallet holding several tickets
/// can check each one in once per day; the ticket's CHECKED_IN status is just an
/// idempotent "has been used" marker for resale purposes.
module hostit_ticket::checkin;

use std::bcs;
use sui::clock::{Self, Clock};
use sui::ed25519;
use sui::event as sui_event;
use hostit_ticket::event::{Self, Event};
use hostit_ticket::ticket::{Self, Ticket};

// === Errors ===

const E_WRONG_EVENT: u64 = 1;
const E_TICKET_REFUNDED: u64 = 2;
const E_USE_NOT_STARTED: u64 = 3;
const E_USE_ENDED: u64 = 4;
const E_VOUCHER_EXPIRED: u64 = 5;
const E_NOT_AUTHORIZED_SIGNER: u64 = 6;
const E_BAD_VOUCHER: u64 = 7;
const E_SELF_CHECKIN_DISABLED: u64 = 8;

// === Events ===

public struct CheckedIn has copy, drop {
    event_seq: u64,
    event_id: ID,
    ticket_id: ID,
    attendee: address,
    day: u64,
    serial: u64,
}

// === Check-in (voucher-gated) ===

/// Attendee submits this (gas-sponsorable) presenting a staff-signed voucher.
/// `signer_pubkey` must be a registered check-in signer; `signature` must be a
/// valid ed25519 signature over `{event_id || ticket_id || expiry}`.
public fun check_in(
    event: &mut Event,
    ticket: &mut Ticket,
    signer_pubkey: vector<u8>,
    signature: vector<u8>,
    voucher_expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let event_id = object::id(event);
    assert!(ticket::event_id(ticket) == event_id, E_WRONG_EVENT);
    assert!(!ticket::is_refunded(ticket), E_TICKET_REFUNDED);

    let now = clock::timestamp_ms(clock);
    assert!(now >= event::start_ms(event), E_USE_NOT_STARTED);
    assert!(now <= event::end_ms(event), E_USE_ENDED);
    assert!(now <= voucher_expiry_ms, E_VOUCHER_EXPIRED);

    assert!(event::is_checkin_signer(event, &signer_pubkey), E_NOT_AUTHORIZED_SIGNER);
    let msg = build_voucher_msg(event_id, object::id(ticket), voucher_expiry_ms);
    assert!(ed25519::ed25519_verify(&signature, &signer_pubkey, &msg), E_BAD_VOUCHER);

    record_and_mark(event, ticket, now, ctx);
}

/// Attendee-only check-in. Only callable when the organizer has enabled
/// `allow_self_checkin` (weaker attendance proof, no staff key management).
public fun self_check_in(
    event: &mut Event,
    ticket: &mut Ticket,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(event::allow_self_checkin(event), E_SELF_CHECKIN_DISABLED);
    assert!(ticket::event_id(ticket) == object::id(event), E_WRONG_EVENT);
    assert!(!ticket::is_refunded(ticket), E_TICKET_REFUNDED);

    let now = clock::timestamp_ms(clock);
    assert!(now >= event::start_ms(event), E_USE_NOT_STARTED);
    assert!(now <= event::end_ms(event), E_USE_ENDED);

    record_and_mark(event, ticket, now, ctx);
}

// === Internal ===

fun record_and_mark(event: &mut Event, ticket: &mut Ticket, now: u64, ctx: &TxContext) {
    let day = (now - event::start_ms(event)) / event::day_ms();
    let who = ctx.sender();
    let ticket_id = object::id(ticket);
    // Aborts if THIS TICKET already checked in on `day` (once-per-day-per-ticket).
    event::record_checkin(event, day, ticket_id, who);
    // Count distinct tickets, not day-entries: only bump on the FIRST check-in of
    // this ticket (status is still ISSUED before we mark it).
    let first_checkin = !ticket::is_checked_in(ticket);
    ticket::set_checked_in(ticket);
    if (first_checkin) event::inc_checked_in_count(event);
    sui_event::emit(CheckedIn {
        event_seq: event::event_seq(event),
        event_id: object::id(event),
        ticket_id: object::id(ticket),
        attendee: who,
        day,
        serial: ticket::serial(ticket),
    });
}

/// The exact bytes a staff device must sign: `event_id (32) || ticket_id (32) ||
/// expiry_ms (8, little-endian)`.
fun build_voucher_msg(event_id: ID, ticket_id: ID, expiry_ms: u64): vector<u8> {
    let mut msg = object::id_to_bytes(&event_id);
    msg.append(object::id_to_bytes(&ticket_id));
    msg.append(bcs::to_bytes(&expiry_ms));
    msg
}

#[test_only]
/// Test seam: the exact bytes a staff device signs. Pin this against
/// `web/lib/staffKey.ts` so a layout/endianness drift fails a test, not a door.
public fun voucher_msg_for_test(event_id: ID, ticket_id: ID, expiry_ms: u64): vector<u8> {
    build_voucher_msg(event_id, ticket_id, expiry_ms)
}
