import { describe, it, expect } from "vitest";
import {
  averageRating,
  sortReviews,
  authorHasReviewed,
  dedupeByAuthor,
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

describe("dedupeByAuthor (pure)", () => {
  it("keeps only the latest review per author, newest-first", () => {
    // Two authors; ME re-reviewed (200 supersedes 100). Expect ME@200 + YOU@150,
    // ordered newest-first.
    const list = [
      review({ id: "me-old", author: "0xme", createdAt: 100, comment: "first" }),
      review({ id: "you", author: "0xyou", createdAt: 150, comment: "yo" }),
      review({ id: "me-new", author: "0xme", createdAt: 200, comment: "second" }),
    ];
    const out = dedupeByAuthor(list);
    expect(out.map((r) => r.id)).toEqual(["me-new", "you"]);
    // the surviving ME review is the newest one
    expect(out.find((r) => r.author === "0xme")?.comment).toBe("second");
  });

  it("returns one entry per author and is empty for an empty input", () => {
    expect(dedupeByAuthor([])).toEqual([]);
    const out = dedupeByAuthor([
      review({ author: "0xa", createdAt: 1 }),
      review({ author: "0xa", createdAt: 2 }),
      review({ author: "0xb", createdAt: 3 }),
    ]);
    expect(out).toHaveLength(2);
  });
});
