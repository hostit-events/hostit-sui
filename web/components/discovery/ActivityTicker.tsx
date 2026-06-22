"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Icon } from "@/components/Icon";
import type { ActivityMint } from "@/lib/events";

export interface ActivityTickerProps {
  mints: ActivityMint[];
}

/**
 * Live activity "announcements" card — a glass panel with a pulsing LIVE pill that
 * cycles recent on-chain ticket mints / POAP claims. Driven entirely by
 * `useActivityFeed()` (real `TicketMinted` / `PoapClaimed` logs). Renders nothing
 * when the feed is empty (correct for a fresh package with no mints).
 */
export function ActivityTicker({ mints }: ActivityTickerProps) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (mints.length === 0) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % mints.length), 3500);
    return () => clearInterval(t);
  }, [mints.length]);

  if (mints.length === 0) return null;

  const visibleCount = 3;
  const window = Array.from({ length: Math.min(visibleCount, mints.length) }, (_, i) => {
    return mints[(idx + i) % mints.length];
  });

  return (
    <section
      aria-label="Live on-chain activity"
      className="relative overflow-hidden rounded-2xl border bg-card/40 p-3 backdrop-blur"
    >
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-transparent bg-success/15 px-2.5 py-1 text-success">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider">
            Live
          </span>
        </div>
        <div className="flex flex-1 items-center gap-2 overflow-hidden">
          <Icon icon="ic:round-bolt" size={16} className="hidden shrink-0 text-muted-foreground sm:block" />
          <div className="relative flex-1 overflow-hidden">
            <AnimatePresence mode="popLayout">
              {window.map((m) => (
                <motion.div
                  key={m.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.4 }}
                  className="flex items-center gap-2 whitespace-nowrap text-xs"
                >
                  <span className="text-base">{m.emoji}</span>
                  <span className="mono font-medium text-foreground">{m.walletShort}</span>
                  <span className="text-muted-foreground">
                    {m.emoji === "🏅" ? "claimed a POAP for" : "got a ticket for"}
                  </span>
                  <span className="truncate font-medium text-foreground">{m.eventTitle}</span>
                  <span className="hidden text-muted-foreground sm:inline">· {m.ago}</span>
                  {m.amountLabel && (
                    <span className="flex items-center gap-0.5 rounded-full bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                      <Icon icon="ic:round-bolt" size={10} />
                      {m.amountLabel}
                    </span>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}
