import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// Capture what useGoogleSignIn hands to Enoki's createAuthorizationURL.
const createAuthorizationURL = vi.fn(
  (_input: { provider: string; redirectUrl?: string; extraParams?: { scope?: string[] } }) =>
    Promise.resolve("https://accounts.google.com/o/oauth2/v2/auth?stub"),
);

vi.mock("@mysten/enoki/react", () => ({
  useEnokiFlow: () => ({ createAuthorizationURL, logout: vi.fn() }),
  useZkLogin: () => ({ address: null }),
}));
vi.mock("@mysten/dapp-kit-react", () => ({
  useDAppKit: () => ({ disconnectWallet: vi.fn() }),
}));

import { useGoogleSignIn, RETURN_TO_KEY, safeReturnTo } from "../auth";

describe("useGoogleSignIn", () => {
  beforeEach(() => {
    createAuthorizationURL.mockClear();
    sessionStorage.clear();
  });

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

  // Regression for the `redirect_uri_mismatch` on returnTo sign-in (e.g. the
  // Buy dialog on /discover): the return target must NOT ride in the redirect_uri
  // query string — Google matches redirect_uri exactly, so a varying `?next=`
  // breaks the single registered `/auth`. It rides in sessionStorage instead.
  it("keeps redirect_uri at a query-less /auth and carries returnTo via sessionStorage", async () => {
    const { result } = renderHook(() => useGoogleSignIn());
    await result.current("/discover");
    const arg = createAuthorizationURL.mock.calls[0][0];
    expect(arg.redirectUrl).toBeDefined();
    const redirect = new URL(arg.redirectUrl!);
    expect(redirect.pathname).toBe("/auth");
    expect(redirect.search).toBe(""); // no ?next= → exact match with the registered URI
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBe("/discover");
  });

  // An absolute / protocol-relative returnTo is an open-redirect vector — drop it.
  it("ignores a non-same-origin returnTo", async () => {
    const { result } = renderHook(() => useGoogleSignIn());
    await result.current("https://evil.example/phish");
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });

  // The backslash open-redirect: "/\evil.com" passes a naive startsWith("/") &&
  // !startsWith("//") guard but URL-normalizes to host evil.com. Must NOT stash.
  it("drops a backslash open-redirect returnTo", async () => {
    const { result } = renderHook(() => useGoogleSignIn());
    await result.current("/\\evil.com");
    expect(sessionStorage.getItem(RETURN_TO_KEY)).toBeNull();
  });
});

describe("safeReturnTo (open-redirect guard)", () => {
  it("accepts a same-origin app path and preserves search + hash", () => {
    expect(safeReturnTo("/discover")).toBe("/discover");
    expect(safeReturnTo("/event/0x1?ref=x#top")).toBe("/event/0x1?ref=x#top");
  });

  it("rejects the classic and backslash open-redirect forms", () => {
    // `/\evil.com` and `/\/evil.com` normalize to host evil.com under WHATWG URL.
    expect(safeReturnTo("/\\evil.com")).toBeNull();
    expect(safeReturnTo("/\\/evil.com")).toBeNull();
    expect(safeReturnTo("//evil.com")).toBeNull(); // protocol-relative
    expect(safeReturnTo("https://evil.example/phish")).toBeNull(); // absolute
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo(null)).toBeNull();
  });
});
