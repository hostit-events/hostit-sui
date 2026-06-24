"use client";

import { useMemo } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import { Badge } from "@/components/ui/badge";
import {
  useRecentlyViewed,
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
 * Recently viewed events — resolves the device-local recently-viewed id list
 * (written by the event page) against the live event list passed from
 * DiscoverScreen. Renders nothing when no ids resolve.
 */
export function RecentlyViewedRow({ events }: { events: DiscoverEvent[] }) {
  const { ids, clear } = useRecentlyViewed();

  const resolved = useMemo(() => {
    const byId = new Map(events.map((e) => [e.eventId, e]));
    return ids.map((id) => byId.get(id)).filter((e): e is DiscoverEvent => Boolean(e));
  }, [ids, events]);

  if (resolved.length === 0) return null;

  return (
    <section aria-label="Recently viewed events" className="space-y-3">
      <div className="flex items-end justify-between">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-slate-500/30 to-zinc-500/30">
            <Icon icon="ic:round-history" size={14} className="text-muted-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-semibold tracking-tight sm:text-xl">Recently viewed</h2>
            <p className="text-[11px] text-muted-foreground">Pick up where you left off.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center min-h-11 -my-3 px-1 sm:min-h-0 sm:my-0 sm:px-0 text-[11px] text-muted-foreground transition-[color,transform] hover:text-foreground active:scale-[0.96]"
          aria-label="Clear recently viewed history"
        >
          Clear
        </button>
      </div>

      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {resolved.map((e, i) => {
          const status = getEventStatus(e);
          return (
            <motion.div
              key={e.eventId}
              initial={{ opacity: 0, x: 16 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: "-40px" }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.04, 0.2) }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.98 }}
              className="w-[240px] shrink-0"
            >
              <Link
                href={`/event/${e.eventId}`}
                aria-label={`Open ${e.name}`}
                className="group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card/50 text-left shadow-sm backdrop-blur transition-colors hover:border-foreground/30"
              >
                <div className="relative h-16 w-full overflow-hidden">
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
                <div className="flex items-center justify-between gap-1 p-2 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1 tabular-nums">
                    <Icon icon="ic:round-schedule" size={11} />
                    {formatCountdownCompact(e.startMs)}
                  </span>
                  {e.city && <span className="truncate">{e.city}</span>}
                </div>
                <div className="flex items-center justify-between border-t px-2 py-1 text-[10px]">
                  <span className="text-muted-foreground">{formatDateRangeMs(e.startMs, e.endMs)}</span>
                  <span className="font-medium">{priceLabel(e)}</span>
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
