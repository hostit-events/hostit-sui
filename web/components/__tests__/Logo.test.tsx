import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Logo } from "../Logo";

// Smoke test for the shared brand mark: it must render the real
// `logo-white.png` asset (never the prototype's inline gradient glyph) and
// honor the `size` prop.
describe("Logo", () => {
  it("renders the real white brand asset", () => {
    render(<Logo />);
    const img = screen.getByAltText("HostIt");
    expect(img).toHaveAttribute("src", "/brand/logo-white.png");
  });

  it("applies the size prop to the rendered height", () => {
    render(<Logo size={32} />);
    const img = screen.getByAltText("HostIt");
    expect(img).toHaveStyle({ height: "32px" });
  });
});
