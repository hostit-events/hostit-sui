"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  topTrending,
  ticketsLeft,
  fillPercent,
  getEventStatus,
  formatCountdownCompact,
  type DiscoverEvent,
} from "@/lib/discovery";
import { coinInfo, fmtAmount } from "@/lib/config";

function priceLabel(e: DiscoverEvent): string {
  if (e.isFree) return "Free";
  if (e.priceUnits === undefined || e.coinType === undefined) return "";
  const ci = coinInfo(e.coinType);
  return `${fmtAmount(e.priceUnits, ci.decimals)} ${ci.symbol}`;
}

export function TrendingRow({ events }: { events: DiscoverEvent[] }) {
  const trending = useMemo(() => topTrending(events, 6), [events]);
  if (trending.length === 0) return null;

  return (
    <section aria-label="Trending now" className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-rose-500/30 to-orange-500/30">
          <Icon icon="ph:flame-fill" size={14} className="text-rose-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight sm:text-xl">Trending now</h2>
          <p className="text-[11px] text-muted-foreground">Hottest events by ticket fill rate.</p>
        </div>
      </div>

      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {trending.map((e, i) => {
          const status = getEventStatus(e);
          const pct = fillPercent(e);
          return (
            <motion.div
              key={e.eventId}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.05, 0.25) }}
              whileHover={{ y: -3 }}
              className="w-[220px] shrink-0 sm:w-[240px]"
            >
              <Link
                href={`/event/${e.eventId}`}
                aria-label={`Open ${e.name}`}
                className="group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card/50 text-left shadow-sm backdrop-blur transition-colors hover:border-foreground/30"
              >
                <div className="absolute left-2 top-2 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/50 text-[11px] font-bold text-white backdrop-blur">
                  {i + 1}
                </div>
                <div className="relative h-20 w-full overflow-hidden">
                  <EventPoster seed={e.eventId} category={e.category} className="absolute inset-0" />
                  {status === "live" && (
                    <Badge
                      variant="live"
                      className="absolute right-2 top-2 z-10 gap-1 text-[9px] font-semibold uppercase tracking-wide backdrop-blur"
                    >
                      <span className="h-1 w-1 animate-pulse rounded-full bg-current" />
                      Live
                    </Badge>
                  )}
                  <div className="absolute inset-x-0 bottom-0 p-2">
                    <p className="line-clamp-1 text-xs font-semibold text-white drop-shadow">{e.name}</p>
                  </div>
                </div>

                <div className="flex flex-1 flex-col gap-1.5 p-2">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    {e.city ? (
                      <span className="flex items-center gap-0.5 truncate">
                        <Icon icon="carbon:location" size={11} />
                        {e.city}
                      </span>
                    ) : (
                      <span />
                    )}
                    <span className="flex items-center gap-0.5">
                      <Icon icon="ion:ticket" size={11} />
                      {String(ticketsLeft(e))} left
                    </span>
                  </div>
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <motion.div
                      initial={{ width: 0 }}
                      whileInView={{ width: `${pct}%` }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5, delay: 0.1 }}
                      className={cn(
                        "h-full rounded-full",
                        pct >= 80 ? "bg-rose-500" : pct >= 40 ? "bg-amber-500" : "bg-emerald-500",
                      )}
                    />
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
