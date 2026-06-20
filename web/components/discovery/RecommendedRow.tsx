"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import {
  recommendedEvents,
  useFavorites,
  useRecentlyViewed,
  ticketsLeft,
  getEventStatus,
  formatCountdownCompact,
  type DiscoverEvent,
} from "@/lib/discovery";
import { usePurchasedEventIds } from "@/lib/events";
import { coinInfo, fmtAmount } from "@/lib/config";

function priceLabel(e: DiscoverEvent): string {
  if (e.isFree) return "Free";
  if (e.priceUnits === undefined || e.coinType === undefined) return "";
  const ci = coinInfo(e.coinType);
  return `${fmtAmount(e.priceUnits, ci.decimals)} ${ci.symbol}`;
}

/**
 * "Recommended for you" — scores events by similarity (category / city /
 * organizer) to a profile built from localStorage favorites + the on-chain
 * purchased set (TicketMinted logs for the connected address). No daily-random
 * term. Renders nothing until there's a profile to score against.
 */
export function RecommendedRow({
  events,
  address,
}: {
  events: DiscoverEvent[];
  address: string | null;
}) {
  const { favorites } = useFavorites();
  const { ids: recentIds } = useRecentlyViewed();
  const purchased = usePurchasedEventIds(address);

  const recommendations = useMemo(
    () => recommendedEvents(events, favorites, purchased, recentIds, 4),
    [events, favorites, purchased, recentIds],
  );

  if (recommendations.length === 0) return null;

  return (
    <section aria-label="Recommended for you" className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500/30 to-fuchsia-500/30">
          <Icon icon="ph:thumbs-up-fill" size={14} className="text-violet-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight sm:text-xl">Recommended for you</h2>
          <p className="text-[11px] text-muted-foreground">
            Based on your favorites and tickets.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {recommendations.map((e, i) => {
          const left = ticketsLeft(e);
          const status = getEventStatus(e);
          return (
            <motion.div
              key={e.eventId}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.06, 0.3) }}
              whileHover={{ y: -3 }}
            >
              <Link
                href={`/event/${e.eventId}`}
                aria-label={`Open ${e.name}`}
                className="group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card/50 text-left shadow-sm backdrop-blur transition-colors hover:border-foreground/30"
              >
                <div className="relative h-16 w-full overflow-hidden">
                  <EventPoster seed={e.eventId} category={e.category} className="absolute inset-0" />
                  <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/20 px-1.5 py-0.5 text-[9px] font-medium text-violet-50 backdrop-blur">
                    <Icon icon="ph:sparkle-fill" size={9} />
                    Pick
                  </div>
                  {status === "live" && (
                    <span className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-400/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-100 backdrop-blur">
                      <span className="h-1 w-1 animate-pulse rounded-full bg-rose-400" />
                      Live
                    </span>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-2">
                    <p className="line-clamp-1 text-xs font-semibold text-white drop-shadow">{e.name}</p>
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    {e.city ? <span className="truncate">{e.city}</span> : <span />}
                    <span>{String(left)} left</span>
                  </div>
                  <div className="flex items-center justify-between border-t pt-1 text-[10px]">
                    <span className="text-muted-foreground">{formatCountdownCompact(e.startMs)}</span>
                    <span className="font-medium">{priceLabel(e)}</span>
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
