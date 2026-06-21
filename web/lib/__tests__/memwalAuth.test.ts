import { describe, it, expect, vi, beforeEach } from "vitest";

// memwalAuth imports "server-only" (throws if bundled for the client) — neutralize
// it so the module loads under vitest.
vi.mock("server-only", () => ({}));

// The ONLY network/crypto dependency: stub it so we control the recovered signer.
const toSuiAddress = vi.fn();
vi.mock("@mysten/sui/verify", () => ({
  verifyPersonalMessageSignature: vi.fn(async () => ({ toSuiAddress })),
}));

import {
  verifyMemoryCaller,
  isMemoryAuthError,
  __resetNonceStoreForTest,
} from "../memwalAuth";
import { buildMemoryChallenge } from "../memwalChallenge";

const OWNER = "0x" + "a".repeat(64);
const OTHER = "0x" + "b".repeat(64);

beforeEach(() => {
  toSuiAddress.mockReturnValue(OWNER); // signer == owner by default
  // Clear the per-process one-time-nonce fallback so each test sees a fresh store
  // (KV is unset in tests → kvEnabled() is false → the in-memory path is used).
  __resetNonceStoreForTest();
});

function body(message: string, owner = OWNER) {
  return { owner, message, signature: "fake-sig" };
}

describe("verifyMemoryCaller", () => {
  it("returns the verified owner for a well-formed, fresh, signer-matching request", async () => {
    const msg = buildMemoryChallenge(OWNER, Date.now());
    await expect(verifyMemoryCaller(body(msg))).resolves.toBe(OWNER);
  });

  it("rejects when the recovered signer != claimed owner (the IDOR guard)", async () => {
    toSuiAddress.mockReturnValue(OTHER);
    const msg = buildMemoryChallenge(OWNER, Date.now());
    await expect(verifyMemoryCaller(body(msg))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects a challenge whose embedded owner != body.owner (cross-namespace replay)", async () => {
    // signer matches body.owner (OWNER), but the message was built for OTHER.
    const msg = buildMemoryChallenge(OTHER, Date.now());
    await expect(verifyMemoryCaller(body(msg, OWNER))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects an expired challenge (older than the 5-min window)", async () => {
    const msg = buildMemoryChallenge(OWNER, Date.now() - 6 * 60 * 1000);
    await expect(verifyMemoryCaller(body(msg))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects a future-dated challenge (beyond 1-min skew)", async () => {
    const msg = buildMemoryChallenge(OWNER, Date.now() + 2 * 60 * 1000);
    await expect(verifyMemoryCaller(body(msg))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects a malformed challenge (wrong domain / line count)", async () => {
    await expect(verifyMemoryCaller(body("not-the-challenge"))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects missing fields before any crypto", async () => {
    await expect(verifyMemoryCaller({})).rejects.toSatisfy(isMemoryAuthError);
    await expect(verifyMemoryCaller({ owner: OWNER })).rejects.toSatisfy(isMemoryAuthError);
  });

  it("rejects an identical resend of a signed challenge (one-time-nonce replay)", async () => {
    // ONE challenge + envelope; the first use is legitimate, the byte-identical
    // resend is the replay vector and must be rejected.
    const msg = buildMemoryChallenge(OWNER, Date.now());
    await expect(verifyMemoryCaller(body(msg))).resolves.toBe(OWNER);
    await expect(verifyMemoryCaller(body(msg))).rejects.toSatisfy(isMemoryAuthError);
  });

  it("accepts two DISTINCT fresh challenges (nonce keys on the message, not the owner)", async () => {
    // Distinct timestamps → distinct messages → distinct nonce keys, so both the
    // first uses succeed for the SAME owner.
    const msg1 = buildMemoryChallenge(OWNER, Date.now());
    const msg2 = buildMemoryChallenge(OWNER, Date.now() + 1);
    await expect(verifyMemoryCaller(body(msg1))).resolves.toBe(OWNER);
    await expect(verifyMemoryCaller(body(msg2))).resolves.toBe(OWNER);
  });
});
