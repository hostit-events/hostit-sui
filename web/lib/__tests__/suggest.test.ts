import { describe, it, expect } from "vitest";
import {
  coerceSuggestion,
  FUNNY_FALLBACKS,
  pickFallback,
  SUGGEST_CATEGORIES,
} from "../suggest";

// coerceSuggestion validates + clamps UNTRUSTED model output before it can reach
// the create form (#93). These pin the safety boundaries.
describe("coerceSuggestion", () => {
  const base = { name: "Test Event", description: "A short blurb." };

  it("returns null without a name or description", () => {
    expect(coerceSuggestion(null)).toBeNull();
    expect(coerceSuggestion({})).toBeNull();
    expect(coerceSuggestion({ name: "Only name" })).toBeNull();
    expect(coerceSuggestion({ description: "only desc" })).toBeNull();
  });

  it("falls back to a valid category when the model gives a bad one", () => {
    expect(coerceSuggestion({ ...base, category: "ponzi" })!.category).toBe("community");
    expect(coerceSuggestion({ ...base, category: "TECH" })!.category).toBe("tech"); // lowercased
    for (const c of SUGGEST_CATEGORIES) {
      expect(coerceSuggestion({ ...base, category: c })!.category).toBe(c);
    }
  });

  it("clamps capacity into range and floors it", () => {
    expect(coerceSuggestion({ ...base, capacity: 5_000_000 })!.capacity).toBe(100_000);
    expect(coerceSuggestion({ ...base, capacity: 42.9 })!.capacity).toBe(42);
    expect(coerceSuggestion({ ...base, capacity: 0 })!.capacity).toBe(100); // default
    expect(coerceSuggestion({ ...base, capacity: "nope" })!.capacity).toBe(100);
  });

  it("drops price/coin for free events and sets them for paid ones", () => {
    const free = coerceSuggestion({ ...base, free: true, price: 9, coin: "USDC" })!;
    expect(free.free).toBe(true);
    expect(free.price).toBeUndefined();
    expect(free.coin).toBeUndefined();

    const paid = coerceSuggestion({ ...base, free: false, price: 12.5, coin: "USDC" })!;
    expect(paid.free).toBe(false);
    expect(paid.price).toBe(12.5);
    expect(paid.coin).toBe("USDC");

    // paid but missing/invalid price -> small default, coin defaults to SUI
    const paidBad = coerceSuggestion({ ...base, free: false, price: -3 })!;
    expect(paidBad.price).toBe(5);
    expect(paidBad.coin).toBe("SUI");
  });

  it("caps long strings and trims empties to undefined", () => {
    const long = "x".repeat(500);
    const s = coerceSuggestion({ ...base, name: long, tag: "   ", venue: "  V  " })!;
    expect(s.name.length).toBe(80);
    expect(s.tag).toBeUndefined();
    expect(s.venue).toBe("V");
  });
});

describe("curated fallbacks", () => {
  it("are all valid coerced suggestions", () => {
    for (const f of FUNNY_FALLBACKS) {
      const c = coerceSuggestion(f);
      expect(c).not.toBeNull();
      expect(SUGGEST_CATEGORIES).toContain(c!.category);
      if (!c!.free) {
        expect(c!.price).toBeGreaterThan(0);
        expect(["SUI", "USDC"]).toContain(c!.coin);
      }
    }
  });

  it("pickFallback returns one of the curated concepts", () => {
    expect(FUNNY_FALLBACKS).toContain(pickFallback());
  });
});
