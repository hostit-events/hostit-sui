import { describe, it, expect } from "vitest";
import {
  toUnits,
  fmtAmount,
  coinInfo,
  matchesCoinType,
  SUI_COIN_TYPE,
  USDC_COIN_TYPE,
  EV_POAP_CLAIMED,
  EV_TICKET_MINTED,
  PACKAGE_ID,
} from "../config";

describe("toUnits", () => {
  it("converts whole and fractional exactly", () => {
    expect(toUnits("1", 9)).toBe(1_000_000_000n);
    expect(toUnits("1.5", 6)).toBe(1_500_000n);
    expect(toUnits("0.000001", 6)).toBe(1n);
  });
  it("is exact past Number.MAX_SAFE_INTEGER (float path was not)", () => {
    expect(toUnits("9007199.254740993", 9)).toBe(9_007_199_254_740_993n);
  });
  it("rejects more fractional digits than decimals", () => {
    expect(toUnits("1.1234567", 6)).toBeNull(); // 7 dp for a 6-dp coin
  });
  it("rejects malformed / empty", () => {
    expect(toUnits("", 9)).toBeNull();
    expect(toUnits(".", 9)).toBeNull();
    expect(toUnits("1.2.3", 9)).toBeNull();
    expect(toUnits("abc", 9)).toBeNull();
  });
});

describe("fmtAmount", () => {
  it("formats whole amounts grouped", () => {
    expect(fmtAmount(1_234n * 10n ** 9n, 9)).toMatch(/1.?234/); // grouped (locale-robust)
  });
  it("returns 0 for zero", () => {
    expect(fmtAmount(0n, 6)).toBe("0");
  });
  it("trims trailing fractional zeros", () => {
    expect(fmtAmount(1_500_000n, 6)).toBe("1.5");
  });
  it("groups with ',' so it never collides with the '.' decimal", () => {
    expect(fmtAmount(1_234_500_000n, 6)).toBe("1,234.5");
  });
});

describe("coin-type normalization (ticket price showed '?' instead of SUI)", () => {
  // How SUI arrives in PriceSet events: a `type_name` — no 0x, address padded to
  // 64 hex chars. The old `^0x0*` normalizer didn't strip these zeros, so it never
  // matched `0x2::sui::SUI` and the symbol fell back to "?".
  const SUI_TYPE_NAME =
    "0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

  it("matchesCoinType equates every shape of the SUI type", () => {
    expect(matchesCoinType(SUI_TYPE_NAME, SUI_COIN_TYPE)).toBe(true);
    expect(matchesCoinType(`0x${SUI_TYPE_NAME}`, SUI_COIN_TYPE)).toBe(true);
    expect(matchesCoinType("0x2::sui::SUI", SUI_COIN_TYPE)).toBe(true);
  });

  it("coinInfo resolves SUI (was '?') and USDC from any shape, with right decimals", () => {
    expect(coinInfo(SUI_TYPE_NAME)).toMatchObject({ symbol: "SUI", decimals: 9 });
    expect(coinInfo(`0x${SUI_TYPE_NAME}`).symbol).toBe("SUI");
    expect(coinInfo("0x2::sui::SUI").symbol).toBe("SUI");
    expect(coinInfo(USDC_COIN_TYPE)).toMatchObject({ symbol: "USDC", decimals: 6 });
  });

  it("still returns '?' for a genuinely unknown coin", () => {
    expect(coinInfo("0xdead::foo::BAR").symbol).toBe("?");
    expect(matchesCoinType("0xdead::foo::BAR", SUI_COIN_TYPE)).toBe(false);
  });
});

describe("activity-feed event types (GH#56)", () => {
  it("EV_POAP_CLAIMED is pinned to PACKAGE_ID (the original package introduced poap)", () => {
    expect(EV_POAP_CLAIMED).toBe(`${PACKAGE_ID}::poap::PoapClaimed`);
  });
  it("EV_TICKET_MINTED is pinned to PACKAGE_ID (market is an original module)", () => {
    expect(EV_TICKET_MINTED).toBe(`${PACKAGE_ID}::market::TicketMinted`);
  });
});
