import { describe, it, expect } from "vitest";
import { canonicalizeEmail, isValidEmail } from "../emailCanonical";

describe("canonicalizeEmail", () => {
  it("lowercases and trims", () => {
    expect(canonicalizeEmail("  Bob@Example.com ")).toBe("bob@example.com");
  });
  it("strips a +tag for any provider", () => {
    expect(canonicalizeEmail("bob+newsletter@example.com")).toBe("bob@example.com");
    expect(canonicalizeEmail("bob+a+b@proton.me")).toBe("bob@proton.me");
  });
  it("folds gmail dots and googlemail → gmail", () => {
    expect(canonicalizeEmail("b.o.b@gmail.com")).toBe("bob@gmail.com");
    expect(canonicalizeEmail("bob@googlemail.com")).toBe("bob@gmail.com");
    expect(canonicalizeEmail("b.o.b+promo@googlemail.com")).toBe("bob@gmail.com");
  });
  it("keeps dots for non-gmail providers", () => {
    expect(canonicalizeEmail("b.o.b@proton.me")).toBe("b.o.b@proton.me");
  });
  it("returns '' for malformed input", () => {
    expect(canonicalizeEmail("nope")).toBe("");
    expect(canonicalizeEmail("@example.com")).toBe("");
    expect(canonicalizeEmail("bob@")).toBe("");
    expect(canonicalizeEmail("bob@localhost")).toBe(""); // no dot in domain
    expect(canonicalizeEmail("+tag@gmail.com")).toBe(""); // empty local after tag strip
  });
  it("isValidEmail shape check", () => {
    expect(isValidEmail("bob@example.com")).toBe(true);
    expect(isValidEmail(" a@b.co ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});
