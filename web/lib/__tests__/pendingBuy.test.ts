import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { stashPendingBuy, takePendingBuy } from "../pendingBuy";
import type { BuyPayload } from "@/components/BuyTicketDialog";

describe("pendingBuy", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.useRealTimers());

  const paid: BuyPayload = {
    kind: "paid",
    eventId: "0xevent",
    eventName: "Web3Lagos",
    coinType: "0x2::sui::SUI",
    priceUnits: 1_500_000_000n,
    remaining: 42n,
    maxPerUser: 3n,
  };

  it("round-trips a paid payload with bigints intact", () => {
    stashPendingBuy(paid);
    expect(takePendingBuy()).toEqual(paid);
  });

  it("round-trips a free payload (no coin/price)", () => {
    const free: BuyPayload = { kind: "free", eventId: "0xe", eventName: "Meetup", remaining: 10n };
    stashPendingBuy(free);
    const out = takePendingBuy();
    expect(out).toEqual(free);
    expect(out && "coinType" in out).toBe(false);
  });

  it("is one-shot — a second take returns null", () => {
    stashPendingBuy(paid);
    expect(takePendingBuy()).not.toBeNull();
    expect(takePendingBuy()).toBeNull();
  });

  it("does NOT mistake an eventName that looks like a number marker", () => {
    // A user-controlled name can't be revived into a bigint (no magic markers).
    const weird: BuyPayload = { kind: "free", eventId: "0xe", eventName: "__bn__999" };
    stashPendingBuy(weird);
    const out = takePendingBuy();
    expect(out?.eventName).toBe("__bn__999");
    expect(typeof out?.eventName).toBe("string");
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T00:00:00Z"));
    stashPendingBuy(paid);
    vi.setSystemTime(new Date("2026-06-23T00:05:00Z")); // 5 min later, past the 3 min TTL
    expect(takePendingBuy()).toBeNull();
  });

  it("returns null when nothing is stashed", () => {
    expect(takePendingBuy()).toBeNull();
  });
});
