/// Account identity primitives (GH#96): the two — and only two — facts that must
/// be trustless for HostIt's email layer.
///
/// 1. `EmailRegistry` — enforces ONE account ↔ ONE email. The key is an OPAQUE
///    `HMAC(server-pepper, canonical_email)` computed server-side, so the public
///    table never reveals an email even under full enumeration. The value is the
///    owning address. Registration is permissionless and idempotent for the same
///    owner; a different owner claiming a taken hash aborts.
/// 2. `EmailGrant` — an attendee-minted, SHARED consent object that lets the
///    organizer of one event decrypt that attendee's email (checked by
///    `access::seal_approve_attendee_email`). `user` is bound to `ctx.sender()`
///    at creation, so nobody can mint a grant on a victim's behalf. Revoke is
///    forward-only (deletes the object → future decrypts abort).
///
/// Plaintext email NEVER touches the chain — only the opaque hash + grant flags.
module hostit_ticket::identity;

use sui::table::{Self, Table};
use sui::event as sui_event;
use hostit_ticket::event::Event;

/// A different address already owns this email hash.
const E_EMAIL_TAKEN: u64 = 1;
/// Caller is not the owner of this email hash / grant.
const E_NOT_OWNER: u64 = 2;

/// Shared one-account-one-email registry. `emails: HMAC(pepper, email) -> owner`.
public struct EmailRegistry has key {
    id: UID,
    emails: Table<vector<u8>, address>,
}

/// Attendee consent: organizer of `event_id` may decrypt `user`'s email. Shared
/// so the organizer can reference it in their Seal decrypt dry-run.
public struct EmailGrant has key {
    id: UID,
    user: address,
    event_id: ID,
}

public struct EmailRegistered has copy, drop { who: address }
public struct EmailUnregistered has copy, drop { who: address }
public struct EmailGrantCreated has copy, drop { grant_id: ID, user: address, event_id: ID }

fun init(ctx: &mut TxContext) {
    transfer::share_object(EmailRegistry { id: object::new(ctx), emails: table::new(ctx) });
}

/// Register the caller's opaque email hash. Idempotent for the same owner;
/// aborts `E_EMAIL_TAKEN` if a different address already owns it.
public fun register_email(reg: &mut EmailRegistry, email_hash: vector<u8>, ctx: &TxContext) {
    let who = ctx.sender();
    if (table::contains(&reg.emails, email_hash)) {
        assert!(*table::borrow(&reg.emails, email_hash) == who, E_EMAIL_TAKEN);
    } else {
        table::add(&mut reg.emails, email_hash, who);
        sui_event::emit(EmailRegistered { who });
    }
}

/// Free the caller's email hash (the on-chain step of "delete my email data").
/// Gated on ownership.
public fun unregister_email(reg: &mut EmailRegistry, email_hash: vector<u8>, ctx: &TxContext) {
    assert!(table::contains(&reg.emails, email_hash), E_NOT_OWNER);
    assert!(*table::borrow(&reg.emails, email_hash) == ctx.sender(), E_NOT_OWNER);
    table::remove(&mut reg.emails, email_hash);
    sui_event::emit(EmailUnregistered { who: ctx.sender() });
}

/// Opt in to share your email with `event`'s organizer. Shares an `EmailGrant`
/// bound to the caller; emits its id so the organizer can find it.
public fun grant_email_access(event: &Event, ctx: &mut TxContext) {
    let grant = EmailGrant {
        id: object::new(ctx),
        user: ctx.sender(),
        event_id: object::id(event),
    };
    sui_event::emit(EmailGrantCreated {
        grant_id: object::id(&grant),
        user: grant.user,
        event_id: grant.event_id,
    });
    transfer::share_object(grant);
}

/// Revoke a previously-granted share (forward-only). Only the grant's `user`.
public fun revoke_email_grant(grant: EmailGrant, ctx: &TxContext) {
    assert!(ctx.sender() == grant.user, E_NOT_OWNER);
    let EmailGrant { id, user: _, event_id: _ } = grant;
    object::delete(id);
}

// === Reads (for the /start uniqueness pre-check + the seal policy) ===

public fun is_registered(reg: &EmailRegistry, email_hash: vector<u8>): bool {
    table::contains(&reg.emails, email_hash)
}
public fun owner_of(reg: &EmailRegistry, email_hash: vector<u8>): address {
    *table::borrow(&reg.emails, email_hash)
}
public fun grant_user(g: &EmailGrant): address { g.user }
public fun grant_event_id(g: &EmailGrant): ID { g.event_id }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx); }
