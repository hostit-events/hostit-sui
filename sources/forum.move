/// Per-event community forum. Messages themselves are Seal-encrypted blobs on
/// Walrus (ticket-holder gated via `access::seal_approve_ticket`); this module
/// just anchors each message's Walrus blob id on-chain as a `PostCreated` event,
/// gated so only a ticket holder for the event can post. Readers query these
/// events to discover messages, then fetch + decrypt from Walrus. No backend /
/// websocket needed — clients poll the event log.
module hostit_ticket::forum;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event as sui_event;
use hostit_ticket::event::{Self, Event};
use hostit_ticket::ticket::{Self, Ticket};

const E_WRONG_EVENT: u64 = 1;

public struct PostCreated has copy, drop {
    event_id: ID,
    event_seq: u64,
    channel: String,
    author: address,
    /// Walrus blob id of the Seal-encrypted message payload.
    blob_id: String,
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
