/// Seal access policies for HostIt. These `seal_approve*` entry functions are
/// dry-run by Seal's key servers to decide whether a caller may obtain the
/// decryption key shares for a ciphertext (stored on Walrus). Convention:
/// name starts with `seal_approve`, first param is `id: vector<u8>` (the Seal
/// identity = policy-object-id bytes ‖ nonce), the function must not mutate
/// state, and an abort means access denied.
///
/// - `seal_approve_ticket`   → ticket-holder-gated / SHARED content (event
///   forum, gated info): caller owns a Ticket for the event; id namespaced to
///   the BARE event id. Any ticket holder (incl. a free-ticket claimer) passes.
/// - `seal_approve_organizer`→ organizer-gated data (attendee/KYC list): caller
///   holds the event's OrganizerCap. ORGANIZER-ONLY ciphertext is namespaced
///   `ORG_NS_TAG ‖ event_id` so `seal_approve_ticket` can NOT decrypt it. (This
///   policy ALSO accepts the bare event-id namespace so the organizer can read
///   shared forum content.) The two policies are NOT interchangeable for
///   organizer-only data.
/// - `seal_approve_self`     → account-based: id namespaced to the caller's own
///   address (a user's own KYC/PII — only they decrypt).
module hostit_ticket::access;

use sui::address;
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};
use hostit_ticket::identity::{Self, EmailGrant};

const E_NO_ACCESS: u64 = 1;

/// Domain-separation tag prefixed before the event-id bytes to form the
/// ORGANIZER-ONLY Seal identity namespace. A ticket holder's policy
/// (`seal_approve_ticket`) checks `is_prefix(event_id, id)` and can never
/// match an id that begins with this tag, so organizer-only ciphertext is
/// NOT decryptable by ticket holders. MUST match `ORG_NS_TAG` in
/// web/lib/seal.ts.
const ORG_NS_TAG: vector<u8> = b"hostit-org:";

/// Domain-separation tag for a user's EMAIL ciphertext identity:
/// `EMAIL_NS_TAG ‖ user_address ‖ nonce`. Crucially the tag comes FIRST, so the
/// email namespace is DISJOINT from the bare-self namespace (`address ‖ nonce`)
/// used by `seal_approve_self` for KYC/drafts. That makes an attendee's
/// "share my email" grant strictly confined to the email — it can never grant an
/// organizer access to the user's KYC/drafts. The owner decrypts their own email
/// via `seal_approve_own_email` (NOT `seal_approve_self`, which checks the bare
/// address prefix and so never matches a tag-first email id). MUST match
/// `EMAIL_NS_TAG` in web/lib/seal.ts.
const EMAIL_NS_TAG: vector<u8> = b"hostit-email:";

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

/// The organizer-only identity prefix: ORG_NS_TAG ‖ event_id bytes.
fun organizer_ns(eid: &ID): vector<u8> {
    let mut ns = ORG_NS_TAG;
    ns.append(object::id_to_bytes(eid));
    ns
}

entry fun seal_approve_organizer(id: vector<u8>, cap: &OrganizerCap, event: &Event) {
    event::assert_organizer(cap, event);
    let eid = object::id(event);
    // Accept the organizer-only namespace (tag ‖ event_id) OR the bare
    // event-id namespace (shared forum content the organizer also reads).
    let ok = is_prefix(&organizer_ns(&eid), &id)
        || is_prefix(&object::id_to_bytes(&eid), &id);
    assert!(ok, E_NO_ACCESS);
}

entry fun seal_approve_self(id: vector<u8>, ctx: &TxContext) {
    assert!(is_prefix(&address::to_bytes(ctx.sender()), &id), E_NO_ACCESS);
}

// === Email selective disclosure (GH#96) ===

/// A user's email identity prefix: EMAIL_NS_TAG ‖ user address bytes.
fun email_ns(user: address): vector<u8> {
    let mut ns = EMAIL_NS_TAG;
    ns.append(address::to_bytes(user));
    ns
}

/// Owner decrypts their OWN email. (seal_approve_self can't: the email id is
/// tag-first, so it doesn't start with the bare address.)
entry fun seal_approve_own_email(id: vector<u8>, ctx: &TxContext) {
    assert!(is_prefix(&email_ns(ctx.sender()), &id), E_NO_ACCESS);
}

/// Shared check for `seal_approve_attendee_email` (extracted so tests can cover
/// it — a private `entry fun` isn't callable from a test module).
fun assert_attendee_email(id: &vector<u8>, cap: &OrganizerCap, event: &Event, grant: &EmailGrant) {
    event::assert_organizer(cap, event);                                   // caller IS this organizer
    assert!(identity::grant_event_id(grant) == object::id(event), E_NO_ACCESS); // grant for THIS event
    assert!(is_prefix(&email_ns(identity::grant_user(grant)), id), E_NO_ACCESS); // email ns of grant.user ONLY
}

/// Organizer of `event` decrypts attendee `grant.user`'s email IFF the attendee
/// minted an `EmailGrant` for this event. Confined to the email namespace, so it
/// never reaches the user's bare-self KYC/drafts.
entry fun seal_approve_attendee_email(
    id: vector<u8>,
    cap: &OrganizerCap,
    event: &Event,
    grant: &EmailGrant,
) {
    assert_attendee_email(&id, cap, event, grant);
}

// === Test-only ===

#[test_only]
public fun check_prefix(prefix: vector<u8>, id: vector<u8>): bool { is_prefix(&prefix, &id) }
#[test_only]
public fun email_ns_for_test(user: address): vector<u8> { email_ns(user) }
#[test_only]
public fun check_own_email(id: vector<u8>, ctx: &TxContext): bool {
    is_prefix(&email_ns(ctx.sender()), &id)
}
#[test_only]
public fun check_attendee_email(id: vector<u8>, cap: &OrganizerCap, event: &Event, grant: &EmailGrant) {
    assert_attendee_email(&id, cap, event, grant);
}
