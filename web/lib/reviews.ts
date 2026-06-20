// Event reviews & ratings (GH#58) — POAP-gated, public (no Seal).
//
// === STORAGE DECISION (read before extending) ===============================
// The issue (#58) frames persistence as the blocking decision and proposes
// mirroring the forum module: a Walrus blob body + an on-chain anchor event.
// That recommended path (option "a") needs a NEW Move module
// (`sources/reviews.move` with a `ReviewPosted` event gated by `&Poap`), which
// is a package UPGRADE — explicitly GATED per CLAUDE.md and OUT OF SCOPE for
// this PR (no Move changes, no deploy/publish).
//
// So v1 ships a DEVICE-LOCAL localStorage store behind this seam, with the
// review SHAPE already modeled on the future on-chain anchor (event_id,
// rating, comment, author, ts_ms). The gate (can-review = wallet holds the
// event's POAP) is REAL on-chain (`getOwnedObjects` filtered on POAP_TYPE,
// matched by event_id) — see ReviewsSection wiring in EventPageScreen.
//
// SWAP-TO-ON-CHAIN is a one-file change: once `reviews.move` ships, replace
// `addReview`/`listReviews`/`hasReviewed` with a Walrus `storeJson`/`readJson`
// body + a `queryEvents({ MoveEventType: EV_REVIEW_POSTED })` read (mirror
// `lib/forum.ts` minus the Seal step — reviews are intentionally public).
// `averageRating` / `Review` stay identical; callers do not change.
//
// === v1 CEILINGS (intentional, documented) ==================================
//  • DEVICE-LOCAL. Reviews live in this browser's localStorage
//    (`hostit:reviews:${eventId}`); they do NOT sync across devices and are
//    NOT shared between users. This is the deliberate v1 deferral — the
//    on-chain anchor (above) is the shared-state answer, gated to a later PR.
//  • CLIENT-SIDE UNIQUENESS. One-review-per-wallet (`hasReviewed`) is enforced
//    by matching `author === addr` over the local log. On-chain enforcement is
//    a v2 nicety (the future Move module can assert it).
//  • NO SEED/MOCK DATA. The prototype's `SEED_REVIEWS` + mock generators are
//    deliberately NOT ported — empty until real attendees review.

export interface Review {
  /** Stable id (random in v1; the anchor event id on-chain later). */
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
 * Average rating + count over a list of reviews. Pure fold (no I/O) so it works
 * unchanged whether `reviews` came from localStorage today or from anchor
 * events later. `avg` is rounded to one decimal to match the UI header; an
 * empty list yields `{ avg: 0, count: 0 }`.
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

// ── localStorage backing store (v1) ──────────────────────────────────────────

const storeKey = (eventId: string) => `hostit:reviews:${eventId}`;

/** SSR-safe, never-throws read of one event's reviews. */
function readStore(eventId: string): Review[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storeKey(eventId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? (parsed as Review[]) : [];
  } catch {
    return [];
  }
}

/** SSR-safe, never-throws write of one event's reviews. */
function writeStore(eventId: string, reviews: Review[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storeKey(eventId), JSON.stringify(reviews));
  } catch {
    /* quota / private mode — fail silently */
  }
}

// ── Public API (the swap-to-on-chain seam) ───────────────────────────────────

/** All reviews for an event, newest first. Sync (device-local index only). */
export function listReviews(eventId: string): Review[] {
  return sortReviews(readStore(eventId));
}

/** True if `author` has already reviewed `eventId`. */
export function hasReviewed(eventId: string, author: string): boolean {
  return authorHasReviewed(readStore(eventId), author);
}

/**
 * Append a review and persist it. The caller is responsible for the gate
 * (wallet connected AND holds the event POAP) — see ReviewsSection. Re-reviews
 * by the same author are rejected (returns the existing list unchanged) so the
 * one-per-wallet rule holds even across races. Returns the updated list
 * (newest first) so the caller can render optimistically.
 */
export function addReview(input: {
  eventId: string;
  rating: number;
  comment: string;
  author: string;
}): Review[] {
  const { eventId, rating, comment, author } = input;
  const existing = readStore(eventId);
  if (authorHasReviewed(existing, author)) return sortReviews(existing);
  const review: Review = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    eventId,
    rating,
    comment,
    author,
    createdAt: Date.now(),
  };
  const next = [review, ...existing];
  writeStore(eventId, next);
  return sortReviews(next);
}
