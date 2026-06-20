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
      `${PACKAGE_ID}::forum::post`,
      `${PACKAGE_ID_LATEST}::forum::post_as_organizer`,
      `${PACKAGE_ID_LATEST}::forum::moderate`,
    ]) expect(SPONSORED_TARGETS).toContain(t);
  });

  it("uses PACKAGE_ID_LATEST for upgrade-introduced targets, PACKAGE_ID for original ones", () => {
    // Functions that DON'T exist in the original package (added in an upgrade) must
    // target PACKAGE_ID_LATEST: all predict::*, plus forum::post_as_organizer /
    // forum::moderate (the organizer-admin upgrade). forum::post stays on PACKAGE_ID.
    const latestOrigin = (t: string) =>
      t.includes("::predict::") ||
      t.endsWith("::forum::post_as_organizer") ||
      t.endsWith("::forum::moderate");
    for (const t of SPONSORED_TARGETS) {
      if (t.startsWith("0x2::")) continue; // framework calls
      if (latestOrigin(t)) expect(t.startsWith(PACKAGE_ID_LATEST)).toBe(true);
      else expect(t.startsWith(PACKAGE_ID)).toBe(true);
    }
  });

  it("has no duplicate targets", () => {
    expect(new Set(SPONSORED_TARGETS).size).toBe(SPONSORED_TARGETS.length);
  });
});
