/// Shared, on-chain event reviews (GH#58). A review body (rating + free-text
/// comment) lives as a PUBLIC Walrus blob; this module anchors each review's
/// blob id on-chain as a `ReviewPosted` event. Readers query these events to
/// discover reviews, then fetch the body from Walrus (the average is computable
/// from the on-chain `rating` alone — no Walrus fetch needed for the number).
///
/// Reviews are intentionally PUBLIC: unlike `forum`, there is NO Seal step. The
/// only gate is attendance — a caller must pass `&Poap` for THIS event, which
/// proves they own a proof-of-attendance NFT (claimable only after check-in).
///
/// One-review-per-wallet is NOT enforced on-chain in v1: a `&Poap` is borrowed
/// (not consumed) so it could authorize many anchors. Clients dedupe by author
/// (keep the latest per author over the event log). On-chain enforcement (a
/// shared dedup registry, like `PoapRegistry`) is a deliberate v2 nicety — kept
/// out of v1 so the module stays a thin anchor with no shared state to manage.
module hostit_ticket::reviews;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event as sui_event;
use hostit_ticket::event::{Self, Event};
use hostit_ticket::poap::{Self, Poap};

/// The passed `&Poap` is for a DIFFERENT event than the one being reviewed.
const E_WRONG_EVENT: u64 = 1;
/// `rating` is outside the valid 1..=5 star range.
const E_BAD_RATING: u64 = 2;

const MIN_RATING: u8 = 1;
const MAX_RATING: u8 = 5;

/// On-chain anchor for one review. The rating is on-chain (so averages need no
/// Walrus reads); the comment lives in the PUBLIC Walrus blob `blob_id`.
public struct ReviewPosted has copy, drop {
    event_id: ID,
    event_seq: u64,
    author: address,
    /// 1..=5 stars (validated below).
    rating: u8,
    /// Walrus blob id of the PUBLIC review payload (rating + comment JSON).
    blob_id: String,
    ts_ms: u64,
}

/// Post a review for an event. Gated on attendance: `poap` must be a `Poap` for
/// THIS event (passing it by reference already proves the sender owns it, i.e.
/// they attended and claimed it). `rating` must be 1..=5. Emits `ReviewPosted`;
/// nothing is stored on-chain (the body is the public Walrus blob).
public fun post_review(
    event: &Event,
    poap: &Poap,
    rating: u8,
    blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(poap::event_id(poap) == object::id(event), E_WRONG_EVENT);
    assert!(rating >= MIN_RATING && rating <= MAX_RATING, E_BAD_RATING);
    sui_event::emit(ReviewPosted {
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        author: ctx.sender(),
        rating,
        blob_id,
        ts_ms: clock::timestamp_ms(clock),
    });
}
