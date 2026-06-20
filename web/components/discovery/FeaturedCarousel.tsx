"use client";

import { useMemo, useRef } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  featuredEvents,
  ticketsLeft,
  soldOut,
  getEventStatus,
  formatCountdownCompact,
  formatDateRangeMs,
  type DiscoverEvent,
} from "@/lib/discovery";
import { coinInfo, fmtAmount } from "@/lib/config";

function priceLabel(e: DiscoverEvent): string {
  if (e.isFree) return "Free";
  if (e.priceUnits === undefined || e.coinType === undefined) return "";
  const ci = coinInfo(e.coinType);
  return `${fmtAmount(e.priceUnits, ci.decimals)} ${ci.symbol}`;
}

/**
 * "Featured this week" — the same deterministic trending ranking (upcoming, not
 * sold out, ranked by fill rate + proximity; see `featuredEvents`) rendered in a
 * wider snap-scroll carousel. No curation backend — a derived rule over public
 * on-chain state.
 */
export function FeaturedCarousel({ events }: { events: DiscoverEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const featured = useMemo(() => featuredEvents(events, 8), [events]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const card = el.querySelector("[data-featured-card]");
    const cardWidth = card instanceof HTMLElement ? card.clientWidth : 320;
    el.scrollBy({ left: dir * (cardWidth + 16), behavior: "smooth" });
  };

  if (featured.length === 0) return null;

  return (
    <section className="relative" aria-label="Featured events">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-amber-500/30 to-rose-500/30">
              <Icon icon="ph:sparkle-fill" size={14} className="text-amber-400" />
            </div>
            <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">Featured this week</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Upcoming events ranked by demand — live on Sui.
          </p>
        </div>
        <div className="hidden gap-1 sm:flex">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-full"
            onClick={() => scrollBy(-1)}
            aria-label="Scroll featured left"
          >
            <Icon icon="ic:round-chevron-left" size={18} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 rounded-full"
            onClick={() => scrollBy(1)}
            aria-label="Scroll featured right"
          >
            <Icon icon="ic:round-chevron-right" size={18} />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="-mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0"
      >
        {featured.map((e, i) => {
          const left = ticketsLeft(e);
          const sold = soldOut(e);
          const status = getEventStatus(e);
          return (
            <motion.div
              key={e.eventId}
              data-featured-card
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.4, delay: Math.min(i * 0.06, 0.3) }}
              whileHover={{ y: -4 }}
              className="w-[300px] shrink-0 snap-start sm:w-[340px]"
            >
              <Link
                href={`/event/${e.eventId}`}
                aria-label={`View ${e.name}`}
                className="group relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card/60 text-left shadow-lg shadow-black/5 backdrop-blur-sm transition-colors hover:border-foreground/30"
              >
                <div className="relative h-32 w-full overflow-hidden">
                  <EventPoster seed={e.eventId} category={e.category} className="absolute inset-0" />
                  <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1.5">
                    {status === "today" && (
                      <Badge className="rounded-full border border-amber-400/40 bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-100 backdrop-blur">
                        Today
                      </Badge>
                    )}
                    {status === "live" && (
                      <Badge className="flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-100 backdrop-blur">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                        Live
                      </Badge>
                    )}
                  </div>
                  <div className="absolute right-3 top-3 z-10 rounded-full border border-white/20 bg-black/40 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
                    {priceLabel(e)}
                  </div>
                  <div className="absolute inset-x-0 bottom-0 p-3">
                    {e.category && (
                      <p className="text-[10px] font-medium uppercase tracking-widest text-white/70">
                        {e.category}
                      </p>
                    )}
                    <h3 className="line-clamp-1 text-base font-semibold text-white drop-shadow">
                      {e.name}
                    </h3>
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-2 p-3">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    {e.city ? (
                      <span className="flex items-center gap-1 truncate">
                        <Icon icon="carbon:location" size={12} />
                        {e.city}
                      </span>
                    ) : (
                      <span />
                    )}
                    <span className="flex items-center gap-1">
                      <Icon icon="ion:ticket" size={12} />
                      {sold ? "Sold out" : `${String(left)} left`}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between border-t pt-2">
                    <span className="text-[11px] text-muted-foreground">
                      {formatDateRangeMs(e.startMs, e.endMs)}
                    </span>
                    <span className="flex items-center gap-1 rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-medium text-fuchsia-300">
                      <Icon icon="ph:sparkle-fill" size={10} />
                      {formatCountdownCompact(e.startMs)}
                    </span>
                  </div>
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
