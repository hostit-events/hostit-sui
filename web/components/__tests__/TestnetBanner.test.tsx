import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// NETWORK is a module-level const fixed at import time from
// process.env.NEXT_PUBLIC_SUI_NETWORK, so it cannot be reassigned at runtime.
// To assert both branches deterministically we mock @/lib/config per case and
// dynamically import the component AFTER the mock so it picks up the stub.
afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/config");
});

async function renderWithNetwork(network: string) {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ NETWORK: network }));
  const { TestnetBanner } = await import("../TestnetBanner");
  return render(<TestnetBanner />);
}

describe("TestnetBanner", () => {
  it("shows a test-coins warning on testnet", async () => {
    await renderWithNetwork("testnet");
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/test coins/i);
    expect(banner).toHaveTextContent(/testnet/i);
  });

  it("renders nothing on mainnet", async () => {
    const { container } = await renderWithNetwork("mainnet");
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
