import { describe, expect, it } from "vitest";
import { humanizeError } from "../moveErrors";

// Smoke tests for the MoveAbort -> human-text mapping. These are pure string
// transforms (no wallet/network), so they're a safe deterministic unit to pin.
describe("humanizeError", () => {
  it("maps a known MoveAbort module+code to its human message", () => {
    // Shape mirrors the real abort string the SDK surfaces:
    // MoveAbort(MoveLocation { module: ModuleId { ... name: Identifier("market") }, function: 0, ... }, 4) in command 0
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("market") }, function: 0, instruction: 10 }, 4) in command 0';
    expect(humanizeError(new Error(raw))).toBe("Sold out.");
  });

  it("maps predict code 7 (bad cutoffs) to its human message", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("predict") }, function: 5, instruction: 1 }, 7) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "Bucket cutoffs must be non-empty and strictly increasing.",
    );
  });

  it("maps predict code 8 (bad bucket) to its human message", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("predict") }, function: 6, instruction: 3 }, 8) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "That bucket doesn't exist for this market.",
    );
  });

  it("maps a different module+code (checkin 8) correctly", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("checkin") }, function: 1, instruction: 2 }, 8) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "Self check-in isn't enabled for this event — the organizer turns it on under Manage → Self check-in.",
    );
  });

  it("maps event code 13 (per-ticket once-per-day dedup) to the sharpened message", () => {
    // E_ALREADY_CHECKED_IN_DAY now fires per-ticket: the same ticket re-presented
    // the same day. Wording reflects "this ticket", not "this wallet".
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("event") }, function: 0, instruction: 5 }, 13) in command 0';
    expect(humanizeError(new Error(raw))).toBe("This ticket is already checked in for today.");
  });

  it("falls back to a generic on-chain message for an unmapped code in a known module", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("market") }, function: 0, instruction: 1 }, 99) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "Transaction rejected on-chain (market code 99).",
    );
  });

  it("recognizes a user-cancelled / rejected transaction", () => {
    expect(humanizeError(new Error("User rejected the request."))).toBe(
      "You cancelled the transaction.",
    );
  });

  it("recognizes a no-gas wallet error", () => {
    expect(humanizeError(new Error("No valid gas coins found for the transaction"))).toBe(
      "Your wallet has no SUI to pay for gas on this action. Add testnet SUI from a faucet and try again.",
    );
  });

  it("passes through an unknown short error verbatim", () => {
    expect(humanizeError(new Error("something odd happened"))).toBe("something odd happened");
  });

  it("truncates a very long unknown error", () => {
    const long = "x".repeat(400);
    const out = humanizeError(new Error(long));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(221); // 220 chars + ellipsis
  });
});
