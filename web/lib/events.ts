"use client";

import { useMemo } from "react";
import { useSuiQuery } from "./hooks";
import { COINS, matchesCoinType, EV_EVENT_CREATED, EV_PRICE_SET } from "./config";
import type { PaginatedEvents, QueryEventsParams } from "@mysten/sui/jsonRpc";

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
 * Discovers events from `EventCreated` logs and joins their prices from
 * `PriceSet` logs by `event_seq`. The on-chain `Event` object holds live
 * counters/flags (read per-card via getObject); prices live in dynamic fields,
 * so we surface them from the emitted events instead of fragile df reads.
 */
export function useEventList() {
  const created = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_EVENT_CREATED }, order: "descending", limit: 50 },
    { staleTime: 30_000 },
  );
  const priceSet = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_PRICE_SET }, order: "descending", limit: 100 },
    { staleTime: 30_000 },
  );

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

  // event_seq -> latest price per coin type. Logs are newest-first; first seen wins.
  const pricesBySeq = useMemo(() => {
    const m = new Map<string, PriceOption[]>();
    if (!priceSet.data) return m;
    for (const ev of priceSet.data.data) {
      const p = ev.parsedJson as PriceSetJson;
      const seq = String(p.event_seq);
      const full =
        COINS.find((c) => matchesCoinType(p.coin_type, c.type))?.type ?? `0x${p.coin_type}`;
      const arr = m.get(seq) ?? [];
      if (!arr.some((x) => x.coinType === full)) arr.push({ coinType: full, price: String(p.price) });
      m.set(seq, arr);
    }
    return m;
  }, [priceSet.data]);

  const refetch = () => {
    void created.refetch();
    void priceSet.refetch();
  };

  return {
    events,
    pricesBySeq,
    isLoading: created.isLoading,
    isError: created.isError || priceSet.isError,
    refetch,
  };
}
