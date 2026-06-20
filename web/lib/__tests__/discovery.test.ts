import { describe, it, expect } from "vitest";
import {
  fillRatio,
  fillPercent,
  ticketsLeft,
  soldOut,
  getEventStatus,
  formatCountdownCompact,
  formatDateRangeMs,
  trendingScore,
  topTrending,
  featuredEvents,
  recommendationScore,
  recommendedEvents,
  pushRecentlyViewed,
  type DiscoverEvent,
} from "../discovery";

const DAY = 86_400_000;

function ev(over: Partial<DiscoverEvent> = {}): DiscoverEvent {
  return {
    eventId: "0x1",
    eventSeq: "1",
    organizer: "0xorg",
    name: "Test",
    isFree: false,
    minted: 0n,
    maxTickets: 100n,
    startMs: Date.now() + DAY,
    endMs: Date.now() + 2 * DAY,
    ...over,
  };
}

describe("fill / capacity helpers", () => {
  it("fillRatio is minted/maxTickets, clamped to [0,1]", () => {
    expect(fillRatio({ minted: 50n, maxTickets: 100n })).toBeCloseTo(0.5);
    expect(fillRatio({ minted: 0n, maxTickets: 0n })).toBe(0); // no div-by-zero
    expect(fillRatio({ minted: 200n, maxTickets: 100n })).toBe(1); // clamped
  });
  it("fillPercent rounds to a whole percent", () => {
    expect(fillPercent({ minted: 1n, maxTickets: 3n })).toBe(33);
  });
  it("ticketsLeft never goes negative", () => {
    expect(ticketsLeft({ minted: 120n, maxTickets: 100n })).toBe(0n);
    expect(ticketsLeft({ minted: 40n, maxTickets: 100n })).toBe(60n);
  });
  it("soldOut requires a real capacity", () => {
    expect(soldOut({ minted: 100n, maxTickets: 100n })).toBe(true);
    expect(soldOut({ minted: 0n, maxTickets: 0n })).toBe(false);
  });
});

describe("getEventStatus", () => {
  const now = 1_000_000_000_000;
  it("classifies upcoming / live / past", () => {
    expect(getEventStatus({ minted: 0n, maxTickets: 10n, startMs: now + DAY, endMs: now + 2 * DAY }, now)).toBe("upcoming");
    expect(getEventStatus({ minted: 0n, maxTickets: 10n, startMs: now - 1000, endMs: now + 1000 }, now)).toBe("live");
    expect(getEventStatus({ minted: 0n, maxTickets: 10n, startMs: now - 2 * DAY, endMs: now - DAY }, now)).toBe("past");
  });
  it("flags sold-out for an upcoming full event", () => {
    expect(getEventStatus({ minted: 10n, maxTickets: 10n, startMs: now + DAY, endMs: now + 2 * DAY }, now)).toBe("sold-out");
  });
});

describe("formatting helpers", () => {
  it("compact countdown", () => {
    const now = 1_000_000_000_000;
    expect(formatCountdownCompact(now - 1000, now)).toBe("Started");
    expect(formatCountdownCompact(now + 3 * DAY + 4 * 3_600_000, now)).toBe("in 3d 4h");
    expect(formatCountdownCompact(now + 90 * 60_000, now)).toBe("in 1h 30m");
  });
  it("date range collapses a same-day event", () => {
    const t = new Date(2030, 5, 3, 12).getTime();
    expect(formatDateRangeMs(t, t)).not.toContain("–");
    const t2 = new Date(2030, 5, 5, 12).getTime();
    expect(formatDateRangeMs(t, t2)).toContain("–");
  });
});

describe("trending / featured scoring (no daily-random, no badges)", () => {
  it("is deterministic for a fixed now", () => {
    const e = ev({ minted: 50n, maxTickets: 100n });
    const now = 2_000_000_000_000;
    expect(trendingScore(e, now)).toBe(trendingScore(e, now));
  });
  it("ranks a fuller event above an emptier one", () => {
    const now = 2_000_000_000_000;
    const full = ev({ eventId: "0xa", minted: 90n, maxTickets: 100n, startMs: now + DAY, endMs: now + 2 * DAY });
    const empty = ev({ eventId: "0xb", minted: 5n, maxTickets: 100n, startMs: now + DAY, endMs: now + 2 * DAY });
    expect(trendingScore(full, now)).toBeGreaterThan(trendingScore(empty, now));
  });
  it("topTrending excludes already-ended events and caps at n", () => {
    const now = 2_000_000_000_000;
    const upcoming = (id: string) => ev({ eventId: id, startMs: now + DAY, endMs: now + 2 * DAY });
    const past = ev({ eventId: "0xpast", startMs: now - 3 * DAY, endMs: now - DAY });
    const list = [past, upcoming("0x1"), upcoming("0x2"), upcoming("0x3")];
    const out = topTrending(list, 2, now);
    expect(out.length).toBe(2);
    expect(out.find((x) => x.eventId === "0xpast")).toBeUndefined();
  });
  it("featuredEvents drops sold-out and ended", () => {
    const now = 2_000_000_000_000;
    const soldOutEv = ev({ eventId: "0xsold", minted: 100n, maxTickets: 100n, startMs: now + DAY, endMs: now + 2 * DAY });
    const ok = ev({ eventId: "0xok", startMs: now + DAY, endMs: now + 2 * DAY });
    const out = featuredEvents([soldOutEv, ok], 8, now);
    expect(out.map((x) => x.eventId)).toEqual(["0xok"]);
  });
});

describe("recommendation scoring", () => {
  it("rewards category/city/organizer overlap, -1 for seen", () => {
    const profile = [ev({ category: "music", city: "Lagos", organizer: "0xA" })];
    const match = ev({ eventId: "0xm", category: "music", city: "Lagos", organizer: "0xA" });
    const seen = new Set<string>();
    expect(recommendationScore(match, profile, seen)).toBe(4 + 3 + 2);
    expect(recommendationScore(match, profile, new Set(["0xm"]))).toBe(-1);
  });
  it("recommendedEvents returns [] without a profile", () => {
    const all = [ev({ eventId: "0x1" }), ev({ eventId: "0x2" })];
    expect(recommendedEvents(all, new Set(), new Set(), [])).toEqual([]);
  });
  it("recommendedEvents excludes the profile + recently-viewed and ranks the rest", () => {
    const fav = ev({ eventId: "0xfav", category: "tech", city: "SF", organizer: "0xZ" });
    const similar = ev({ eventId: "0xsim", category: "tech", city: "SF", organizer: "0xZ" });
    const unrelated = ev({ eventId: "0xun", category: "food", city: "Tokyo", organizer: "0xY" });
    const all = [fav, similar, unrelated];
    const out = recommendedEvents(all, new Set(["0xfav"]), new Set(), []);
    expect(out.map((x) => x.eventId)).toEqual(["0xsim"]);
  });
});

describe("pushRecentlyViewed", () => {
  it("prepends, dedupes, and caps", () => {
    expect(pushRecentlyViewed(["b", "c"], "a")).toEqual(["a", "b", "c"]);
    expect(pushRecentlyViewed(["a", "b"], "a")).toEqual(["a", "b"]);
    const long = Array.from({ length: 10 }, (_, i) => `e${i}`);
    expect(pushRecentlyViewed(long, "new", 8).length).toBe(8);
    expect(pushRecentlyViewed(long, "new", 8)[0]).toBe("new");
  });
});
