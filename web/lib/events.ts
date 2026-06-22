"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentClient } from "./hooks";
import { collectPages, chunk } from "./pagination";
import {
  COINS,
  matchesCoinType,
  coinInfo,
  fmtAmount,
  EV_EVENT_CREATED,
  EV_PRICE_SET,
  EV_TICKET_MINTED,
  EV_POAP_CLAIMED,
} from "./config";
import type { DiscoverEvent } from "./discovery";
import type {
  PaginatedEvents,
  QueryEventsParams,
  MultiGetObjectsParams,
  SuiObjectResponse,
  SuiEvent,
  EventId,
} from "@mysten/sui/jsonRpc";

export interface EventInfo {
  eventId: string;
  eventSeq: string;
  organizer: string;
  name: string;
  isFree: boolean;
  isRefundable: boolean;
}

export interface PriceOption {
  coinType: string;
  price: string; // smallest unit
}

interface EventCreatedJson {
  event_seq: string | number;
  event_id: string;
  organizer: string;
  name: string;
  is_free: boolean;
  is_refundable: boolean;
}

interface PriceSetJson {
  event_seq: string | number;
  coin_type: string;
  price: string | number;
}

/**
 * Fully enumerate ONE MoveEventType's logs (newest-first) by following the RPC
 * cursor past the ~50-per-page cap, instead of reading a single capped page.
 * One react-query keyed by the type; `data.truncated` flags the page bound.
 * Shared by useEventList / useEventPrices (here) and the market hooks.
 */
export function useAllEvents(moveEventType: string) {
  const client = useCurrentClient() as unknown as {
    queryEvents: (p: QueryEventsParams) => Promise<PaginatedEvents>;
  };
  return useQuery<{ data: SuiEvent[]; truncated: boolean }, Error>({
    queryKey: ["queryEventsAll", moveEventType],
    queryFn: () =>
      collectPages<SuiEvent, EventId>(async (cursor) => {
        const page = await client.queryEvents({
          query: { MoveEventType: moveEventType },
          order: "descending",
          limit: 50,
          cursor: cursor ?? undefined,
        });
        return { data: page.data, nextCursor: page.nextCursor ?? null, hasNextPage: page.hasNextPage };
      }),
    staleTime: 30_000,
  });
}

// event_seq -> latest price per coin type. Logs are newest-first; first seen wins.
function buildPrices(data: SuiEvent[] | undefined): Map<string, PriceOption[]> {
  const m = new Map<string, PriceOption[]>();
  if (!data) return m;
  for (const ev of data) {
    const p = ev.parsedJson as PriceSetJson;
    const seq = String(p.event_seq);
    const full =
      COINS.find((c) => matchesCoinType(p.coin_type, c.type))?.type ?? `0x${p.coin_type}`;
    const arr = m.get(seq) ?? [];
    if (!arr.some((x) => x.coinType === full)) arr.push({ coinType: full, price: String(p.price) });
    m.set(seq, arr);
  }
  return m;
}

/**
 * Discovers events from `EventCreated` logs and joins their prices from
 * `PriceSet` logs by `event_seq`. Both are fully enumerated (cursor-followed),
 * so events/prices no longer silently fall off after the newest page — the GH#32
 * fix. `truncated` is set if either source hit the page bound (more exists).
 * The on-chain `Event` object holds live counters/flags (read per-card via
 * getObject); prices live in dynamic fields, surfaced here from the logs.
 */
export function useEventList() {
  const created = useAllEvents(EV_EVENT_CREATED);
  const priceSet = useAllEvents(EV_PRICE_SET);

  const events: EventInfo[] = useMemo(() => {
    if (!created.data) return [];
    return created.data.data.map((ev) => {
      const p = ev.parsedJson as EventCreatedJson;
      return {
        eventId: p.event_id,
        eventSeq: String(p.event_seq),
        organizer: p.organizer,
        name: p.name,
        isFree: Boolean(p.is_free),
        isRefundable: Boolean(p.is_refundable),
      };
    });
  }, [created.data]);

  const pricesBySeq = useMemo(() => buildPrices(priceSet.data?.data), [priceSet.data]);

  const refetch = () => {
    void created.refetch();
    void priceSet.refetch();
  };

  return {
    events,
    pricesBySeq,
    isLoading: created.isLoading,
    isError: created.isError || priceSet.isError,
    // True ONLY if EVENT enumeration hit the page bound (older events exist but
    // aren't loaded). PriceSet truncation is deliberately NOT folded in: PriceSet
    // logs far outnumber events (one per coin + re-pricing), so OR-ing it would
    // fire the "older events" banner even when every event is loaded. A missed
    // old price just renders as "Price not set" on that card — the v2 indexer is
    // the real fix for both.
    truncated: Boolean(created.data?.truncated),
    refetch,
  };
}

/**
 * Batch-read many event objects, CHUNKED into ≤50-id multiGetObjects calls (the
 * RPC cap) so it scales past the old 50-event feed. Returns a Map keyed by
 * objectId + a refetch.
 */
export function useEventObjects(ids: string[]) {
  const sorted = useMemo(() => [...ids].sort(), [ids]);
  const client = useCurrentClient() as unknown as {
    multiGetObjects: (p: MultiGetObjectsParams) => Promise<SuiObjectResponse[]>;
  };
  const q = useQuery<SuiObjectResponse[], Error>({
    queryKey: ["multiGetObjectsChunked", sorted],
    queryFn: async () => {
      const groups = await Promise.all(
        chunk(sorted, 50).map((c) =>
          client.multiGetObjects({ ids: c, options: { showContent: true } }),
        ),
      );
      return groups.flat();
    },
    enabled: sorted.length > 0,
    staleTime: 30_000,
  });
  const byId = useMemo(() => {
    const m = new Map<string, SuiObjectResponse>();
    for (const r of q.data ?? []) {
      const id = r.data?.objectId;
      if (id) m.set(id, r);
    }
    return m;
  }, [q.data]);
  return { byId, isLoading: q.isLoading, refetch: q.refetch };
}

/**
 * Prices only (no EventCreated scan): for the single-event page, which already
 * has the Event object and just needs `pricesBySeq.get(seq)`. Fully enumerates
 * `PriceSet` so an older event's price isn't missed past the first page.
 */
export function useEventPrices() {
  const priceSet = useAllEvents(EV_PRICE_SET);
  const pricesBySeq = useMemo(() => buildPrices(priceSet.data?.data), [priceSet.data]);
  return { pricesBySeq, isLoading: priceSet.isLoading, refetch: () => void priceSet.refetch() };
}

// ---------- Discovery (GH#56) — resolved-event builder for the curated rows ----------

/**
 * Join the event list, the prefetched on-chain `Event` objects, the prices, and
 * (optionally) lazily-fetched Walrus metadata into the flat `DiscoverEvent[]` the
 * discovery widgets consume. Pure — callers pass whatever they already have so no
 * widget re-queries. `metaById` is optional (the global palette has no lazy meta).
 */
export function buildDiscoverEvents(
  events: EventInfo[],
  objectsById: Map<string, SuiObjectResponse>,
  pricesBySeq: Map<string, PriceOption[]>,
  metaById?: Record<string, { category?: string; city?: string; venue?: string }>,
): DiscoverEvent[] {
  return events.map((e) => {
    const obj = objectsById.get(e.eventId);
    const content = obj?.data?.content as { fields?: Record<string, unknown> } | undefined;
    const f = content?.fields;
    const prices = pricesBySeq.get(e.eventSeq) ?? [];
    // Cheapest listed price (smallest unit can't compare across coins precisely,
    // but for a label/palette the first listed coin is fine; prefer SUI if present).
    const cheapest = prices[0];
    const meta = metaById?.[e.eventId];
    return {
      eventId: e.eventId,
      eventSeq: e.eventSeq,
      organizer: e.organizer,
      name: e.name,
      isFree: e.isFree,
      minted: f ? BigInt((f.minted as string) ?? "0") : 0n,
      maxTickets: f ? BigInt((f.max_tickets as string) ?? "0") : 0n,
      startMs: f ? Number(f.start_ms ?? 0) : 0,
      endMs: f ? Number(f.end_ms ?? 0) : 0,
      category: meta?.category,
      city: meta?.city,
      venue: meta?.venue,
      priceUnits: cheapest ? BigInt(cheapest.price) : undefined,
      coinType: cheapest?.coinType,
    };
  });
}

/**
 * Self-contained discovery feed for the GLOBAL command palette: enumerates the
 * event list + batch-reads the Event objects on its own (no lazy Walrus meta).
 * DiscoverScreen builds its own richer `DiscoverEvent[]` (with meta) via
 * `buildDiscoverEvents` from data it already has.
 */
export function useDiscoverEvents(): { events: DiscoverEvent[]; isLoading: boolean } {
  const { events, pricesBySeq, isLoading } = useEventList();
  const ids = useMemo(() => events.map((e) => e.eventId), [events]);
  const { byId } = useEventObjects(ids);
  const resolved = useMemo(
    () => buildDiscoverEvents(events, byId, pricesBySeq),
    [events, byId, pricesBySeq],
  );
  return { events: resolved, isLoading };
}

// ---------- Activity feed (GH#56) — the "announcements" ticker ----------

/** One rendered row in the live activity ticker. */
export interface ActivityMint {
  id: string;
  emoji: string;
  walletShort: string;
  eventTitle: string;
  ago: string;
  /** Human amount label (e.g. "1.5 SUI") for paid mints; "" for free / POAP. */
  amountLabel: string;
}

interface TicketMintedJson {
  event_seq: string | number;
  event_id: string;
  buyer: string;
  recipient: string;
  coin_type: string;
  total_paid: string | number;
}
interface PoapClaimedJson {
  event_seq: string | number;
  event_id: string;
  recipient: string;
}

function shortAddr(addr: string): string {
  if (!addr) return "Someone";
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function relativeAgo(tsMs: number | null, now: number): string {
  if (!tsMs) return "just now";
  const diff = Math.max(0, now - tsMs);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Real on-chain activity feed for the ticker: enumerates `TicketMinted` (paid /
 * free ticket mints) and `PoapClaimed` (proof-of-attendance) logs, joins the
 * event title from `useEventList()` by `event_seq`, and maps each to a ticker row.
 * Bounded by the same cursor-followed page enumeration as `useEventList` (no
 * indexer — v2). Returns an empty array for a fresh package with no mints (the
 * ticker renders nothing). Ticket mints show 🎟️, POAP claims show 🏅.
 */
export function useActivityFeed(limit = 12): { mints: ActivityMint[]; isLoading: boolean } {
  const minted = useAllEvents(EV_TICKET_MINTED);
  const poap = useAllEvents(EV_POAP_CLAIMED);
  const { events } = useEventList();

  const titleBySeq = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) m.set(e.eventSeq, e.name);
    return m;
  }, [events]);

  const mints = useMemo<ActivityMint[]>(() => {
    const now = Date.now();
    interface Row {
      ev: SuiEvent;
      ts: number;
      kind: "mint" | "poap";
    }
    const rows: Row[] = [];
    for (const ev of minted.data?.data ?? [])
      rows.push({ ev, ts: ev.timestampMs ? Number(ev.timestampMs) : 0, kind: "mint" });
    for (const ev of poap.data?.data ?? [])
      rows.push({ ev, ts: ev.timestampMs ? Number(ev.timestampMs) : 0, kind: "poap" });
    rows.sort((a, b) => b.ts - a.ts);

    const out: ActivityMint[] = [];
    for (const r of rows.slice(0, limit)) {
      if (r.kind === "mint") {
        const p = r.ev.parsedJson as TicketMintedJson;
        const seq = String(p.event_seq);
        const ci = coinInfo(
          COINS.find((c) => matchesCoinType(p.coin_type, c.type))?.type ?? `0x${p.coin_type}`,
        );
        const paid = BigInt(p.total_paid ?? 0);
        out.push({
          id: r.ev.id.txDigest + r.ev.id.eventSeq,
          emoji: "🎟️",
          walletShort: shortAddr(p.recipient || p.buyer),
          eventTitle: titleBySeq.get(seq) ?? `Event #${seq}`,
          ago: relativeAgo(r.ts || null, now),
          amountLabel: paid > 0n ? `${fmtAmount(paid, ci.decimals)} ${ci.symbol}` : "",
        });
      } else {
        const p = r.ev.parsedJson as PoapClaimedJson;
        const seq = String(p.event_seq);
        out.push({
          id: r.ev.id.txDigest + r.ev.id.eventSeq,
          emoji: "🏅",
          walletShort: shortAddr(p.recipient),
          eventTitle: titleBySeq.get(seq) ?? `Event #${seq}`,
          ago: relativeAgo(r.ts || null, now),
          amountLabel: "",
        });
      }
    }
    return out;
  }, [minted.data, poap.data, titleBySeq, limit]);

  return { mints, isLoading: minted.isLoading || poap.isLoading };
}

/**
 * Purchased event set for the connected address, derived from `TicketMinted` logs
 * (buyer/recipient match). Pure on-chain read (no extra query — reuses the same
 * enumerated log). Used by the recommendation profile.
 */
export function usePurchasedEventIds(addr: string | null): Set<string> {
  const minted = useAllEvents(EV_TICKET_MINTED);
  return useMemo(() => {
    const set = new Set<string>();
    if (!addr) return set;
    const lower = addr.toLowerCase();
    for (const ev of minted.data?.data ?? []) {
      const p = ev.parsedJson as TicketMintedJson;
      if (p.recipient?.toLowerCase() === lower || p.buyer?.toLowerCase() === lower) {
        set.add(p.event_id);
      }
    }
    return set;
  }, [minted.data, addr]);
}
