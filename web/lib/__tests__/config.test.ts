import { describe, it, expect } from "vitest";
import { toUnits, fmtAmount } from "../config";

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
