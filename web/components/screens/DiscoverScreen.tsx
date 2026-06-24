"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useCurrentAccount } from "@/lib/hooks";
import { useEventList, useEventObjects, useActivityFeed, buildDiscoverEvents } from "@/lib/events";
import { useEventsWithMarkets } from "@/lib/markets";
import { useSuiNSNames } from "@/lib/verification";
import { CATEGORIES } from "@/lib/data";
import { EventCard, EventCardSkeleton } from "@/components/EventCard";
import { Icon } from "@/components/Icon";
import { ActivityTicker } from "@/components/discovery/ActivityTicker";
import { TrendingRow } from "@/components/discovery/TrendingRow";
import { FeaturedCarousel } from "@/components/discovery/FeaturedCarousel";
import { RecentlyViewedRow } from "@/components/discovery/RecentlyViewedRow";
import { RecommendedRow } from "@/components/discovery/RecommendedRow";
import { openCommandPalette } from "@/components/discovery/DiscoveryCommand";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * Height-matched placeholder for the curated discovery rows (FeaturedCarousel +
 * two horizontal rows), shown during the initial load so the grid below doesn't
 * jump down when the real rows appear. Approximate by design — the exact rows
 * are data-dependent — but close enough to keep the swap near-in-place.
 */
function DiscoverRowsSkeleton() {
  const RowHeader = () => (
    <div className="flex items-center gap-2">
      <Skeleton className="h-7 w-7 rounded-lg" />
      <div className="space-y-1.5">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-3 w-52" />
      </div>
    </div>
  );
  return (
    <div className="space-y-10" aria-hidden>
      <div className="space-y-3">
        <RowHeader />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[226px] w-[300px] shrink-0 rounded-2xl" />
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <RowHeader />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[180px] w-[230px] shrink-0 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function DiscoverScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const { events, pricesBySeq, isLoading, isError, truncated, refetch } = useEventList();
  // Single pair of queryEvents (both market kinds) -> Set of event_seq with a
  // market, so cards can flag it without an N+1 per-card query.
  const { hasMarketSeqs } = useEventsWithMarkets();
  const { byId: eventObjects, refetch: refetchObjects } = useEventObjects(
    useMemo(() => events.map((e) => e.eventId), [events]),
  );
  const organizers = useMemo(() => Array.from(new Set(events.map((e) => e.organizer))), [events]);
  const names = useSuiNSNames(organizers);

  const { mints, isLoading: activityLoading } = useActivityFeed();

  const [cat, setCat] = useState("all");
  // event_id -> searchable metadata (from Walrus metadata, fetched lazily by cards)
  const [eventMeta, setEventMeta] = useState<
    Record<string, { category?: string; city?: string; venue?: string }>
  >({});

  const onMetadata = useCallback(
    (eventId: string, meta: { category?: string; city?: string; venue?: string }) => {
      setEventMeta((prev) => {
        const current = prev[eventId];
        if (
          current?.category === meta.category &&
          current?.city === meta.city &&
          current?.venue === meta.venue
        ) {
          return prev;
        }
        return { ...prev, [eventId]: meta };
      });
    },
    [],
  );

  // Text search lives in the Cmd+K palette now; the page filters by category.
  // Events with no category metadata yet are kept under any active category.
  const filtered = useMemo(() => {
    if (cat === "all") return events;
    return events.filter((e) => {
      const meta = eventMeta[e.eventId];
      return !meta?.category || meta.category === cat;
    });
  }, [events, cat, eventMeta]);

  // Flattened, on-chain-derived events for the curated discovery rows + calendar.
  // Reuses the data already fetched here (list + objects + prices + lazy meta) —
  // no widget re-queries.
  const discoverEvents = useMemo(
    () => buildDiscoverEvents(events, eventObjects, pricesBySeq, eventMeta),
    [events, eventObjects, pricesBySeq, eventMeta],
  );

  // Curated rows only show in the default browse view (no active category
  // filter), above the grid. Filtering by category collapses straight to the grid.
  const browsing = cat === "all";
  const showRows = browsing && !isLoading && !isError && events.length > 0;

  return (
    <div className="space-y-8 screen-in">
      <header className="relative">
        <div className="glow" style={{ width: 380, height: 380, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }} />
        <h1 className="page-title" style={{ fontSize: 34 }}>Find your next experience</h1>
        <p className="page-sub">Events, tickets and proof-of-attendance — live on Sui.</p>
      </header>

      <ActivityTicker mints={mints} loading={activityLoading} />

      {/* Mobile search + commands — the header search/calendar is desktop-only
          (md+). Opens the Cmd+K palette, which also has the calendar action. */}
      <button
        type="button"
        onClick={openCommandPalette}
        aria-label="Search events and commands"
        className="md:hidden flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
      >
        <Icon icon="ic:round-search" size={16} />
        <span>Search events…</span>
      </button>

      <ToggleGroup
        type="single"
        value={cat}
        onValueChange={(v) => v && setCat(v)}
        variant="outline"
        className="flex-wrap pb-1 [&_button]:min-h-11 sm:[&_button]:min-h-0"
        aria-label="Categories"
      >
        {CATEGORIES.map((c) => (
          <ToggleGroupItem key={c.id} value={c.id} aria-label={c.label}>
            <Icon icon={c.icon} size={14} /> {c.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {showRows && (
        <div className="space-y-10">
          <FeaturedCarousel events={discoverEvents} />
          <TrendingRow events={discoverEvents} />
          <RecommendedRow events={discoverEvents} address={addr} />
          <RecentlyViewedRow events={discoverEvents} />
        </div>
      )}

      {isLoading ? (
        // Mirror the loaded layout (curated rows + grid) while events load, so
        // the content swaps in place instead of the grid jumping down ~800px
        // when the rows appear and the footer dropping ~2500px. (#CLS)
        <div className="space-y-8" role="status" aria-label="Loading events">
          {browsing && <DiscoverRowsSkeleton />}
          <div className="ev-grid">
            {Array.from({ length: 9 }).map((_, i) => (
              <EventCardSkeleton key={i} />
            ))}
          </div>
        </div>
      ) : isError ? (
        <Card role="status" aria-live="polite">
          <CardContent className="flex flex-wrap items-center gap-2">
            <span className="text-destructive">Couldn&apos;t load events.</span>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card role="status" aria-live="polite">
          <CardContent>
            <div className="font-semibold">No events found.</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              Try a different category, or{" "}
              <Link href="/create" style={{ color: "var(--hi-blue)" }}>host your own</Link>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="ev-grid">
            {filtered.map((e) => (
              <EventCard
                key={e.eventId}
                eventId={e.eventId}
                organizer={e.organizer}
                buyerAddress={addr}
                isFree={e.isFree}
                prices={pricesBySeq.get(e.eventSeq) ?? []}
                verified={Boolean(names.get(e.organizer))}
                hasMarket={hasMarketSeqs.has(e.eventSeq)}
                onMetadata={onMetadata}
                object={eventObjects.get(e.eventId) ?? null}
                onRefetch={refetchObjects}
              />
            ))}
          </div>
          {truncated && (
            <p className="mono text-sm" style={{ color: "var(--fg3)", textAlign: "center" }}>
              Showing the {events.length} most recent events — older ones aren&apos;t loaded yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}
