import { describe, it, expect, afterEach, vi } from "vitest";
import { fromHex } from "@mysten/sui/utils";
import { ORG_NS_TAG, makeOrganizerSealId, makeSealId } from "../seal";

// SEAL_VERIFY_KEY_SERVERS is derived from NETWORK at module-load time, so each
// case sets the env var, resets the module registry, and re-imports config.
async function loadFlagFor(network: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (network === undefined) delete process.env.NEXT_PUBLIC_SUI_NETWORK;
  else process.env.NEXT_PUBLIC_SUI_NETWORK = network;
  const mod = await import("../config");
  return mod.SEAL_VERIFY_KEY_SERVERS;
}

describe("SEAL_VERIFY_KEY_SERVERS", () => {
  const original = process.env.NEXT_PUBLIC_SUI_NETWORK;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SUI_NETWORK;
    else process.env.NEXT_PUBLIC_SUI_NETWORK = original;
    vi.resetModules();
  });

  it("is true on testnet", async () => {
    expect(await loadFlagFor("testnet")).toBe(true);
  });
  it("is true on mainnet", async () => {
    expect(await loadFlagFor("mainnet")).toBe(true);
  });
  it("is true when network is unset (defaults to testnet)", async () => {
    expect(await loadFlagFor(undefined)).toBe(true);
  });
  it("is false only on localnet", async () => {
    expect(await loadFlagFor("localnet")).toBe(false);
  });
});

// Plan 007: an organizer-only Seal id is domain-separated from the shared
// (ticket) namespace by the ORG_NS_TAG prefix, so a ticket holder's policy
// (is_prefix(event_id, id)) can never match it. The TS tag MUST stay
// byte-identical to ORG_NS_TAG in sources/access.move ("hostit-org:").
const EVENT_ID = "0x000000000000000000000000000000000000000000000000000000000000000a";

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > buf.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

describe("makeOrganizerSealId / ORG_NS_TAG", () => {
  it("ORG_NS_TAG is the UTF-8 of 'hostit-org:' (must match access.move)", () => {
    expect(Array.from(ORG_NS_TAG)).toEqual(
      Array.from(new TextEncoder().encode("hostit-org:")),
    );
  });

  it("an organizer Seal id begins with ORG_NS_TAG then the event-id bytes", () => {
    const id = fromHex(makeOrganizerSealId(EVENT_ID));
    expect(startsWith(id, ORG_NS_TAG)).toBe(true);
    // tag ‖ event_id ‖ 5-byte nonce
    expect(id.length).toBe(ORG_NS_TAG.length + fromHex(EVENT_ID).length + 5);
    const afterTag = id.slice(ORG_NS_TAG.length);
    expect(startsWith(afterTag, fromHex(EVENT_ID))).toBe(true);
  });

  it("a shared (bare event-id) Seal id does NOT begin with ORG_NS_TAG", () => {
    const id = fromHex(makeSealId(EVENT_ID));
    expect(startsWith(id, ORG_NS_TAG)).toBe(false);
    // It begins with the bare event id — the namespace the ticket policy checks.
    expect(startsWith(id, fromHex(EVENT_ID))).toBe(true);
  });
});
