"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ENOKI_ENABLED, coinInfo, fmtAmount } from "@/lib/config";
import { buyTx, claimFreeTx, getFields, totalWithFee } from "@/lib/ticketing";
import { useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import type { PriceOption } from "@/lib/events";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { blobUrl, isBlobId } from "@/lib/walrus";
import { catPalette, catGlyph } from "@/lib/data";
import { humanizeError } from "@/lib/moveErrors";
import { TxLink } from "@/components/TxLink";
import { AddressDisplay } from "./AddressDisplay";
import { Icon } from "./Icon";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { GetObjectParams, SuiObjectResponse } from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";

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
function hashHue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
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
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [meta, setMeta] = useState<EventMetadata | null>(null);
  const [pendingCoin, setPendingCoin] = useState<string | null>(null);
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

  if (!f) {
    return (
      <Card className="gap-0 py-0">
        <Skeleton className="h-[150px] w-full rounded-b-none" />
        <div className="flex flex-col gap-2 px-4 pb-4 pt-3.5">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </Card>
    );
  }

  const name = String(f.name);
  const minted = BigInt((f.minted as string) ?? "0");
  const maxTickets = BigInt((f.max_tickets as string) ?? "0");
  const startMs = Number(f.start_ms);
  const endMs = Number(f.end_ms);
  const purchaseStartMs = Number(f.purchase_start_ms);

  const remaining = maxTickets - minted;
  const soldOut = remaining <= 0n;
  const now = Date.now();
  const windowOpen = now >= purchaseStartMs && now <= endMs;
  const canAct = Boolean(buyerAddress) && !soldOut && windowOpen;

  const cat = meta?.category;
  const [p1, p2] = cat ? catPalette(cat) : (() => {
    const hue = hashHue(eventId);
    return [`hsl(${hue} 90% 58%)`, `hsl(${(hue + 46) % 360} 88% 46%)`] as [string, string];
  })();
  const coverUrl = meta?.coverBlobId && isBlobId(meta.coverBlobId) ? blobUrl(meta.coverBlobId) : undefined;
  const glyphIcon = catGlyph(cat);

  async function run(tx: Transaction, coinType?: string) {
    if (!buyerAddress) return;
    setPendingCoin(coinType ?? null);
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: buyerAddress })
        : await regular.mutateAsync({ transaction: tx });
      toast.success(isFree ? "Ticket claimed" : "Ticket purchased", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      if (onRefetch) onRefetch(); else q.refetch();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setPendingCoin(null);
    }
  }

  function statusLabel(): string {
    if (!buyerAddress) return "Connect to buy";
    if (soldOut) return "Sold out";
    if (now < purchaseStartMs) return "Sale soon";
    if (now > endMs) return "Ended";
    return "Unavailable";
  }

  const dateLabel = `${new Date(startMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(endMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  return (
    <Card className="gap-0 py-0 text-left transition-transform duration-200 hover:-translate-y-1">
      <Link href={`/event/${eventId}`} className="poster rounded-none" style={{ height: 150, display: "block", ["--p1" as string]: p1, ["--p2" as string]: p2 } as React.CSSProperties}>
        {coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt={name}
            className="absolute inset-0 w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <div className="poster-noise" />
        <span className="poster-glyph"><Icon icon={glyphIcon} size={64} /></span>
        <div className="absolute flex gap-1.5" style={{ top: 12, left: 12, flexWrap: "wrap" }}>
          {verified && <Badge variant="secondary"><Icon icon="streamline:star-badge-solid" size={11} /> Verified</Badge>}
          {hasMarket && <Badge variant="secondary"><Icon icon="mdi:chart-line" size={11} /> Market</Badge>}
          {isFree && <Badge variant="secondary">Free</Badge>}
          {meta?.tag && <Badge variant="secondary">{meta.tag}</Badge>}
        </div>
        <div className="absolute mono" style={{ bottom: 12, left: 14, color: "rgba(255,255,255,.92)", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
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
            <Button size="sm" disabled={!canAct || isPending} onClick={() => run(claimFreeTx({ eventId, recipient: buyerAddress! }))}>
              <Icon icon="ion:ticket" size={15} />
              {isPending ? "Claiming…" : canAct ? "Claim free" : statusLabel()}
            </Button>
          ) : prices.length === 0 ? (
            <Badge variant="outline">Price not set</Badge>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {prices.map((p) => {
                const ci = coinInfo(p.coinType);
                const allIn = `${fmtAmount(totalWithFee(BigInt(p.price)), ci.decimals)} ${ci.symbol}`;
                const coinPending = pendingCoin === p.coinType;
                return (
                  <div key={p.coinType} className="flex flex-col gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          disabled={!canAct || isPending}
                          onClick={() => run(buyTx({ eventId, coinType: p.coinType, priceUnits: BigInt(p.price), recipient: buyerAddress!, sponsored: ENOKI_ENABLED }), p.coinType)}
                        >
                          <Icon icon="ion:ticket" size={15} />
                          {coinPending ? "Buying…" : canAct ? `${fmtAmount(BigInt(p.price), ci.decimals)} ${ci.symbol}` : statusLabel()}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Total incl. 3% fee: {allIn}</TooltipContent>
                    </Tooltip>
                    {canAct && <span className="text-[11px]" style={{ color: "var(--fg3)" }}>{allIn} incl. 3% fee</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
