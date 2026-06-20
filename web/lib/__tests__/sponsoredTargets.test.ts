import { describe, it, expect } from "vitest";
import { SPONSORED_TARGETS, PACKAGE_ID, PACKAGE_ID_LATEST } from "../config";

describe("SPONSORED_TARGETS", () => {
  it("includes the critical sponsored entry points", () => {
    for (const t of [
      `${PACKAGE_ID}::event::create_event`,
      `${PACKAGE_ID}::market::buy`,
      `${PACKAGE_ID}::market::claim_free`,
      `${PACKAGE_ID}::checkin::check_in`,
      `${PACKAGE_ID_LATEST}::predict::bet_yes`,
      `${PACKAGE_ID_LATEST}::predict::claim`,
      `${PACKAGE_ID_LATEST}::predict::claim_range`,
    ]) expect(SPONSORED_TARGETS).toContain(t);
  });

  it("uses PACKAGE_ID_LATEST for every predict target, PACKAGE_ID for other hostit targets", () => {
    for (const t of SPONSORED_TARGETS) {
      if (t.startsWith("0x2::")) continue; // framework calls
      if (t.includes("::predict::")) expect(t.startsWith(PACKAGE_ID_LATEST)).toBe(true);
      else expect(t.startsWith(PACKAGE_ID)).toBe(true);
    }
  });

  it("has no duplicate targets", () => {
    expect(new Set(SPONSORED_TARGETS).size).toBe(SPONSORED_TARGETS.length);
  });
});
