import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Footer } from "../Footer";
import { NETWORK, PACKAGE_ID } from "@/lib/config";

// Pins the key porting invariant: the Network column must read real
// `lib/config` values, never the prototype's hardcoded fakes
// ("Sui Mainnet" / "~0.001 SUI" / a block number).
describe("Footer", () => {
  it("renders the real network from lib/config", () => {
    render(<Footer />);
    expect(screen.getByText(NETWORK)).toBeInTheDocument();
  });

  it("renders the real package id (shortened)", () => {
    render(<Footer />);
    const shortPkg = `${PACKAGE_ID.slice(0, 10)}…${PACKAGE_ID.slice(-4)}`;
    expect(screen.getByText(shortPkg)).toBeInTheDocument();
  });

  it("does not regress to the prototype's hardcoded fakes", () => {
    render(<Footer />);
    expect(screen.queryByText("Sui Mainnet")).not.toBeInTheDocument();
    expect(screen.queryByText("~0.001 SUI")).not.toBeInTheDocument();
    expect(screen.queryByText(/#124,587,412/)).not.toBeInTheDocument();
  });

  it("links Platform entries at real live routes", () => {
    render(<Footer />);
    expect(screen.getByText("Discover events").closest("a")).toHaveAttribute("href", "/discover");
    expect(screen.getByText("My tickets").closest("a")).toHaveAttribute("href", "/wallet");
    expect(screen.getByText("Create event").closest("a")).toHaveAttribute("href", "/create");
  });
});
