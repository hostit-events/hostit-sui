import { describe, expect, it, vi } from "vitest";

// The route transitively imports "server-only" (via @/lib/rateLimit, which has
// `import "server-only"`), which throws when loaded outside a Server Component.
// Neutralize it so the module loads under vitest — same pattern as
// memwalAuth.test.ts:5. This mock must precede the route import.
vi.mock("server-only", () => ({}));

import { sanitizeMessages, MAX_MSG_CONTENT_LEN } from "../../app/api/copilot/route";

// Pure-logic tests for the copilot route's message sanitizer (mirrors the
// chain-free style of predict.test.ts). sanitizeMessages whitelists each chat
// turn into a fresh { role, content } object, dropping malformed entries and
// clamping content length to bound the prompt-injection / token-cost surface.

describe("sanitizeMessages (copilot)", () => {
  it("passes a well-formed turn through unchanged", () => {
    expect(sanitizeMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("clamps content to MAX_MSG_CONTENT_LEN", () => {
    const long = "x".repeat(MAX_MSG_CONTENT_LEN + 100);
    const [m] = sanitizeMessages([{ role: "assistant", content: long }]);
    expect(m.content.length).toBe(MAX_MSG_CONTENT_LEN);
  });

  it("drops malformed entries (bad role, non-string content, non-object)", () => {
    expect(
      sanitizeMessages([
        { role: "system", content: "no" },
        { role: "user", content: 42 },
        null,
        7,
        { role: "user", content: "ok" },
      ]),
    ).toEqual([{ role: "user", content: "ok" }]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeMessages(undefined)).toEqual([]);
    expect(sanitizeMessages("x")).toEqual([]);
  });
});
