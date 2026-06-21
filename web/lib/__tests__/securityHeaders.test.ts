import { describe, it, expect } from "vitest";
import { buildCsp } from "../../next.config";

describe("Content-Security-Policy", () => {
  const prod = buildCsp(false);
  const dev = buildCsp(true);

  it("blocks framing and restricts the base set", () => {
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("object-src 'none'");
  });

  it("allows exactly the real runtime origins the app needs", () => {
    for (const o of [
      "https://fullnode.testnet.sui.io",
      "https://api.enoki.mystenlabs.com",
      "https://aggregator.walrus-testnet.walrus.space",
      "https://seal-aggregator-testnet.mystenlabs.com",
      "https://api.iconify.design",
    ]) {
      expect(prod).toContain(o); // in connect-src
    }
    expect(prod).toContain("https://code.iconify.design"); // script-src
    expect(prod).toContain("https://fonts.googleapis.com"); // style-src
    expect(prod).toContain("https://fonts.gstatic.com"); // font-src
    expect(prod).toContain("https://placehold.co"); // img-src
  });

  it("does NOT leak server-only origins into the browser policy", () => {
    expect(prod).not.toContain("api.groq.com");
  });

  it("is strict in production but loosened for HMR in dev", () => {
    expect(prod).not.toContain("'unsafe-eval'");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws:");
  });
});
