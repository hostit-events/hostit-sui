import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventPoster } from "../EventPoster";

// Smoke test for the cover-image overlay in EventPoster. The cover <img> is
// decorative (alt="") so it has role="presentation" and is NOT found by
// getByRole("img") — query it directly. Asserts the perf attributes
// (lazy-load, async-decode, intrinsic size) and that no <img> renders without
// a coverUrl.
describe("EventPoster cover image", () => {
  it("renders the cover img with lazy-load, async-decode, and intrinsic size", () => {
    const { container } = render(
      <EventPoster seed="evt-1" category="music" coverUrl="https://example.test/cover" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveAttribute("width", "1200");
    expect(img).toHaveAttribute("height", "630");
    expect(img).toHaveAttribute("src", "https://example.test/cover");
    expect(img).toHaveClass("object-cover");
  });

  it("renders no cover img when coverUrl is absent", () => {
    const { container } = render(<EventPoster seed="evt-2" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
