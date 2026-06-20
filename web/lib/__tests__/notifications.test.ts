import { describe, expect, it } from "vitest";
import type { SuiEvent } from "@mysten/sui/jsonRpc";
import { buildNotifications, type DerivedInputs, type OwnedRef } from "../notifications";

// Chain-free tests for the pure inbox derivation: real-timestamp joins, the
// owned-object → item mapping, organizer "sold a ticket" items, dedupe, dismiss,
// read-marking, and the newest-first cap. No wallet/network/RPC involved.

const ME = "0xme";
const OTHER = "0xbuyer";

function ev(type: string, json: Record<string, unknown>, timestampMs: number): SuiEvent {
  return {
    id: { txDigest: "d", eventSeq: "0" },
    packageId: "0xpkg",
    transactionModule: "m",
    sender: ME,
    type,
    parsedJson: json,
    bcs: "",
    timestampMs: String(timestampMs),
  } as unknown as SuiEvent;
}

function ticket(objectId: string, eventId: string, name: string): OwnedRef {
  return { objectId, eventId, name };
}

function base(overrides: Partial<DerivedInputs> = {}): DerivedInputs {
  return {
    address: ME,
    ownedTickets: [],
    ownedPoaps: [],
    createdEvents: [],
    mintedTickets: [],
    claimedPoaps: [],
    dismissed: new Set(),
    read: new Set(),
    ...overrides,
  };
}

describe("buildNotifications", () => {
  it("returns an empty feed when there is nothing on-chain", () => {
    expect(buildNotifications(base())).toEqual([]);
  });

  it("derives a purchase item from an owned ticket and joins its real mint timestamp", () => {
    const out = buildNotifications(
      base({
        ownedTickets: [ticket("0xt1", "0xevA", "Web3Lagos")],
        mintedTickets: [
          ev("mint", { event_id: "0xevA", ticket_id: "0xt1", recipient: ME, serial: 7 }, 1700),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "purch_0xt1",
      type: "purchase",
      timestamp: 1700,
      read: false,
    });
    expect(out[0].description).toContain("Web3Lagos");
  });

  it("never fabricates a timestamp — unjoined items get ts 0, not a random value", () => {
    const out = buildNotifications(
      base({ ownedTickets: [ticket("0xt1", "0xevA", "X")] }),
    );
    expect(out[0].timestamp).toBe(0);
  });

  it("derives a publish item only for events I organize", () => {
    const out = buildNotifications(
      base({
        createdEvents: [
          ev("created", { event_id: "0xevA", organizer: ME, name: "Mine" }, 500),
          ev("created", { event_id: "0xevB", organizer: OTHER, name: "Theirs" }, 600),
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "pub_0xevA", type: "publish", timestamp: 500 });
  });

  it("derives a 'your event sold a ticket' item when someone else buys on my event", () => {
    const out = buildNotifications(
      base({
        createdEvents: [ev("created", { event_id: "0xevA", organizer: ME, name: "Mine" }, 100)],
        mintedTickets: [
          ev("mint", { event_id: "0xevA", ticket_id: "0xt9", recipient: OTHER, serial: 3 }, 900),
        ],
      }),
    );
    const sale = out.find((n) => n.id === "sale_0xt9");
    expect(sale).toMatchObject({ type: "purchase", timestamp: 900 });
    expect(sale?.description).toContain("#3");
  });

  it("does not emit a sale item for a ticket I minted to myself on my own event", () => {
    const out = buildNotifications(
      base({
        createdEvents: [ev("created", { event_id: "0xevA", organizer: ME, name: "Mine" }, 100)],
        mintedTickets: [
          ev("mint", { event_id: "0xevA", ticket_id: "0xt9", recipient: ME, serial: 3 }, 900),
        ],
      }),
    );
    expect(out.find((n) => n.id.startsWith("sale_"))).toBeUndefined();
  });

  it("derives a reminder item from an owned POAP with its claim timestamp", () => {
    const out = buildNotifications(
      base({
        ownedPoaps: [ticket("0xp1", "0xevA", "DevConf")],
        claimedPoaps: [ev("claim", { event_id: "0xevA", recipient: ME }, 1234)],
      }),
    );
    expect(out[0]).toMatchObject({ id: "poap_0xp1", type: "reminder", timestamp: 1234 });
  });

  it("filters dismissed ids and marks read ids", () => {
    const out = buildNotifications(
      base({
        ownedTickets: [ticket("0xt1", "0xevA", "A"), ticket("0xt2", "0xevB", "B")],
        dismissed: new Set(["purch_0xt1"]),
        read: new Set(["purch_0xt2"]),
      }),
    );
    expect(out.map((n) => n.id)).toEqual(["purch_0xt2"]);
    expect(out[0].read).toBe(true);
  });

  it("sorts newest-first and caps at 8 items", () => {
    const tickets = Array.from({ length: 12 }, (_, i) => ticket(`0xt${i}`, "0xev", `E${i}`));
    const mints = tickets.map((t, i) =>
      ev("mint", { event_id: "0xev", ticket_id: t.objectId, recipient: ME, serial: i }, i * 100),
    );
    const out = buildNotifications(base({ ownedTickets: tickets, mintedTickets: mints }));
    expect(out).toHaveLength(8);
    // Descending by timestamp: the highest-ts ticket (#11 → 1100) comes first.
    expect(out[0].id).toBe("purch_0xt11");
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].timestamp).toBeGreaterThanOrEqual(out[i].timestamp);
    }
  });

  it("dedupes by id when the same source appears twice", () => {
    const out = buildNotifications(
      base({ ownedTickets: [ticket("0xt1", "0xevA", "A"), ticket("0xt1", "0xevA", "A")] }),
    );
    expect(out.filter((n) => n.id === "purch_0xt1")).toHaveLength(1);
  });
});
