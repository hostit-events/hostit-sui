"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { coinInfo, fmtAmount } from "@/lib/config";
import { getFields, totalWithFee } from "@/lib/ticketing";
import { useCurrentAccount, useSuiQuery } from "@/lib/hooks";
import { useEventPrices } from "@/lib/events";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { blobUrl, isBlobId } from "@/lib/walrus";
import { useIsVerified } from "@/lib/verification";
import { eventShareUrl } from "@/lib/share";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import { SocialShare } from "@/components/SocialShare";
import { BuyTicketDialog, type BuyPayload } from "@/components/BuyTicketDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { GetObjectParams, SuiObjectResponse } from "@mysten/sui/jsonRpc";

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Condensed event quick-view rendered as a Dialog OVER /discover via the
 * intercepting/parallel route (`@modal/(.)event/[id]`). Same on-chain reads as
 * EventPageScreen (getObject + getFields, useEventPrices, metadata, useIsVerified)
 * but only what the full page already surfaces — the prototype's reviews/related/
 * organizer-profile sub-modals have no on-chain backing and are intentionally
 * dropped. Closing (Back / Esc / overlay / X) calls `router.back()`, returning
 * the URL to /discover. A direct/hard load of /event/[id] bypasses the
 * interceptor and renders the full EventPageScreen instead.
 */
export function EventQuickViewModal({ id }: { id: string }) {
  const router = useRouter();
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id,
    options: { showContent: true },
  });
  const { pricesBySeq } = useEventPrices();

  const [meta, setMeta] = useState<EventMetadata | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [buyPayload, setBuyPayload] = useState<BuyPayload | null>(null);

  const f = getFields(q.data ?? {});
  const uri = f ? String(f.uri ?? "") : "";
  const organizer = f ? String(f.organizer ?? "") : "";
  const verified = useIsVerified(organizer || null);

  useEffect(() => {
    let alive = true;
    if (uri) {
      getEventMetadata(uri).then((m) => {
        if (alive) setMeta(m);
      });
    }
    return () => {
      alive = false;
    };
  }, [uri]);

  // Esc / overlay / X / Back all funnel through here → return to /discover.
  function close(openState: boolean) {
    if (!openState) router.back();
  }

  // Open the unified BuyTicketDialog. It owns connect → review → mint → done,
  // so we no longer gate on `addr`: an unconnected buyer lands on the connect
  // step inside the dialog instead of hitting a dead button.
  function openClaim(name: string) {
    setBuyPayload({ kind: "free", eventId: id, eventName: name, remaining, maxPerUser });
    setBuyOpen(true);
  }
  function openBuy(name: string, coinType: string, priceUnits: bigint) {
    setBuyPayload({ kind: "paid", eventId: id, eventName: name, coinType, priceUnits, remaining, maxPerUser });
    setBuyOpen(true);
  }

  // ---- Derived display state (only once fields load) ----
  const name = f ? String(f.name) : "";
  const eventSeq = f ? String(f.event_seq) : "";
  const startMs = f ? Number(f.start_ms) : 0;
  const endMs = f ? Number(f.end_ms) : 0;
  const purchaseStartMs = f ? Number(f.purchase_start_ms) : 0;
  const minted = f ? BigInt((f.minted as string) ?? "0") : 0n;
  const maxTickets = f ? BigInt((f.max_tickets as string) ?? "0") : 0n;
  const maxPerUser = f ? BigInt((f.max_per_user as string) ?? "0") : 0n;
  const isFree = f ? Boolean(f.is_free) : false;

  const remaining = maxTickets - minted;
  const soldOut = remaining <= 0n;
  const now = Date.now();
  const windowOpen = now >= purchaseStartMs && now <= endMs;
  // The sale is purchasable when it's open & not sold out — independent of
  // connection. The dialog now owns the connect step, so an unconnected buyer
  // can still open it ("Connect to buy") instead of facing a dead button.
  const canPurchase = !soldOut && windowOpen;

  const cat = meta?.category;
  const coverUrl =
    meta?.coverBlobId && isBlobId(meta.coverBlobId) ? blobUrl(meta.coverBlobId) : undefined;
  const venueCity = [meta?.venue, meta?.city].filter(Boolean).join(" · ");
  const prices = pricesBySeq.get(eventSeq) ?? [];
  const pct =
    maxTickets > 0n ? Math.min(100, Number((minted * 100n) / maxTickets)) : 0;

  // Label for when the sale itself is closed (sold out / wrong window). When the
  // sale IS open, the CTA shows "Connect to buy" / "Buy · …" instead.
  function statusLabel(): string {
    if (soldOut) return "Sold out";
    if (now < purchaseStartMs) return "Sale not open yet";
    if (now > endMs) return "Event ended";
    return "Unavailable";
  }

  return (
    <Dialog open={!buyOpen} onOpenChange={close}>
      {/* open={!buyOpen}: while the buy dialog is open, hide this quick-view so
          the two never stack. Setting open=false here does NOT fire onOpenChange
          (only a user-initiated close does) → no router.back; the sibling
          BuyTicketDialog stays mounted and visible. Closing buy restores this
          view with refreshed counts. */}
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-lg">
        {/* sr-only title/description always present so Radix never warns; the
            visible heading lives in the body once the name loads. */}
        <DialogHeader className="sr-only">
          <DialogTitle>{name || "Event quick view"}</DialogTitle>
          <DialogDescription>
            Quick view of {name || "this event"}. Open the full page for all details.
          </DialogDescription>
        </DialogHeader>

        {q.isLoading || !f ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-36 w-full rounded-lg" />
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            {!q.isLoading && (
              <p className="text-sm text-muted-foreground">
                Couldn&apos;t load this event.{" "}
                <Link href="/discover" style={{ color: "var(--hi-blue)" }}>
                  Back to Discover
                </Link>
                .
              </p>
            )}
          </div>
        ) : (
          <>
            {/* Cover */}
            <div className="poster relative" style={{ height: 160 }}>
              <EventPoster seed={id} category={cat} coverUrl={coverUrl} className="absolute inset-0" />
              {/* Overlay chrome: dark-glass so it stays legible over any cover. */}
              <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
                {meta?.tag && (
                  <Badge className="border-white/15 bg-black/45 text-white backdrop-blur-sm">{meta.tag}</Badge>
                )}
                {isFree && (
                  <Badge className="border-white/15 bg-black/45 text-white backdrop-blur-sm">Free</Badge>
                )}
                {verified && (
                  <Badge className="border-white/15 bg-black/45 text-white backdrop-blur-sm">
                    <Icon icon="streamline:star-badge-solid" size={11} className="text-sky-300" /> Verified
                  </Badge>
                )}
              </div>
              {/* Just share + close here — the full-page link lives once in the
                  footer (the old expand icon was a duplicate of "View full page"). */}
              <div className="absolute right-3 top-3 flex items-center gap-1.5">
                <SocialShare title={name} url={eventShareUrl(id)} variant="icon" />
                <button
                  type="button"
                  onClick={() => router.back()}
                  aria-label="Close"
                  className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/35 text-white backdrop-blur transition-[color,background-color,transform] hover:bg-black/55 active:scale-[0.96]"
                >
                  <Icon icon="ic:round-close" size={18} />
                </button>
              </div>
            </div>

            <div className="space-y-4 px-5 pb-5 pt-4">
              <h2 className="page-title" style={{ fontSize: 22 }}>
                {name}
              </h2>

              {/* Quick facts */}
              <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-2" style={{ color: "var(--fg2)" }}>
                <span className="inline-flex items-center gap-1.5">
                  <Icon icon="proicons:calendar" size={15} />
                  {fmtDate(startMs)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Icon icon="mdi:clock-outline" size={15} />
                  {fmtTime(startMs)} – {fmtTime(endMs)}
                </span>
                {venueCity && (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon icon="carbon:location" size={15} />
                    {venueCity}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <Icon icon="solar:user-rounded-bold" size={15} />
                  <AddressDisplay address={organizer} suffix={4} />
                </span>
              </div>

              {/* About (condensed) */}
              {meta?.description?.trim() && (
                <p
                  className="text-sm"
                  style={{
                    color: "var(--fg2)",
                    lineHeight: 1.6,
                    display: "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {meta.description}
                </p>
              )}

              {/* Capacity */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs" style={{ color: "var(--fg2)" }}>
                  <span>{soldOut ? "Sold out" : `${String(remaining)} of ${String(maxTickets)} remaining`}</span>
                  <span className="mono">{pct}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>

            {/* Purpose-built footer: DialogFooter's -mx-4/-mb-4 + sm:justify-end
                assume a p-4 content box and crammed both buttons to the right.
                Aligned to the body (px-5), divided, primary CTA anchored right. */}
            <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-5 py-3.5">
              <Button asChild variant="ghost" size="sm" className="-ml-2">
                {/* hard nav escapes the interceptor → full EventPageScreen */}
                <a href={`/event/${id}`}>
                  <Icon icon="ic:round-open-in-full" size={15} /> View full page
                </a>
              </Button>

              {isFree ? (
                <Button className="min-h-11 sm:min-h-0" disabled={!canPurchase} onClick={() => openClaim(name)}>
                  <Icon icon="ion:ticket" size={15} />
                  {!canPurchase ? statusLabel() : addr ? "Claim free" : "Connect to claim"}
                </Button>
              ) : prices.length === 0 ? (
                <Badge variant="outline" role="status">
                  Price not set
                </Badge>
              ) : (
                (() => {
                  const p = prices[0];
                  const ci = coinInfo(p.coinType);
                  const total = totalWithFee(BigInt(p.price));
                  return (
                    <Button
                      className="min-h-11 sm:min-h-0"
                      disabled={!canPurchase}
                      onClick={() => openBuy(name, p.coinType, BigInt(p.price))}
                    >
                      <Icon icon="ion:ticket" size={15} />
                      {!canPurchase
                        ? statusLabel()
                        : addr
                          ? `Buy · ${fmtAmount(total, ci.decimals)} ${ci.symbol}`
                          : "Connect to buy"}
                    </Button>
                  );
                })()
              )}
            </div>
          </>
        )}
      </DialogContent>

      <BuyTicketDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        payload={buyPayload}
        onSuccess={() => q.refetch()}
        onDone={() => router.back()}
      />
    </Dialog>
  );
}
