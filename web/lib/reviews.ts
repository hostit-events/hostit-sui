// Shared, on-chain event reviews & ratings (GH#58) — POAP-gated, PUBLIC (no Seal).
//
// === STORAGE MODEL ==========================================================
// Reviews mirror the forum module MINUS the Seal step (reviews are public):
//   • the body (rating + comment JSON) is a PUBLIC Walrus blob,
//   • each review is anchored on-chain via `reviews::post_review`, which emits a
//     `ReviewPosted { event_id, event_seq, author, rating, blob_id, ts_ms }`.
// Readers `queryEvents({ MoveEventType: EV_REVIEW_POSTED })`, filter by event,
// and fetch each body from Walrus. The AVERAGE is computable from the on-chain
// `rating` alone (no Walrus fetch needed for the number).
//
// The on-chain gate is ATTENDANCE: `post_review` takes `&Poap` for the event,
// which proves the caller attended (a POAP is claimable only after check-in).
// One-review-per-wallet is NOT enforced on-chain in v1 — we dedupe by author
// here (keep the newest per author), matching the Move module's documented v1
// ceiling.
//
// `averageRating` / `sortReviews` / `authorHasReviewed` / `Review` /
// `RatingSummary` / `MAX_COMMENT_LEN` are UNCHANGED — only the storage-backed
// functions swapped from device-local localStorage to on-chain + Walrus.

import { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, CLOCK_ID, EV_REVIEW_POSTED, target } from "./config";
import { readJson } from "./walrus";

export interface Review {
  /** Stable id (the anchor event / tx id on-chain). */
  id: string;
  /** Sui object id of the event this review is for. */
  eventId: string;
  /** 1–5 stars. */
  rating: number;
  /** Free-text body (<= MAX_COMMENT_LEN chars). */
  comment: string;
  /** Reviewer's wallet address (raw 0x… — display handles suiNS/truncation). */
  author: string;
  /** Unix ms when the review was created. */
  createdAt: number;
}

export const MAX_COMMENT_LEN = 300;

/** Aggregate of one event's ratings — the header `{avg.toFixed(1)} ({count})`. */
export interface RatingSummary {
  avg: number;
  count: number;
}

// ── PURE logic (exported so tests cover it with no storage/network) ──────────

/**
 * Average rating + count over a list of reviews. Pure fold (no I/O). `avg` is
 * rounded to one decimal to match the UI header; an empty list yields
 * `{ avg: 0, count: 0 }`.
 */
export function averageRating(reviews: Review[]): RatingSummary {
  if (reviews.length === 0) return { avg: 0, count: 0 };
  const sum = reviews.reduce((s, r) => s + r.rating, 0);
  return {
    avg: Math.round((sum / reviews.length) * 10) / 10,
    count: reviews.length,
  };
}

/** Newest-first ordering for display. Pure (returns a new array). */
export function sortReviews(reviews: Review[]): Review[] {
  return reviews.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** True if `author` already has a review in `reviews` (one-per-wallet rule). */
export function authorHasReviewed(reviews: Review[], author: string): boolean {
  return reviews.some((r) => r.author === author);
}

/**
 * Collapse multiple anchors per author down to the LATEST one (newest
 * `createdAt` wins), then return newest-first. Pure. One-review-per-wallet is
 * not enforced on-chain (a `&Poap` can authorize many anchors), so the client
 * dedupes: a re-review supersedes the author's earlier one. Ties (equal
 * timestamps) keep whichever the input lists first.
 */
export function dedupeByAuthor(reviews: Review[]): Review[] {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    const prev = latest.get(r.author);
    if (!prev || r.createdAt > prev.createdAt) latest.set(r.author, r);
  }
  return sortReviews([...latest.values()]);
}

// ── Transaction constructor (mirror forumPostTx, no Seal) ────────────────────

/**
 * Build the `reviews::post_review` transaction. Args: the (mutable) Event
 * object, the caller's Poap object (proves attendance), the rating (u8), the
 * public Walrus blob id (String), and the Clock. One review per wallet is
 * enforced on-chain (a second post from the same wallet aborts).
 */
export function reviewPostTx(input: {
  eventId: string;
  poapId: string;
  rating: number;
  blobId: string;
}): Transaction {
  const { eventId, poapId, rating, blobId } = input;
  const tx = new Transaction();
  tx.moveCall({
    target: target("reviews", "post_review"),
    arguments: [
      tx.object(eventId),
      tx.object(poapId),
      tx.pure.u8(rating),
      tx.pure.string(blobId),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// ── On-chain reads (the swap-to-on-chain seam) ───────────────────────────────

/** Minimal SuiClient surface this module needs (queryEvents only). */
interface QueryEventsClient {
  queryEvents: (p: {
    query: { MoveEventType: string };
    order?: "ascending" | "descending";
    limit?: number;
    cursor?: unknown;
  }) => Promise<{
    data: Array<{ id: { txDigest: string; eventSeq: string }; parsedJson?: unknown }>;
    nextCursor?: unknown;
    hasNextPage?: boolean;
  }>;
}

interface ReviewPostedJson {
  event_id: string;
  event_seq: string | number;
  author: string;
  rating: string | number;
  blob_id: string;
  ts_ms: string | number;
}

interface BlobBody {
  comment?: string;
}

/**
 * All reviews for an event, deduped by author (latest per wallet) and newest
 * first. PUBLIC — NO Seal/SessionKey. Enumerates `ReviewPosted` anchors
 * (cursor-followed past the page cap), keeps the ones for `eventId`, then
 * fetches each body's `comment` from its PUBLIC Walrus blob. The rating/author/
 * timestamp come straight off the anchor (so the average needs no Walrus reads);
 * only the comment text comes from Walrus, and a failed blob read degrades to an
 * empty comment rather than dropping the review.
 */
export async function listReviews(
  client: QueryEventsClient,
  eventId: string,
): Promise<Review[]> {
  // 1) Enumerate anchors for this event type, newest-first.
  const anchors: Array<{ id: string; json: ReviewPostedJson }> = [];
  let cursor: unknown = undefined;
  // Bound the enumeration defensively (v1 testnet volume; the v2 indexer is the
  // real fix). Each page is up to 50 logs.
  for (let page = 0; page < 40; page++) {
    const res = await client.queryEvents({
      query: { MoveEventType: EV_REVIEW_POSTED },
      order: "descending",
      limit: 50,
      cursor: cursor ?? undefined,
    });
    for (const ev of res.data) {
      const json = ev.parsedJson as ReviewPostedJson | undefined;
      if (!json || String(json.event_id) !== eventId) continue;
      anchors.push({ id: `${ev.id.txDigest}:${ev.id.eventSeq}`, json });
    }
    if (!res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor;
  }

  // 2) Resolve each body's comment from Walrus (public blob). Failures → "".
  const reviews = await Promise.all(
    anchors.map(async ({ id, json }): Promise<Review> => {
      let comment = "";
      try {
        const body = await readJson<BlobBody>(json.blob_id);
        comment = typeof body?.comment === "string" ? body.comment : "";
      } catch {
        comment = "";
      }
      return {
        id,
        eventId,
        rating: Number(json.rating),
        comment,
        author: String(json.author),
        createdAt: Number(json.ts_ms),
      };
    }),
  );

  // 3) One review per wallet (latest wins), newest first.
  return dedupeByAuthor(reviews);
}

/** True if `author` has already reviewed (reuses the pure check over a list). */
export function hasReviewed(reviews: Review[], author: string): boolean {
  return authorHasReviewed(reviews, author);
}

/** Fully-qualified ReviewPosted log type (for callers wiring queryEvents hooks). */
export const REVIEW_POSTED_TYPE = `${PACKAGE_ID}::reviews::ReviewPosted`;
