"use client";

// Discovery-richness layer (GH#56): client-side helpers + localStorage hooks for
// the curated rows above the /discover grid (trending, featured, recently-viewed,
// recommended) and the Cmd+K palette. Everything here is derived from PUBLIC
// on-chain state (passed in as `DiscoverEvent[]`) or device-local localStorage —
// NO mock generators, NO backend, NO role gating (permissionless model holds:
// these are derived rankings, not editorial gates).

import { useCallback, useEffect, useState } from "react";

/**
 * The flattened view of one event that every discovery widget consumes. It joins
 * the `EventInfo` log fields with the on-chain `Event` object counters + the lazy
 * Walrus metadata that `DiscoverScreen` already fetches — so a widget never
 * re-queries. All *_ms are milliseconds (match Move; pass straight to `new Date`).
 */
export interface DiscoverEvent {
  eventId: string;
  eventSeq: string;
  organizer: string;
  name: string;
  isFree: boolean;
  /** Live counters from the on-chain Event object (0n until the object resolves). */
  minted: bigint;
  maxTickets: bigint;
  startMs: number;
  endMs: number;
  /** Lazy Walrus metadata (undefined until a card surfaces it via onMetadata). */
  category?: string;
  city?: string;
  venue?: string;
  /** Cheapest listed price (smallest unit) + its coin type, if any (for palette/labels). */
  priceUnits?: bigint;
  coinType?: string;
}

/** Fill ratio in [0, 1]. 0 when capacity is unknown/zero (avoids div-by-zero). */
export function fillRatio(e: Pick<DiscoverEvent, "minted" | "maxTickets">): number {
  if (e.maxTickets <= 0n) return 0;
  const r = Number(e.minted) / Number(e.maxTickets);
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

/** Whole-percent fill (0..100) for the visual fill bar. */
export function fillPercent(e: Pick<DiscoverEvent, "minted" | "maxTickets">): number {
  return Math.round(fillRatio(e) * 100);
}

/** Tickets remaining (never negative). */
export function ticketsLeft(e: Pick<DiscoverEvent, "minted" | "maxTickets">): bigint {
  const left = e.maxTickets - e.minted;
  return left < 0n ? 0n : left;
}

export function soldOut(e: Pick<DiscoverEvent, "minted" | "maxTickets">): boolean {
  return e.maxTickets > 0n && e.minted >= e.maxTickets;
}

export type EventStatus = "live" | "today" | "upcoming" | "past" | "sold-out";

export function getEventStatus(
  e: Pick<DiscoverEvent, "minted" | "maxTickets" | "startMs" | "endMs">,
  now = Date.now(),
): EventStatus {
  if (now < e.startMs) {
    if (soldOut(e)) return "sold-out";
    if (new Date(e.startMs).toDateString() === new Date(now).toDateString()) return "today";
    return "upcoming";
  }
  if (now >= e.startMs && now <= e.endMs) return "live";
  return "past";
}

/** "in 3d 4h" / "Started" style compact countdown to an absolute ms timestamp. */
export function formatCountdownCompact(startMs: number, now = Date.now()): string {
  const total = startMs - now;
  if (total <= 0) return "Started";
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor((total % 86_400_000) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes}m`;
  if (minutes > 0) return `in ${minutes}m`;
  return "Starting now";
}

/** Short "Jun 3 – Jun 5" range label from two absolute ms timestamps. */
export function formatDateRangeMs(startMs: number, endMs: number): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const a = new Date(startMs).toLocaleDateString(undefined, opts);
  const b = new Date(endMs).toLocaleDateString(undefined, opts);
  return a === b ? a : `${a} – ${b}`;
}

/** "7:30 PM" start-time label from an absolute ms timestamp. */
export function formatTimeMs(startMs: number): string {
  return new Date(startMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// ---------- Trending / Featured scoring (real on-chain state only) ----------

/**
 * Trending score: dominated by fill rate, with a proximity bonus for events that
 * are soon-but-not-past. NO daily-random term and NO badge inputs (the prototype's
 * cosmetic variance is dropped — there is no on-chain badge field). Pure +
 * deterministic given (event, now).
 */
export function trendingScore(e: DiscoverEvent, now = Date.now()): number {
  let score = fillRatio(e) * 1000;
  const untilStart = e.startMs - now;
  if (untilStart > 0) {
    // Soonest upcoming gets the biggest bonus, decaying over ~30 days.
    const days = untilStart / 86_400_000;
    score += Math.max(0, 200 - days * 6);
  } else if (now <= e.endMs) {
    // Currently live — keep it near the top.
    score += 150;
  }
  return score;
}

/** Top-N trending events (excludes already-ended). */
export function topTrending(events: DiscoverEvent[], n = 6, now = Date.now()): DiscoverEvent[] {
  return [...events]
    .filter((e) => e.endMs === 0 || e.endMs >= now)
    .map((e) => ({ e, s: trendingScore(e, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.e);
}

/**
 * "Featured" rule (deterministic, no curation backend): upcoming events ranked by
 * fill rate, then proximity. Concretely we reuse the trending ranking but keep
 * only events whose sale window hasn't ended, and render them in a wider carousel.
 * Documented single rule per the issue.
 */
export function featuredEvents(events: DiscoverEvent[], n = 8, now = Date.now()): DiscoverEvent[] {
  return [...events]
    .filter((e) => (e.endMs === 0 || e.endMs >= now) && !soldOut(e))
    .map((e) => ({ e, s: trendingScore(e, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.e);
}

/**
 * Recommendation score by similarity to a "profile" (events the user favorited or
 * purchased): category / city / organizer overlap. NO daily-random term. Returns
 * -1 for already-seen events so the caller can filter them out.
 */
export function recommendationScore(
  e: DiscoverEvent,
  profile: DiscoverEvent[],
  seenIds: Set<string>,
): number {
  if (seenIds.has(e.eventId)) return -1;
  let score = 0;
  for (const p of profile) {
    if (e.category && p.category && e.category === p.category) score += 4;
    if (e.city && p.city && e.city === p.city) score += 3;
    if (e.organizer === p.organizer) score += 2;
  }
  return score;
}

export function recommendedEvents(
  all: DiscoverEvent[],
  favorites: Set<string>,
  purchasedEventIds: Set<string>,
  recentlyViewedIds: string[],
  n = 4,
): DiscoverEvent[] {
  const profile = all.filter((e) => favorites.has(e.eventId) || purchasedEventIds.has(e.eventId));
  if (profile.length === 0) return [];
  const seen = new Set<string>([...favorites, ...purchasedEventIds, ...recentlyViewedIds]);
  return all
    .map((e) => ({ e, s: recommendationScore(e, profile, seen) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.e);
}

// ---------- Recently viewed (localStorage) ----------

export const RECENTLY_VIEWED_KEY = "hostit:recently-viewed";
const FAVORITES_KEY = "hostit:favorites";

/** Pure list transform: prepend `id`, dedupe, cap at `max`. */
export function pushRecentlyViewed(ids: string[], id: string, max = 8): string[] {
  return [id, ...ids.filter((x) => x !== id)].slice(0, max);
}

function readIds(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Append `eventId` to the device-local recently-viewed list (call on event page mount). */
export function recordRecentlyViewed(eventId: string): void {
  if (typeof window === "undefined" || !eventId) return;
  try {
    const next = pushRecentlyViewed(readIds(RECENTLY_VIEWED_KEY), eventId);
    window.localStorage.setItem(RECENTLY_VIEWED_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("hostit:recently-viewed-change"));
  } catch {
    /* localStorage unavailable (private mode / quota) — silently no-op */
  }
}

/** Read the recently-viewed id list, reactive to changes from `recordRecentlyViewed`. */
export function useRecentlyViewed(): { ids: string[]; clear: () => void } {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setIds(readIds(RECENTLY_VIEWED_KEY));
    sync();
    window.addEventListener("hostit:recently-viewed-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("hostit:recently-viewed-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(RECENTLY_VIEWED_KEY);
      window.dispatchEvent(new Event("hostit:recently-viewed-change"));
    } catch {
      /* no-op */
    }
  }, []);
  return { ids, clear };
}

// ---------- Favorites (localStorage, no on-chain write) ----------

export function useFavorites(): {
  favorites: Set<string>;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setIds(readIds(FAVORITES_KEY));
    sync();
    window.addEventListener("hostit:favorites-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("hostit:favorites-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const toggle = useCallback((id: string) => {
    try {
      const cur = readIds(FAVORITES_KEY);
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur];
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      window.dispatchEvent(new Event("hostit:favorites-change"));
    } catch {
      /* no-op */
    }
  }, []);

  const favorites = new Set(ids);
  return { favorites, isFavorite: (id) => favorites.has(id), toggle };
}
