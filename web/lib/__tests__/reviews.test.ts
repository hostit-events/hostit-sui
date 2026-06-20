import { describe, it, expect, beforeEach } from "vitest";
import {
  averageRating,
  sortReviews,
  authorHasReviewed,
  listReviews,
  hasReviewed,
  addReview,
  type Review,
} from "../reviews";

function review(over: Partial<Review> = {}): Review {
  return {
    id: over.id ?? `r_${Math.random().toString(36).slice(2, 8)}`,
    eventId: over.eventId ?? "0xevent",
    rating: over.rating ?? 5,
    comment: over.comment ?? "great",
    author: over.author ?? "0xabc",
    createdAt: over.createdAt ?? 1000,
  };
}

describe("averageRating (pure fold)", () => {
  it("returns { avg: 0, count: 0 } for an empty list", () => {
    expect(averageRating([])).toEqual({ avg: 0, count: 0 });
  });

  it("averages a single review to its own rating", () => {
    expect(averageRating([review({ rating: 4 })])).toEqual({ avg: 4, count: 1 });
  });

  it("averages multiple ratings and counts them", () => {
    const out = averageRating([
      review({ rating: 5 }),
      review({ rating: 3 }),
      review({ rating: 4 }),
    ]);
    expect(out).toEqual({ avg: 4, count: 3 });
  });

  it("rounds the average to one decimal place", () => {
    // (5 + 4) / 2 = 4.5 ; (5 + 4 + 4) / 3 = 4.333… -> 4.3
    expect(averageRating([review({ rating: 5 }), review({ rating: 4 })]).avg).toBe(4.5);
    expect(
      averageRating([
        review({ rating: 5 }),
        review({ rating: 4 }),
        review({ rating: 4 }),
      ]).avg,
    ).toBe(4.3);
  });
});

describe("sortReviews (pure)", () => {
  it("orders newest-first by createdAt and does not mutate input", () => {
    const list = [
      review({ id: "old", createdAt: 100 }),
      review({ id: "new", createdAt: 300 }),
      review({ id: "mid", createdAt: 200 }),
    ];
    expect(sortReviews(list).map((r) => r.id)).toEqual(["new", "mid", "old"]);
    expect(list.map((r) => r.id)).toEqual(["old", "new", "mid"]); // unchanged
  });
});

describe("authorHasReviewed (pure)", () => {
  it("matches by exact author address", () => {
    const list = [review({ author: "0xaaa" }), review({ author: "0xbbb" })];
    expect(authorHasReviewed(list, "0xbbb")).toBe(true);
    expect(authorHasReviewed(list, "0xccc")).toBe(false);
  });
});

describe("localStorage store round-trip (jsdom)", () => {
  const EVENT = "0xevent1";
  const OTHER = "0xevent2";
  const ME = "0x" + "a".repeat(64);
  const YOU = "0x" + "b".repeat(64);

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lists [] for an event with no reviews", () => {
    expect(listReviews(EVENT)).toEqual([]);
  });

  it("addReview persists and listReviews returns it (newest first)", () => {
    addReview({ eventId: EVENT, rating: 4, comment: "a", author: ME });
    addReview({ eventId: EVENT, rating: 5, comment: "b", author: YOU });
    const list = listReviews(EVENT);
    expect(list).toHaveLength(2);
    expect(list[0].comment).toBe("b"); // newest first (added last)
    expect(list[0].author).toBe(YOU);
  });

  it("enforces one-review-per-wallet (re-review is a no-op)", () => {
    addReview({ eventId: EVENT, rating: 4, comment: "first", author: ME });
    const after = addReview({ eventId: EVENT, rating: 1, comment: "second", author: ME });
    expect(after).toHaveLength(1);
    expect(after[0].comment).toBe("first");
    expect(hasReviewed(EVENT, ME)).toBe(true);
    expect(hasReviewed(EVENT, YOU)).toBe(false);
  });

  it("isolates reviews by event id", () => {
    addReview({ eventId: EVENT, rating: 5, comment: "x", author: ME });
    expect(listReviews(OTHER)).toEqual([]);
    expect(hasReviewed(OTHER, ME)).toBe(false);
  });

  it("returns [] (never throws) when stored value is corrupt JSON", () => {
    window.localStorage.setItem(`hostit:reviews:${EVENT}`, "{not-json");
    expect(listReviews(EVENT)).toEqual([]);
  });
});
