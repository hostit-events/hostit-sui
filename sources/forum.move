/// Per-event community forum. Messages themselves are Seal-encrypted blobs on
/// Walrus (gated via `access::seal_approve_ticket` for holders or
/// `access::seal_approve_organizer` for the organizer); this module anchors each
/// message's Walrus blob id on-chain as a `PostCreated` event. Ticket holders post
/// via `post`; the event's organizer posts via `post_as_organizer` (no ticket
/// needed) and moderates via `moderate`. Readers query these events to discover
/// messages, then fetch + decrypt from Walrus. No backend / websocket — clients
/// poll the event log.
///
/// Moderation is by TOMBSTONE, not deletion: a post is an immutable emitted event
/// + an immutable Walrus blob, so there is nothing to mutate or remove on-chain.
/// `moderate` emits a `PostModerated` keyed by the target blob id; clients fold
/// the latest action per blob over the feed (hide → collapse, pin → surface).
module hostit_ticket::forum;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event as sui_event;
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};

const E_WRONG_EVENT: u64 = 1;
const E_BAD_ACTION: u64 = 2;

/// Largest valid moderation action. Actions are interpreted CLIENT-SIDE:
/// 0 = hide, 1 = unhide, 2 = pin, 3 = unpin. Move only bounds the value so an
/// unknown action can't be anchored.
const MAX_ACTION: u8 = 3;

public struct PostCreated has copy, drop {
    event_id: ID,
    event_seq: u64,
    channel: String,
    author: address,
    /// Walrus blob id of the Seal-encrypted message payload.
    blob_id: String,
    ts_ms: u64,
}

/// Organizer moderation tombstone over an immutable `PostCreated`. Clients keep
/// the latest action per `target_blob_id` and render accordingly.
public struct PostModerated has copy, drop {
    event_id: ID,
    event_seq: u64,
    /// Walrus blob id of the post being moderated.
    target_blob_id: String,
    /// 0 = hide, 1 = unhide, 2 = pin, 3 = unpin (interpreted client-side).
    action: u8,
    by: address,
    ts_ms: u64,
}

/// Post to an event's forum. Caller must hold a Ticket for the event.
public fun post(
    event: &Event,
    ticket: &Ticket,
    channel: String,
    blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ticket::event_id(ticket) == object::id(event), E_WRONG_EVENT);
    sui_event::emit(PostCreated {
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        channel,
        author: ctx.sender(),
        blob_id,
        ts_ms: clock::timestamp_ms(clock),
    });
}

/// Post to an event's forum as the ORGANIZER — gated on the event's OrganizerCap,
/// no Ticket required (an organizer may not hold a ticket for their own event).
/// Emits the same `PostCreated`; clients badge it as organizer-authored by
/// matching `author` against the event's organizer address.
public fun post_as_organizer(
    event: &Event,
    cap: &OrganizerCap,
    channel: String,
    blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    event::assert_organizer(cap, event);
    sui_event::emit(PostCreated {
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        channel,
        author: ctx.sender(),
        blob_id,
        ts_ms: clock::timestamp_ms(clock),
    });
}

/// Moderate a post by its Walrus `target_blob_id` (hide / unhide / pin / unpin).
/// Organizer-only. Emits a `PostModerated` tombstone clients fold over the feed;
/// nothing is mutated or deleted on-chain (posts are immutable).
public fun moderate(
    event: &Event,
    cap: &OrganizerCap,
    target_blob_id: String,
    action: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    event::assert_organizer(cap, event);
    assert!(action <= MAX_ACTION, E_BAD_ACTION);
    sui_event::emit(PostModerated {
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        target_blob_id,
        action,
        by: ctx.sender(),
        ts_ms: clock::timestamp_ms(clock),
    });
}
