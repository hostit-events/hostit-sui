"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useCurrentAccount } from "@/lib/hooks";
import { useEventList } from "@/lib/events";
import { useEventsWithMarkets } from "@/lib/markets";
import { useSuiNSNames } from "@/lib/verification";
import { getEventMetadata } from "@/lib/metadata";
import { CATEGORIES } from "@/lib/data";
import { EventCard } from "@/components/EventCard";
import { Icon } from "@/components/Icon";

export function DiscoverScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const { events, pricesBySeq, isLoading, isError, refetch } = useEventList();
  // Single pair of queryEvents (both market kinds) -> Set of event_seq with a
  // market, so cards can flag it without an N+1 per-card query.
  const { hasMarketSeqs } = useEventsWithMarkets();
  const organizers = useMemo(() => Array.from(new Set(events.map((e) => e.organizer))), [events]);
  const names = useSuiNSNames(organizers);

  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  // event_id -> category (from Walrus metadata, fetched lazily, cached)
  const [cats, setCats] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const uris = await Promise.all(
        events.map(async (e) => {
          // we only have the on-chain uri via getObject elsewhere; metadata cache
          // keyed by uri. Here we resolve category best-effort via the event uri.
          return null;
        }),
      );
      void uris;
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [events]);

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return events.filter((e) => {
      if (ql && !e.name.toLowerCase().includes(ql)) return false;
      if (cat !== "all" && cats[e.eventId] && cats[e.eventId] !== cat) return false;
      return true;
    });
  }, [events, q, cat, cats]);

  return (
    <div className="space-y-8 screen-in">
      <header className="relative">
        <div className="glow" style={{ width: 380, height: 380, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }} />
        <h1 className="page-title" style={{ fontSize: 34 }}>Find your next experience</h1>
        <p className="page-sub">Events, tickets and proof-of-attendance — live on Sui.</p>
      </header>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="grow" style={{ position: "relative", minWidth: 240 }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)" }}>
            <Icon icon="ic:round-search" size={18} />
          </span>
          <input
            id="discover-search"
            name="discover-search"
            aria-label="Search events"
            className="input"
            placeholder="Search events, cities, organizers…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ paddingLeft: 42 }}
          />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap pb-1" role="group" aria-label="Categories">
        {CATEGORIES.map((c) => (
          <button key={c.id} className={`chip ${cat === c.id ? "on" : ""}`} aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
            <Icon icon={c.icon} size={14} /> {c.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="card mono" role="status" aria-live="polite">Loading events…</div>
      ) : isError ? (
        <div className="card" style={{ color: "var(--color-danger)" }} role="status" aria-live="polite">
          Couldn&apos;t load events. <button className="btn btn-sm" onClick={() => refetch()}>Retry</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card" role="status" aria-live="polite">
          <div className="font-semibold">No events found.</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            Try a different search, or{" "}
            <Link href="/create" style={{ color: "var(--hi-blue)" }}>host your own</Link>.
          </p>
        </div>
      ) : (
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
              onCategory={(c) => setCats((prev) => (prev[e.eventId] === c ? prev : { ...prev, [e.eventId]: c }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
