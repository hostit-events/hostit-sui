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
      // Testnet JSON-RPC (BlockVision by default — Mysten disabled JSON-RPC on the
      // public testnet fullnode; NEXT_PUBLIC_SUI_RPC_URL overrides both this and
      // the endpoint reads use, so they stay in lockstep).
      "https://sui-testnet-endpoint.blockvision.org",
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

  it("allows Cloudflare Turnstile (bot-wall) in script-src, frame-src AND connect-src (#81)", () => {
    const directive = (name: string) =>
      prod
        .split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith(`${name} `));
    const scriptSrc = directive("script-src");
    const frameSrc = directive("frame-src");
    const connectSrc = directive("connect-src");
    // The Turnstile api.js loads under script-src; its challenge iframe needs a
    // frame-src (distinct from frame-ancestors, which stays 'none'); and the
    // widget XHRs its challenge-platform payload, which needs connect-src — the
    // missing connect-src entry is what made the widget never load and every
    // sponsored call 403.
    expect(scriptSrc).toContain("https://challenges.cloudflare.com");
    expect(frameSrc).toBeDefined();
    expect(frameSrc).toContain("https://challenges.cloudflare.com");
    expect(connectSrc).toContain("https://challenges.cloudflare.com");
    expect(prod).toContain("frame-ancestors 'none'");
  });

  it("is strict in production but loosened for HMR in dev", () => {
    expect(prod).not.toContain("'unsafe-eval'");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws:");
  });
});
