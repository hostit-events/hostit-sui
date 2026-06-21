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
/// One-review-per-wallet IS enforced on-chain: the `Event` keeps a `reviewed`
/// set (a struct field, not a separate shared object), so a second review from
/// the same wallet aborts. Clients may still dedupe defensively over the log.
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
/// This wallet has already reviewed this event (one review per wallet).
const E_ALREADY_REVIEWED: u64 = 3;

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
    event: &mut Event,
    poap: &Poap,
    rating: u8,
    blob_id: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(poap::event_id(poap) == object::id(event), E_WRONG_EVENT);
    assert!(rating >= MIN_RATING && rating <= MAX_RATING, E_BAD_RATING);
    let author = ctx.sender();
    assert!(!event::has_reviewed(event, author), E_ALREADY_REVIEWED);
    event::mark_reviewed(event, author);
    sui_event::emit(ReviewPosted {
        event_id: object::id(event),
        event_seq: event::event_seq(event),
        author,
        rating,
        blob_id,
        ts_ms: clock::timestamp_ms(clock),
    });
}
