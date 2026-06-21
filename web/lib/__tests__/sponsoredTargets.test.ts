import { describe, it, expect } from "vitest";
import { SPONSORED_TARGETS, PACKAGE_ID } from "../config";

describe("SPONSORED_TARGETS", () => {
  it("includes the critical sponsored entry points", () => {
    for (const t of [
      `${PACKAGE_ID}::event::create_event`,
      `${PACKAGE_ID}::event::remove_checkin_signer`,
      `${PACKAGE_ID}::event::set_cancelled`,
      `${PACKAGE_ID}::event::set_poap_enabled`,
      `${PACKAGE_ID}::event::remove_price`,
      `${PACKAGE_ID}::market::buy`,
      `${PACKAGE_ID}::market::claim_free`,
      `${PACKAGE_ID}::checkin::check_in`,
      `${PACKAGE_ID}::poap::claim_poap`,
      `${PACKAGE_ID}::predict::bet_yes`,
      `${PACKAGE_ID}::predict::claim`,
      `${PACKAGE_ID}::predict::claim_range`,
      `${PACKAGE_ID}::forum::post`,
      `${PACKAGE_ID}::forum::post_as_organizer`,
      `${PACKAGE_ID}::forum::moderate`,
      `${PACKAGE_ID}::reviews::post_review`,
      `${PACKAGE_ID}::identity::register_email`,
      `${PACKAGE_ID}::identity::grant_email_access`,
    ])
      expect(SPONSORED_TARGETS).toContain(t);
  });

  it("every non-framework target resolves to the single PACKAGE_ID", () => {
    // Fresh-publish deploy model: there is ONE package id, so every sponsored
    // move-call target is `${PACKAGE_ID}::…` (0x2 framework calls excepted). The
    // old PACKAGE_ID_LATEST / type-origin split is gone.
    for (const t of SPONSORED_TARGETS) {
      if (t.startsWith("0x2::")) continue; // framework calls
      expect(t.startsWith(PACKAGE_ID)).toBe(true);
    }
  });

  it("has no duplicate targets", () => {
    expect(new Set(SPONSORED_TARGETS).size).toBe(SPONSORED_TARGETS.length);
  });
});
