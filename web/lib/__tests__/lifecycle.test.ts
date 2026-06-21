import { describe, it, expect } from "vitest";
import { lifecycleStage, stageIndex, STAGE_ORDER } from "../lifecycle";

const e = { purchaseStartMs: 100, startMs: 200, endMs: 300 };

describe("lifecycleStage", () => {
  it("is drafting before sales open", () => {
    expect(lifecycleStage(e, 50)).toBe("drafting");
    expect(lifecycleStage(e, 99)).toBe("drafting");
  });
  it("is onSale within [purchase_start, start)", () => {
    expect(lifecycleStage(e, 100)).toBe("onSale");
    expect(lifecycleStage(e, 199)).toBe("onSale");
  });
  it("is doorsOpen within [start, end)", () => {
    expect(lifecycleStage(e, 200)).toBe("doorsOpen");
    expect(lifecycleStage(e, 299)).toBe("doorsOpen");
  });
  it("is wrapped at/after end", () => {
    expect(lifecycleStage(e, 300)).toBe("wrapped");
    expect(lifecycleStage(e, 9999)).toBe("wrapped");
  });
  it("orders stages chronologically", () => {
    expect(stageIndex("drafting")).toBe(0);
    expect(stageIndex("wrapped")).toBe(STAGE_ORDER.length - 1);
  });
});
