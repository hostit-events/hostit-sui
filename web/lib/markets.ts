"use client";

// Discovery hook for the prediction markets attached to a single event —
// mirrors lib/events.ts (queryEvents-driven, no fragile object scans).
//
// Both market kinds emit a "*MarketCreated" log carrying the event_seq they were
// opened against. We FULLY enumerate each kind's creation log (cursor-followed,
// via useAllEvents) and pick the FIRST match per event_seq (UI-level dedup — Move
// is permissionless so anyone can open many markets for one event; v1 surfaces
// just one of each kind). Enumerating past the first page means a market opened
// on an OLDER event is still found (GH#32). The sellout constants are pinned at
// the single PACKAGE_ID (fresh-publish model) — both resolved in config.ts.
//
// These hooks don't surface useAllEvents' `truncated` flag: a market beyond the
// ~1000-log page bound being missed is theoretical at v1 testnet volume (and is
// strictly better than the old single capped page). The v2 indexer is the fix if
// market volume ever outgrows full enumeration.

import { useMemo } from "react";
import { useAllEvents } from "./events";
import { EV_MARKET_CREATED, EV_RANGE_MARKET_CREATED } from "./config";

interface MarketCreatedJson {
  market_id: string;
  event_seq: string | number;
}

export interface EventMarkets {
  selloutMarketId: string | null;
  rangeMarketId: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Find the sellout + range market ids opened for `eventSeq`. Returns the first
 * match of each kind (UI-level dedup). `loading` is true until both creation-log
 * queries resolve; `refetch` re-runs both.
 */
export function useEventMarkets(eventSeq: string): EventMarkets {
  const sellout = useAllEvents(EV_MARKET_CREATED);
  const range = useAllEvents(EV_RANGE_MARKET_CREATED);

  const selloutMarketId = useMemo(() => {
    for (const ev of sellout.data?.data ?? []) {
      const p = ev.parsedJson as MarketCreatedJson;
      if (String(p.event_seq) === eventSeq) return p.market_id;
    }
    return null;
  }, [sellout.data, eventSeq]);

  const rangeMarketId = useMemo(() => {
    for (const ev of range.data?.data ?? []) {
      const p = ev.parsedJson as MarketCreatedJson;
      if (String(p.event_seq) === eventSeq) return p.market_id;
    }
    return null;
  }, [range.data, eventSeq]);

  return {
    selloutMarketId,
    rangeMarketId,
    loading: sellout.isLoading || range.isLoading,
    refetch: () => {
      void sellout.refetch();
      void range.refetch();
    },
  };
}

/**
 * Discover which event_seqs have ANY prediction market (sellout or range) so the
 * Discover grid can flag them with a badge. Two creation-log queries total
 * (one per kind) — NOT one per card — mirroring useEventList's queryEvents
 * approach. Returns a Set of event_seq strings; `has(seq)` tells a card whether
 * to show its Market badge.
 */
export function useEventsWithMarkets(): { hasMarketSeqs: Set<string>; loading: boolean } {
  const sellout = useAllEvents(EV_MARKET_CREATED);
  const range = useAllEvents(EV_RANGE_MARKET_CREATED);

  const hasMarketSeqs = useMemo(() => {
    const s = new Set<string>();
    for (const ev of sellout.data?.data ?? []) {
      s.add(String((ev.parsedJson as MarketCreatedJson).event_seq));
    }
    for (const ev of range.data?.data ?? []) {
      s.add(String((ev.parsedJson as MarketCreatedJson).event_seq));
    }
    return s;
  }, [sellout.data, range.data]);

  return { hasMarketSeqs, loading: sellout.isLoading || range.isLoading };
}
