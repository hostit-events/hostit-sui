import { describe, it, expect } from "vitest";
import { foldModeration, MOD_HIDE, MOD_UNHIDE, MOD_PIN, MOD_UNPIN, type ModerationJson } from "../forum";

function ev(blob: string, action: number, ts: number): ModerationJson {
  return { event_id: "0xE", target_blob_id: blob, action, by: "0xORG", ts_ms: ts };
}

describe("foldModeration", () => {
  it("returns empty state for no events", () => {
    expect(foldModeration([]).size).toBe(0);
  });

  it("marks a blob hidden / pinned", () => {
    const m = foldModeration([ev("a", MOD_HIDE, 1), ev("b", MOD_PIN, 1)]);
    expect(m.get("a")).toEqual({ hidden: true, pinned: false });
    expect(m.get("b")).toEqual({ hidden: false, pinned: true });
  });

  it("latest action per blob wins regardless of input order", () => {
    // hide then unhide (later ts) → not hidden, even if passed out of order
    const m = foldModeration([ev("a", MOD_UNHIDE, 20), ev("a", MOD_HIDE, 10)]);
    expect(m.get("a")?.hidden).toBe(false);
  });

  it("hide and pin compose independently on one blob", () => {
    const m = foldModeration([ev("a", MOD_HIDE, 1), ev("a", MOD_PIN, 2)]);
    expect(m.get("a")).toEqual({ hidden: true, pinned: true });
  });

  it("unpin reverses an earlier pin", () => {
    const m = foldModeration([ev("a", MOD_PIN, 1), ev("a", MOD_UNPIN, 5)]);
    expect(m.get("a")?.pinned).toBe(false);
  });

  it("ignores an unknown action code (no-op)", () => {
    const m = foldModeration([ev("a", 99, 1)]);
    expect(m.get("a")).toEqual({ hidden: false, pinned: false });
  });
});
