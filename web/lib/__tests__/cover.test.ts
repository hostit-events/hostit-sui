import { describe, it, expect } from "vitest";
import { buildCoverPrompt } from "@/lib/cover";

describe("buildCoverPrompt", () => {
  it("includes the title and a category-specific hint", () => {
    const p = buildCoverPrompt("Web3Lagos 2026", "web3");
    expect(p).toContain("Web3Lagos 2026");
    expect(p).toContain("blockchain");
  });

  it("steers the model away from rendering text", () => {
    // Our UI overlays the real title, so SDXL must not bake in garbled words.
    expect(buildCoverPrompt("Anything", "music")).toMatch(/no text|no words|no letters/);
  });

  it("falls back to a generic subject + hint for an empty title / unknown category", () => {
    const p = buildCoverPrompt("   ", "not-a-category");
    expect(p).toContain("a vibrant community event");
    expect(p).toContain("vibrant celebratory gathering");
  });
});
