/// Seal access policies for HostIt. These `seal_approve*` entry functions are
/// dry-run by Seal's key servers to decide whether a caller may obtain the
/// decryption key shares for a ciphertext (stored on Walrus). Convention:
/// name starts with `seal_approve`, first param is `id: vector<u8>` (the Seal
/// identity = policy-object-id bytes ‖ nonce), the function must not mutate
/// state, and an abort means access denied.
///
/// - `seal_approve_ticket`   → ticket-holder-gated content (event forum, gated
///   info): caller owns a Ticket for the event, id namespaced to the event.
/// - `seal_approve_organizer`→ organizer-gated data (attendee/KYC list): caller
///   holds the event's OrganizerCap.
/// - `seal_approve_self`     → account-based: id namespaced to the caller's own
///   address (a user's own KYC/PII — only they decrypt).
module hostit_ticket::access;

use sui::address;
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};

const E_NO_ACCESS: u64 = 1;

/// True iff `prefix` is a prefix of `id`.
fun is_prefix(prefix: &vector<u8>, id: &vector<u8>): bool {
    let plen = prefix.length();
    if (plen > id.length()) return false;
    let mut i = 0;
    while (i < plen) {
        if (*prefix.borrow(i) != *id.borrow(i)) return false;
        i = i + 1;
    };
    true
}

entry fun seal_approve_ticket(id: vector<u8>, ticket: &Ticket, event: &Event) {
    let eid = object::id(event);
    assert!(ticket::event_id(ticket) == eid, E_NO_ACCESS);
    assert!(is_prefix(&object::id_to_bytes(&eid), &id), E_NO_ACCESS);
}

entry fun seal_approve_organizer(id: vector<u8>, cap: &OrganizerCap, event: &Event) {
    event::assert_organizer(cap, event);
    let eid = object::id(event);
    assert!(is_prefix(&object::id_to_bytes(&eid), &id), E_NO_ACCESS);
}

entry fun seal_approve_self(id: vector<u8>, ctx: &TxContext) {
    assert!(is_prefix(&address::to_bytes(ctx.sender()), &id), E_NO_ACCESS);
}

// === Test-only ===

#[test_only]
public fun check_prefix(prefix: vector<u8>, id: vector<u8>): bool { is_prefix(&prefix, &id) }
