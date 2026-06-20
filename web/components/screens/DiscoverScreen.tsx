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
import { CalendarViewDialog } from "@/components/discovery/CalendarViewDialog";
import { openCommandPalette } from "@/components/discovery/DiscoveryCommand";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [calendarOpen, setCalendarOpen] = useState(false);
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

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return events.filter((e) => {
      const meta = eventMeta[e.eventId];
      const organizerName = names.get(e.organizer) ?? "";
      const searchable = [
        e.name,
        e.organizer,
        organizerName,
        meta?.category,
        meta?.city,
        meta?.venue,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      if (ql && !searchable.includes(ql)) return false;
      if (cat !== "all" && meta?.category && meta.category !== cat) return false;
      return true;
    });
  }, [events, q, cat, eventMeta, names]);

  // Flattened, on-chain-derived events for the curated discovery rows + calendar.
  // Reuses the data already fetched here (list + objects + prices + lazy meta) —
  // no widget re-queries.
  const discoverEvents = useMemo(
    () => buildDiscoverEvents(events, eventObjects, pricesBySeq, eventMeta),
    [events, eventObjects, pricesBySeq, eventMeta],
  );

  // Curated rows only show in the default browse view (no active search/filter),
  // above the grid. Searching/filtering collapses straight to the grid.
  const browsing = q.trim() === "" && cat === "all";
  const showRows = browsing && !isLoading && !isError && events.length > 0;

  return (
    <div className="space-y-8 screen-in">
      <header className="relative">
        <div className="glow" style={{ width: 380, height: 380, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }} />
        <h1 className="page-title" style={{ fontSize: 34 }}>Find your next experience</h1>
        <p className="page-sub">Events, tickets and proof-of-attendance — live on Sui.</p>
      </header>

      <ActivityTicker mints={mints} />

      <div className="flex gap-2 flex-wrap items-center">
        <div className="grow" style={{ position: "relative", minWidth: 240 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)", zIndex: 1 }}>
            <Icon icon="ic:round-search" size={18} />
          </span>
          <Input
            id="discover-search"
            name="discover-search"
            aria-label="Search events"
            placeholder="Search events, cities, organizers…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => setCalendarOpen(true)}>
          <Icon icon="proicons:calendar" size={16} /> Calendar
        </Button>
        {/* Mobile palette affordance (Header Cmd+K button is desktop-only). */}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Open command palette"
          className="md:hidden"
          onClick={openCommandPalette}
        >
          <Icon icon="ic:round-bolt" size={16} />
        </Button>
      </div>

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
              Try a different search, or{" "}
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
              Search covers the {events.length} most recent events — older ones aren&apos;t loaded yet.
            </p>
          )}
        </>
      )}

      <CalendarViewDialog open={calendarOpen} onOpenChange={setCalendarOpen} events={discoverEvents} />
    </div>
  );
}
