"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentClient } from "./hooks";
import { collectPages, chunk } from "./pagination";
import { COINS, matchesCoinType, EV_EVENT_CREATED, EV_PRICE_SET } from "./config";
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
  return { byId, refetch: q.refetch };
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
