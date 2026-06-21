import { describe, expect, it } from "vitest";
import { canAfford } from "@/components/screens/EventPageScreen";

// Pure-logic test for the Buy panel's balance pre-check. `canAfford` decides
// whether a wallet's coin balance (smallest units) can cover a fee-inclusive
// ticket total. It must NOT flash-disable Buy while the balance is still
// loading (undefined === "unknown" → allowed). See plan 016.

describe("canAfford (Buy balance pre-check)", () => {
  it("blocks when balance is below the fee-inclusive total", () => {
    expect(canAfford(0n, 1_030_000n)).toBe(false);
    expect(canAfford(1_029_999n, 1_030_000n)).toBe(false);
  });
  it("allows when balance exactly covers the total", () => {
    expect(canAfford(1_030_000n, 1_030_000n)).toBe(true);
  });
  it("allows when balance exceeds the total", () => {
    expect(canAfford(5_000_000n, 1_030_000n)).toBe(true);
  });
  it("does not block while the balance is still loading (undefined)", () => {
    expect(canAfford(undefined, 1_030_000n)).toBe(true);
  });
});
