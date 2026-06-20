import { describe, it, expect } from "vitest";
import { collectPages, chunk } from "../pagination";

describe("collectPages (cursor follow)", () => {
  it("returns a single page when hasNextPage is false", async () => {
    const res = await collectPages(
      async () => ({ data: [1, 2, 3], nextCursor: null, hasNextPage: false }),
      20,
    );
    expect(res).toEqual({ data: [1, 2, 3], truncated: false });
  });

  it("follows the cursor across pages until exhausted, starting from null", async () => {
    const pages = [
      { data: [1, 2], nextCursor: "c1", hasNextPage: true },
      { data: [3, 4], nextCursor: "c2", hasNextPage: true },
      { data: [5], nextCursor: null, hasNextPage: false },
    ];
    const seen: (string | null)[] = [];
    let i = 0;
    const res = await collectPages<number, string>(async (cursor) => {
      seen.push(cursor);
      return pages[i++];
    }, 20);
    expect(res.data).toEqual([1, 2, 3, 4, 5]);
    expect(res.truncated).toBe(false);
    expect(seen).toEqual([null, "c1", "c2"]); // first call gets null, then follows cursors
  });

  it("stops at maxPages and flags truncated when more data remains", async () => {
    const res = await collectPages<number, string>(
      async () => ({ data: [0], nextCursor: "more", hasNextPage: true }),
      3,
    );
    expect(res.data).toEqual([0, 0, 0]); // exactly 3 pages walked
    expect(res.truncated).toBe(true);
  });

  it("treats a null nextCursor as the end even if hasNextPage is true", async () => {
    const res = await collectPages<number, string>(
      async () => ({ data: [9], nextCursor: null, hasNextPage: true }),
      5,
    );
    expect(res).toEqual({ data: [9], truncated: false });
  });
});

describe("chunk", () => {
  it("splits into chunks of at most size, last is the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("returns one chunk when smaller than size", () => {
    expect(chunk([1, 2], 50)).toEqual([[1, 2]]);
  });
  it("returns [] for empty input", () => {
    expect(chunk([], 50)).toEqual([]);
  });
  it("throws on a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
