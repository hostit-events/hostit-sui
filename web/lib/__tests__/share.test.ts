import { describe, it, expect } from "vitest";
import { eventShareUrl, socialShareLinks } from "../share";

describe("eventShareUrl", () => {
  it("builds an absolute URL when an origin is given", () => {
    expect(eventShareUrl("0xabc", "https://hostit-sui.vercel.app")).toBe(
      "https://hostit-sui.vercel.app/event/0xabc",
    );
  });
  it("falls back to a root-relative path with no origin (SSR)", () => {
    expect(eventShareUrl("0xabc", "")).toBe("/event/0xabc");
  });
  it("uses the route, not the prototype's ?event= query param", () => {
    const url = eventShareUrl("0xdeadbeef", "https://x.com");
    expect(url).toContain("/event/0xdeadbeef");
    expect(url).not.toContain("?event=");
  });
});

describe("socialShareLinks", () => {
  const url = "https://hostit-sui.vercel.app/event/0xabc";
  const links = socialShareLinks("My Event", url);

  it("returns X, Farcaster and Lens intents", () => {
    expect(links.map((l) => l.id)).toEqual(["x", "farcaster", "lens"]);
  });
  it("URL-encodes the event URL into every intent href", () => {
    const encoded = encodeURIComponent(url);
    for (const l of links) expect(l.href).toContain(encoded);
  });
  it("URL-encodes the share text into every intent href", () => {
    const encodedText = encodeURIComponent("My Event");
    for (const l of links) expect(l.href).toContain(encodedText);
  });
  it("points X at the tweet intent and Farcaster at the warpcast composer", () => {
    expect(links[0].href).toContain("twitter.com/intent/tweet");
    expect(links[1].href).toContain("warpcast.com/~/compose");
    expect(links[2].href).toContain("share.lens.xyz");
  });
});
