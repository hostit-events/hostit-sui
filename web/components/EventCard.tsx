"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { coinInfo, fmtAmount } from "@/lib/config";
import { getFields, totalWithFee } from "@/lib/ticketing";
import { useSuiQuery } from "@/lib/hooks";
import type { PriceOption } from "@/lib/events";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { blobUrl, isBlobId } from "@/lib/walrus";
import { BuyTicketDialog, type BuyPayload } from "@/components/BuyTicketDialog";
import { EventPoster } from "@/components/EventPoster";
import { AddressDisplay } from "./AddressDisplay";
import { Icon } from "./Icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GetObjectParams, SuiObjectResponse } from "@mysten/sui/jsonRpc";

interface EventCardProps {
  eventId: string;
  organizer: string;
  buyerAddress: string | null;
  isFree: boolean;
  prices: PriceOption[];
  verified?: boolean;
  hasMarket?: boolean;
  onMetadata?: (
    eventId: string,
    meta: Pick<EventMetadata, "category" | "city" | "venue">,
  ) => void;
  /** Pre-fetched object from batch read (DiscoverScreen). When omitted the card self-fetches. */
  object?: SuiObjectResponse | null;
  /** Called after a buy to refetch the batch. Falls back to the card's own q.refetch(). */
  onRefetch?: () => void;
}

export function EventCard({
  eventId,
  organizer,
  buyerAddress,
  isFree,
  prices,
  verified = false,
  hasMarket = false,
  onMetadata,
  object: prefetched,
  onRefetch,
}: EventCardProps) {
  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id: eventId, options: { showContent: true } },
    { enabled: prefetched === undefined },
  );
  const resp = prefetched !== undefined ? prefetched : q.data;
  const [meta, setMeta] = useState<EventMetadata | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buyPayload, setBuyPayload] = useState<BuyPayload | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const f = getFields(resp ?? {});
  const uri = f ? String(f.uri ?? "") : "";

  useEffect(() => {
    let alive = true;
    if (uri) {
      getEventMetadata(uri).then((m) => {
        if (!alive) return;
        setMeta(m);
        if (m && onMetadata) {
          onMetadata(eventId, { category: m.category, city: m.city, venue: m.venue });
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [eventId, uri, onMetadata]);

  // While the on-chain object is still loading, render the height-matched
  // skeleton (seeded poster gradient) so the card doesn't grow ~130px when its
  // data lands — see EventCardSkeleton.
  if (!f) return <EventCardSkeleton seed={eventId} />;

  const name = String(f.name);
  const minted = BigInt((f.minted as string) ?? "0");
  const maxTickets = BigInt((f.max_tickets as string) ?? "0");
  const startMs = Number(f.start_ms);
  const endMs = Number(f.end_ms);
  const purchaseStartMs = Number(f.purchase_start_ms);

  const maxPerUser = BigInt((f.max_per_user as string) ?? "0");
  const remaining = maxTickets - minted;
  const soldOut = remaining <= 0n;
  const now = Date.now();
  const windowOpen = now >= purchaseStartMs && now <= endMs;
  // Purchasable when open & not sold out — independent of connection. The
  // BuyTicketDialog owns connect → review → mint → done, so an unconnected
  // buyer lands on its connect step instead of facing a dead button.
  const canPurchase = !soldOut && windowOpen;

  const cat = meta?.category;
  const coverUrl = meta?.coverBlobId && isBlobId(meta.coverBlobId) ? blobUrl(meta.coverBlobId) : undefined;

  function openClaim() {
    setBuyPayload({ kind: "free", eventId, eventName: name, remaining, maxPerUser });
    setBuyOpen(true);
  }
  function openBuy(coinType: string, priceUnits: bigint) {
    setBuyPayload({ kind: "paid", eventId, eventName: name, coinType, priceUnits, remaining, maxPerUser });
    setBuyOpen(true);
  }

  // Label for a closed sale (sold out / wrong window).
  function statusLabel(): string {
    if (soldOut) return "Sold out";
    if (now < purchaseStartMs) return "Sale soon";
    if (now > endMs) return "Ended";
    return "Unavailable";
  }

  const dateLabel = `${new Date(startMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(endMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <Card className="gap-0 py-0 text-left transition-transform duration-200 hover:-translate-y-1 active:scale-[0.98]">
      <Link href={`/event/${eventId}`} className="poster rounded-none" style={{ height: 150, display: "block" }}>
        <EventPoster seed={eventId} category={cat} coverUrl={coverUrl} className="absolute inset-0" />
        <div className="absolute flex gap-1.5" style={{ top: 12, left: 12, flexWrap: "wrap" }}>
          {verified && <Badge variant="secondary"><Icon icon="streamline:star-badge-solid" size={11} /> Verified</Badge>}
          {hasMarket && <Badge variant="secondary"><Icon icon="mdi:chart-line" size={11} /> Market</Badge>}
          {isFree && <Badge variant="secondary">Free</Badge>}
          {meta?.tag && <Badge variant="secondary">{meta.tag}</Badge>}
        </div>
        <div className="absolute mono tabular-nums" style={{ bottom: 12, left: 14, color: "rgba(255,255,255,.92)", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
          {String(remaining)}/{String(maxTickets)} left
        </div>
      </Link>

      <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3.5">
        <Link href={`/event/${eventId}`} className="ev-title" style={{ color: "var(--fg1)" }}>{name}</Link>
        {meta?.city && (
          <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg3)" }}>
            <Icon icon="carbon:location" size={14} /> <span>{meta.city}{meta.venue ? ` · ${meta.venue}` : ""}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg3)" }}>
          <Icon icon="proicons:calendar" size={14} /> <span>{dateLabel}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg3)" }}>
          <Icon icon="solar:user-rounded-bold" size={14} /> <AddressDisplay address={organizer} suffix={4} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2.5 border-t pt-3">
          {isFree ? (
            <Button size="sm" className="min-h-11 sm:min-h-0" disabled={!canPurchase} onClick={openClaim}>
              <Icon icon="ion:ticket" size={15} />
              {!canPurchase ? statusLabel() : buyerAddress ? "Claim free" : "Connect to claim"}
            </Button>
          ) : prices.length === 0 ? (
            <Badge variant="outline">Price not set</Badge>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {prices.map((p) => {
                const ci = coinInfo(p.coinType);
                const allIn = `${fmtAmount(totalWithFee(BigInt(p.price)), ci.decimals)} ${ci.symbol}`;
                return (
                  <div key={p.coinType} className="flex flex-col gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          className="min-h-11 sm:min-h-0"
                          disabled={!canPurchase}
                          onClick={() => openBuy(p.coinType, BigInt(p.price))}
                        >
                          <Icon icon="ion:ticket" size={15} />
                          {!canPurchase
                            ? statusLabel()
                            : buyerAddress
                              ? `${fmtAmount(BigInt(p.price), ci.decimals)} ${ci.symbol}`
                              : "Connect to buy"}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Total incl. 3% fee: {allIn}</TooltipContent>
                    </Tooltip>
                    {canPurchase && <span className="text-[11px]" style={{ color: "var(--fg3)" }}>{allIn} incl. 3% fee</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <BuyTicketDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        payload={buyPayload}
        onSuccess={() => (onRefetch ? onRefetch() : q.refetch())}
      />
    </Card>
  );
}

/**
 * Height-matched placeholder for an EventCard (~340px — the loaded-card height),
 * so a card streaming in (skeleton → full) and a page-load skeleton grid both
 * reserve the real card's footprint and don't shift the layout. `seed` renders
 * the deterministic poster gradient (used by an EventCard whose object is still
 * loading); without it the poster is a neutral pulse (used by the loading grid).
 * Structure + paddings mirror the real card so the heights line up.
 */
export function EventCardSkeleton({ seed }: { seed?: string }) {
  return (
    <Card className="gap-0 py-0" aria-hidden>
      <div className="poster rounded-none" style={{ height: 150 }}>
        {seed ? (
          <EventPoster seed={seed} className="absolute inset-0" />
        ) : (
          <Skeleton className="absolute inset-0 rounded-none" />
        )}
      </div>
      <div className="flex flex-col gap-2.5 px-4 pb-4 pt-3.5">
        <Skeleton className="h-5 w-3/4" /> {/* title */}
        <Skeleton className="h-4 w-1/2" /> {/* city/date */}
        <Skeleton className="h-4 w-2/5" /> {/* date */}
        <Skeleton className="h-4 w-3/5" /> {/* organizer */}
        <div className="border-t pt-3">
          <Skeleton className="h-9 w-28" /> {/* CTA */}
        </div>
      </div>
    </Card>
  );
}
