import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Render the disconnected branch deterministically: no wallet, no network.
// WalletScreen's disconnected path is gated on useCurrentAccount() === null.
vi.mock("@/lib/hooks", () => ({
  useCurrentAccount: () => null,
  useSignAndExecute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSponsorAndExecute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSuiQuery: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
}));

import { WalletScreen } from "../WalletScreen";

describe("WalletScreen (disconnected)", () => {
  it("points mobile users at the Account tab, not a phantom top bar", () => {
    render(<WalletScreen />);
    // Heading still renders.
    expect(screen.getByText("No wallet connected")).toBeInTheDocument();
    // The new mobile-accurate copy mentions the Account entry point.
    expect(screen.getByText("Account")).toBeInTheDocument();
    // Regression guard: the old, mobile-wrong instruction is gone.
    expect(
      screen.queryByText(/button in the top bar to access your wallet/i),
    ).toBeNull();
    // The discover escape hatch is still a link.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("/discover");
  });
});
