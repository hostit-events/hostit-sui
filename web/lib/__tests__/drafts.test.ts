import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  upsertEntry,
  removeEntry,
  listDrafts,
  deleteDraft,
  saveDraft,
  loadDraft,
  type DraftIndexEntry,
} from "../drafts";

// In-memory Walrus + identity Seal so saveDraft/loadDraft round-trip with no
// network or real crypto. vi.hoisted shares state into the hoisted mock factories.
const mem = vi.hoisted(() => ({ blobs: new Map<string, Uint8Array>(), n: 0 }));
vi.mock("../seal", () => ({
  sealEncrypt: async (_c: unknown, _addr: string, plaintext: Uint8Array) => ({
    id: "seal-nonce",
    ciphertext: plaintext,
  }),
  sealDecrypt: async (_c: unknown, _sk: unknown, ct: Uint8Array) => ct,
  approveSelf: () => {},
}));
vi.mock("../walrus", () => ({
  storeBlob: async (bytes: Uint8Array) => {
    const id = `b${mem.n++}`;
    mem.blobs.set(id, bytes);
    return id;
  },
  readBlob: async (id: string) => {
    const b = mem.blobs.get(id);
    if (!b) throw new Error("not found");
    return b;
  },
}));

// Build a minimal index entry with overridable fields.
function entry(id: string, over: Partial<DraftIndexEntry> = {}): DraftIndexEntry {
  return {
    id,
    blobId: `blob-${id}`,
    title: `Draft ${id}`,
    mode: "quick",
    savedAt: 1000,
    ...over,
  };
}

describe("upsertEntry (pure)", () => {
  it("appends a new id to the end", () => {
    const list = [entry("a"), entry("b")];
    const next = upsertEntry(list, entry("c"));
    expect(next.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("REPLACES an existing id in place — no dupes, count unchanged, order preserved", () => {
    const list = [entry("a"), entry("b"), entry("c")];
    const next = upsertEntry(list, entry("b", { title: "Renamed", savedAt: 2000, blobId: "blob-b2" }));
    expect(next).toHaveLength(3);
    expect(next.map((e) => e.id)).toEqual(["a", "b", "c"]); // order intact, in place
    expect(next.filter((e) => e.id === "b")).toHaveLength(1); // no duplicate
    expect(next[1]).toMatchObject({ id: "b", title: "Renamed", savedAt: 2000, blobId: "blob-b2" });
  });

  it("does not mutate the input array", () => {
    const list = [entry("a")];
    upsertEntry(list, entry("b"));
    expect(list.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("removeEntry (pure)", () => {
  it("drops the matching id", () => {
    const list = [entry("a"), entry("b"), entry("c")];
    expect(removeEntry(list, "b").map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("is a no-op for an unknown id", () => {
    const list = [entry("a"), entry("b")];
    expect(removeEntry(list, "zzz").map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const list = [entry("a"), entry("b")];
    removeEntry(list, "a");
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("listDrafts / deleteDraft round-trip (jsdom localStorage)", () => {
  const ADDR = "0x" + "a".repeat(64);
  const KEY = `hostit:drafts:${ADDR}`;

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lists [] for an address with no stored index", () => {
    expect(listDrafts(ADDR)).toEqual([]);
  });

  it("reads the index that was set under hostit:drafts:${addr}", () => {
    const stored = [entry("a"), entry("b")];
    window.localStorage.setItem(KEY, JSON.stringify(stored));
    expect(listDrafts(ADDR).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("deleteDraft removes one entry and leaves the rest", () => {
    window.localStorage.setItem(KEY, JSON.stringify([entry("a"), entry("b")]));
    deleteDraft(ADDR, "a");
    expect(listDrafts(ADDR).map((e) => e.id)).toEqual(["b"]);
  });

  it("deleting the last entry leaves an empty list", () => {
    window.localStorage.setItem(KEY, JSON.stringify([entry("only")]));
    deleteDraft(ADDR, "only");
    expect(listDrafts(ADDR)).toEqual([]);
  });

  it("returns [] (never throws) when the stored value is corrupt JSON", () => {
    window.localStorage.setItem(KEY, "{not-json");
    expect(listDrafts(ADDR)).toEqual([]);
  });

  it("isolates indexes by address", () => {
    const OTHER = "0x" + "b".repeat(64);
    window.localStorage.setItem(KEY, JSON.stringify([entry("a")]));
    expect(listDrafts(OTHER)).toEqual([]);
  });
});

describe("saveDraft / loadDraft round-trip (mocked Seal + Walrus)", () => {
  const ADDR = "0x" + "c".repeat(64);
  const KEY = `hostit:drafts:${ADDR}`;
  const draft = {
    v: 1 as const,
    mode: "advanced" as const,
    title: "My event",
    savedAt: 42,
    form: {
      name: "n", category: "c", start: "s", end: "e", basePrice: "",
      coinType: "0x2::sui::SUI", maxTickets: "100", maxPerUser: "1", isFree: false,
    },
  };

  beforeEach(() => {
    window.localStorage.clear();
    mem.blobs.clear();
    mem.n = 0;
  });

  it("round-trips a draft through encrypt → Walrus → decrypt", async () => {
    const e = await saveDraft({}, ADDR, draft);
    expect(listDrafts(ADDR).map((x) => x.id)).toEqual([e.id]);
    const loaded = await loadDraft({}, ADDR, e.id, {} as never);
    expect(loaded).toEqual(draft);
  });

  it("re-saving with the same id REPLACES (no duplicate row)", async () => {
    const e = await saveDraft({}, ADDR, draft);
    await saveDraft({}, ADDR, { ...draft, title: "Renamed" }, e.id);
    const list = listDrafts(ADDR);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: e.id, title: "Renamed" });
  });

  it("throws a clear 'unavailable' error when the blob is gone/corrupt", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "x", blobId: "bad", title: "t", mode: "quick", savedAt: 1 }]),
    );
    mem.blobs.set("bad", new TextEncoder().encode("{not-json"));
    await expect(loadDraft({}, ADDR, "x", {} as never)).rejects.toThrow(/unavailable/i);
  });
});
