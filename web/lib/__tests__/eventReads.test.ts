import { describe, it, expect } from "vitest";
import { decodeU64 } from "../ticketing";

describe("decodeU64 (devInspect u64 return value)", () => {
  it("decodes little-endian bytes to a bigint", () => {
    // 1_000_000 = 0x0F4240 -> LE 8 bytes
    expect(decodeU64([64, 66, 15, 0, 0, 0, 0, 0])).toBe(1_000_000n);
  });
  it("decodes zero", () => {
    expect(decodeU64([0, 0, 0, 0, 0, 0, 0, 0])).toBe(0n);
  });
  it("decodes u64::MAX", () => {
    expect(decodeU64([255, 255, 255, 255, 255, 255, 255, 255])).toBe(18446744073709551615n);
  });
});
