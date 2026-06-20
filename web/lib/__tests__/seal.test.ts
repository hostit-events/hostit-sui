import { describe, it, expect, afterEach, vi } from "vitest";

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
