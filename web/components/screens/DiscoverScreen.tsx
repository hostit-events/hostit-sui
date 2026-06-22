"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useCurrentAccount } from "@/lib/hooks";
import { useEventList, useEventObjects, useActivityFeed, buildDiscoverEvents } from "@/lib/events";
import { useEventsWithMarkets } from "@/lib/markets";
import { useSuiNSNames } from "@/lib/verification";
import { CATEGORIES } from "@/lib/data";
import { EventCard } from "@/components/EventCard";
import { Icon } from "@/components/Icon";
import { ActivityTicker } from "@/components/discovery/ActivityTicker";
import { TrendingRow } from "@/components/discovery/TrendingRow";
import { FeaturedCarousel } from "@/components/discovery/FeaturedCarousel";
import { RecentlyViewedRow } from "@/components/discovery/RecentlyViewedRow";
import { RecommendedRow } from "@/components/discovery/RecommendedRow";
import { openCommandPalette } from "@/components/discovery/DiscoveryCommand";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

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

  const { mints } = useActivityFeed();

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

      <ActivityTicker mints={mints} />

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
        className="flex-wrap pb-1"
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
        <Card role="status" aria-live="polite">
          <CardContent className="mono">Loading events…</CardContent>
        </Card>
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
