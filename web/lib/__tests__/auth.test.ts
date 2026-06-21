import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Capture what useGoogleSignIn hands to Enoki's createAuthorizationURL.
const createAuthorizationURL = vi.fn(
  (_input: { provider: string; extraParams?: { scope?: string[] } }) =>
    Promise.resolve("https://accounts.google.com/o/oauth2/v2/auth?stub"),
);

vi.mock("@mysten/enoki/react", () => ({
  useEnokiFlow: () => ({ createAuthorizationURL, logout: vi.fn() }),
  useZkLogin: () => ({ address: null }),
}));
vi.mock("@mysten/dapp-kit-react", () => ({
  useDAppKit: () => ({ disconnectWallet: vi.fn() }),
}));

import { useGoogleSignIn } from "../auth";

describe("useGoogleSignIn", () => {
  beforeEach(() => createAuthorizationURL.mockClear());

  // Regression for #96: Enoki defaults the scope to just "openid", and Google
  // only emits `email`/`email_verified` claims when the `email` scope is asked
  // for. Without it, /api/email/bind-google rejects with "Google email not
  // verified". This pins the call site so the scope can't be dropped again.
  it("requests the Google `email` scope", async () => {
    const { result } = renderHook(() => useGoogleSignIn());
    await result.current();
    expect(createAuthorizationURL).toHaveBeenCalledTimes(1);
    const arg = createAuthorizationURL.mock.calls[0][0];
    expect(arg.provider).toBe("google");
    expect(arg.extraParams?.scope).toContain("email");
  });
});
