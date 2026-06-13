import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TxLink } from "../TxLink";

// Smoke test exercising React Testing Library + jsdom on a pure presentational
// component (no wallet/network — TxLink only formats a digest into an explorer
// link via lib/config's explorerTxUrl).
describe("TxLink", () => {
  const digest = "ABCDEFGHIJ1234567890";

  it("renders an external explorer link with the shortened digest", () => {
    render(<TxLink digest={digest} />);
    const link = screen.getByRole("link");
    // Default label "tx" + first 10 chars + ellipsis.
    expect(link).toHaveTextContent("tx ABCDEFGHIJ…");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.getAttribute("href")).toContain(digest);
  });

  it("honors a custom label and char count", () => {
    render(<TxLink digest={digest} label="added · tx" chars={4} />);
    expect(screen.getByRole("link")).toHaveTextContent("added · tx ABCD…");
  });
});
