"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { ENOKI_ENABLED, REFUND_PERIOD_MS, coinInfo, fmtAmount } from "@/lib/config";
import { getFields, totalWithFee } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { useEventPrices } from "@/lib/events";
import { recordRecentlyViewed } from "@/lib/discovery";
import { useEventMarkets } from "@/lib/markets";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { blobUrl, isBlobId, storeJson } from "@/lib/walrus";
import { useIsVerified } from "@/lib/verification";
import { eventShareUrl } from "@/lib/share";
import { POAP_TYPE } from "@/lib/poap";
import {
  averageRating,
  hasReviewed as reviewedByAuthor,
  listReviews,
  reviewPostTx,
} from "@/lib/reviews";
import { TxLink } from "@/components/TxLink";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { EventPoster } from "@/components/EventPoster";
import { SocialShare } from "@/components/SocialShare";
import { BuyTicketDialog, type BuyPayload } from "@/components/BuyTicketDialog";
import { EventMarketsScreen } from "@/components/screens/EventMarketsScreen";
import { ReviewsSection } from "@/components/screens/ReviewsSection";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  CoinBalance,
  GetAllBalancesParams,
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

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

// True when `balance` (smallest units) can cover `required` (smallest units,
// already fee-inclusive). `balance === undefined` means "not loaded yet" → we do
// NOT block the button on an unknown balance (avoid a flash-disabled CTA on a slow
// RPC); we only disable once we've confirmed the wallet is short.
// Exported for unit testing (see __tests__/EventPageScreen.balance.test.ts).
export function canAfford(balance: bigint | undefined, required: bigint): boolean {
  if (balance === undefined) return true;
  return balance >= required;
}

// Inline "you can't afford this" hint under a Buy button when the connected
// wallet's balance of the selected coin can't cover the fee-inclusive total
// (USDC → Circle faucet; anything else → Sui testnet coins guide).
function InsufficientCoinHint({ symbol }: { symbol: string }) {
  const isUsdc = symbol === "USDC";
  return (
    <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
      Not enough {symbol} to buy this ticket.{" "}
      <a
        href={
          isUsdc
            ? "https://faucet.circle.com/"
            : "https://docs.sui.io/guides/developer/getting-started/get-coins"
        }
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--hi-blue)", textDecoration: "underline" }}
      >
        Get testnet {symbol}
      </a>
      .
    </div>
  );
}

function GoodToKnow({ icon, title, value }: { icon: string; title: string; value: string }) {
  return (
    <Card style={{ padding: 16 }}>
      <div className="flex items-center gap-1.5 section-label" style={{ margin: 0 }}>
        <Icon icon={icon} size={14} /> {title}
      </div>
      <div className="text-sm" style={{ color: "var(--fg1)", marginTop: 6 }}>
        {value}
      </div>
    </Card>
  );
}

export function EventPageScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id,
    options: { showContent: true },
  });

  const { pricesBySeq } = useEventPrices();

  const [meta, setMeta] = useState<EventMetadata | null>(null);
  // Re-render every ~30s so sale-window state (open/ended) stays fresh without a reload.
  const [, setNowTick] = useState(0);
  // Markets opt-in: when no market exists yet, the section is hidden behind a
  // subtle "+ Add a prediction market" link. Clicking it reveals the create UI.
  const [showCreateMarket, setShowCreateMarket] = useState(false);
  // Buy/claim flow is delegated to BuyTicketDialog (single source of submit
  // logic, shared with EventQuickViewModal). Opening it sets the payload.
  const [buyOpen, setBuyOpen] = useState(false);
  const [buyPayload, setBuyPayload] = useState<BuyPayload | null>(null);

  const f = getFields(q.data ?? {});
  const uri = f ? String(f.uri ?? "") : "";
  const organizer = f ? String(f.organizer ?? "") : "";
  // Derived early (before the loading/not-found returns) so the markets hook —
  // which must run unconditionally — can take it. Empty until fields load; the
  // hook simply matches nothing for an empty seq, so there's no premature fetch.
  const eventSeqEarly = f ? String(f.event_seq) : "";

  const verified = useIsVerified(organizer || null);

  // Opt-in markets: only render the full Markets section once a market exists.
  const {
    selloutMarketId,
    rangeMarketId,
    loading: marketsLoading,
    refetch: refetchMarkets,
  } = useEventMarkets(eventSeqEarly);
  const hasMarket = Boolean(selloutMarketId || rangeMarketId);

  // --- Reviews (GH#58) ------------------------------------------------------
  // POAP gate: can review iff the connected wallet owns a Poap whose event_id
  // matches THIS event. Mirrors ForumScreen's ticket gate, swapping the type
  // filter TICKET_TYPE -> POAP_TYPE. This keeps the permissionless model: the
  // only "permission" is having attended (holding the event POAP).
  const poapsQ = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: POAP_TYPE },
      options: { showContent: true },
    },
    { enabled: Boolean(addr) },
  );
  // The objectId of a POAP the wallet holds for THIS event (null if none) — both
  // the review gate and the on-chain post need it (post_review takes &Poap).
  const eventPoapId = useMemo(() => {
    if (!addr || !poapsQ.data) return null;
    for (const entry of poapsQ.data.data) {
      const fields = getFields(entry);
      if (fields != null && String(fields.event_id) === id) {
        const oid = entry.data?.objectId;
        if (oid) return oid;
      }
    }
    return null;
  }, [addr, poapsQ.data, id]);
  const holdsEventPoap = Boolean(eventPoapId);

  // Reviews are SHARED on-chain (GH#58): a Walrus body + a `ReviewPosted` anchor
  // queried back here (no Seal — reviews are public). Deduped by author (latest
  // per wallet), newest first. lib/reviews.ts owns the read.
  const reviewClient = useCurrentClient();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const reviewsQ = useQuery({
    queryKey: ["reviews", id],
    queryFn: () =>
      listReviews(reviewClient as unknown as Parameters<typeof listReviews>[0], id),
    staleTime: 30_000,
  });
  const reviews = useMemo(() => reviewsQ.data ?? [], [reviewsQ.data]);
  const [submittingReview, setSubmittingReview] = useState(false);

  const reviewSummary = useMemo(() => averageRating(reviews), [reviews]);
  const alreadyReviewed = useMemo(
    () => (addr ? reviewedByAuthor(reviews, addr) : false),
    [addr, reviews],
  );
  const canReview = Boolean(addr) && holdsEventPoap && !poapsQ.isLoading;

  const submitReview = useCallback(
    async (rating: number, comment: string) => {
      if (!addr || !eventPoapId) return;
      setSubmittingReview(true);
      try {
        const blobId = await storeJson({
          event_id: id,
          rating,
          comment,
          author: addr,
          ts_ms: Date.now(),
        });
        const tx = reviewPostTx({ eventId: id, poapId: eventPoapId, rating, blobId });
        const out = ENOKI_ENABLED
          ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
          : await regular.mutateAsync({ transaction: tx });
        toast.success("Review posted", {
          description: <TxLink digest={out.digest} chars={10} />,
        });
        await reviewsQ.refetch();
      } catch (e: unknown) {
        toast.error(humanizeError(e));
      } finally {
        setSubmittingReview(false);
      }
    },
    [addr, eventPoapId, id, regular, sponsored, reviewsQ],
  );

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

  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Record this event in the device-local "recently viewed" list (GH#56).
  useEffect(() => {
    recordRecentlyViewed(id);
  }, [id]);

  // 016 pre-flight: the connected wallet's balances across all coins, so a priced
  // Buy button can be disabled (with a faucet hint) when the wallet can't cover the
  // fee-inclusive total. A hook → must run before the early returns below.
  const balancesQ = useSuiQuery<"getAllBalances", GetAllBalancesParams, CoinBalance[]>(
    "getAllBalances",
    { owner: addr ?? "" },
    { enabled: Boolean(addr), staleTime: 15_000 },
  );

  // ---- loading / error / not-found ----
  if (q.isLoading) {
    return (
      <div className="space-y-6 screen-in">
        <Skeleton className="w-full" style={{ height: 240, borderRadius: "var(--r-lg)" }} />
        <div className="space-y-3">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }
  if (!f) {
    return (
      <div className="space-y-6 screen-in">
        <Card role="status" style={{ padding: 16 }}>
          <div className="font-semibold">Event not found.</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            This object isn&apos;t a HostIt event, or it failed to load.{" "}
            <Link href="/discover" style={{ color: "var(--hi-blue)" }}>
              Back to Discover
            </Link>
            .
          </p>
        </Card>
      </div>
    );
  }

  // ---- on-chain fields ----
  const name = String(f.name);
  const eventSeq = String(f.event_seq);
  const startMs = Number(f.start_ms);
  const endMs = Number(f.end_ms);
  const purchaseStartMs = Number(f.purchase_start_ms);
  const minted = BigInt((f.minted as string) ?? "0");
  const maxTickets = BigInt((f.max_tickets as string) ?? "0");
  const maxPerUser = String(f.max_per_user ?? "0");
  const isFree = Boolean(f.is_free);
  const isRefundable = Boolean(f.is_refundable);

  const remaining = maxTickets - minted;
  const soldOut = remaining <= 0n;
  const now = Date.now();
  const windowOpen = now >= purchaseStartMs && now <= endMs;
  // Sale is purchasable when open & not sold out — independent of connection.
  // BuyTicketDialog owns the connect step, so an unconnected buyer can still
  // open it ("Connect to buy").
  const canPurchase = !soldOut && windowOpen;
  const isOrganizer = Boolean(addr) && addr === organizer;

  const prices = pricesBySeq.get(eventSeq) ?? [];
  const balanceByCoin = new Map<string, bigint>(
    (balancesQ.data ?? []).map((b) => [b.coinType, BigInt(b.totalBalance)]),
  );

  const cat = meta?.category;
  const coverUrl =
    meta?.coverBlobId && isBlobId(meta.coverBlobId) ? blobUrl(meta.coverBlobId) : undefined;

  const venueCity = [meta?.venue, meta?.city].filter(Boolean).join(" · ");
  const coinLabels = prices.length
    ? Array.from(new Set(prices.map((p) => coinInfo(p.coinType).symbol))).join(", ")
    : isFree
      ? "Free"
      : "—";

  // BuyTicketDialog owns connect → review → mint → done, so we no longer gate on
  // `addr`: an unconnected buyer lands on the dialog's connect step.
  function openClaim() {
    setBuyPayload({
      kind: "free",
      eventId: id,
      eventName: name,
      remaining,
      maxPerUser: BigInt(maxPerUser),
    });
    setBuyOpen(true);
  }
  function openBuy(coinType: string, priceUnits: bigint) {
    setBuyPayload({
      kind: "paid",
      eventId: id,
      eventName: name,
      coinType,
      priceUnits,
      remaining,
      maxPerUser: BigInt(maxPerUser),
    });
    setBuyOpen(true);
  }

  // Label for a closed sale (sold out / wrong window). When the sale is open the
  // CTA shows "Connect to buy" / "Buy · …" / "Claim free ticket" instead.
  function statusLabel(): string {
    if (soldOut) return "Sold out";
    if (now < purchaseStartMs) return "Sale not open yet";
    if (now > endMs) return "Event ended";
    return "Unavailable";
  }

  return (
    <div className="space-y-8 screen-in">
      {/* ---- Hero ---- */}
      <div
        className="poster"
        style={
          {
            height: 280,
            borderRadius: "var(--r-lg)",
          } as React.CSSProperties
        }
      >
        <EventPoster seed={id} category={cat} coverUrl={coverUrl} className="absolute inset-0" />
        <div
          className="absolute flex gap-1.5"
          style={{ top: 14, left: 14, flexWrap: "wrap" }}
        >
          {meta?.tag && <Badge variant="secondary">{meta.tag}</Badge>}
          {isFree && <Badge variant="secondary">Free</Badge>}
          {verified && (
            <Badge variant="secondary">
              <Icon icon="streamline:star-badge-solid" size={11} /> Verified
            </Badge>
          )}
        </div>
        <div className="absolute" style={{ top: 14, right: 14 }}>
          <SocialShare title={name} url={eventShareUrl(id)} variant="icon" />
        </div>
        <div
          className="absolute mono"
          style={{
            bottom: 14,
            left: 16,
            color: "rgba(255,255,255,.92)",
            textShadow: "0 1px 4px rgba(0,0,0,.6)",
          }}
        >
          {String(remaining)}/{String(maxTickets)} left
        </div>
      </div>

      <div className="grid gap-8 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* ---- Main column ---- */}
        <div className="space-y-8" style={{ minWidth: 0 }}>
          {/* Title block */}
          <div className="space-y-3">
            <h1 className="page-title" style={{ fontSize: 34 }}>
              {name}
            </h1>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm" style={{ color: "var(--fg2)" }}>
              <span className="inline-flex items-center gap-1.5">
                <Icon icon="proicons:calendar" size={15} />
                {fmtDate(startMs)}
                {fmtDate(startMs) !== fmtDate(endMs) ? ` – ${fmtDate(endMs)}` : ""}
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
            </div>
          </div>

          {/* Organizer row */}
          <Card className="flex flex-wrap flex-row items-center justify-between gap-3" style={{ padding: 16 }}>
            <div className="flex items-center gap-2 text-sm">
              <Icon icon="solar:user-rounded-bold" size={16} />
              <span style={{ color: "var(--fg2)" }}>Hosted by</span>
              <AddressDisplay address={organizer} suffix={4} />
              {verified && (
                <Badge variant="secondary">
                  <Icon icon="streamline:star-badge-solid" size={11} /> Verified
                </Badge>
              )}
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={`/forum/${id}`}>
                <Icon icon="ion:chatbubbles" size={15} /> Event chat
              </Link>
            </Button>
          </Card>

          {/* About */}
          <div className="space-y-3">
            <h2 className="section-label flex items-center gap-1.5">
              <Icon icon="ph:info-bold" size={14} /> About
            </h2>
            <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--fg2)", lineHeight: 1.7 }}>
              {meta?.description?.trim() || "No description was provided for this event."}
            </p>
          </div>

          {/* Good to know */}
          <div className="space-y-3">
            <h2 className="section-label flex items-center gap-1.5">
              <Icon icon="ph:list-checks-bold" size={14} /> Good to know
            </h2>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <GoodToKnow icon="mdi:door-open" title="Doors" value={`${fmtTime(startMs)}, ${fmtDate(startMs)}`} />
              <GoodToKnow
                icon="carbon:location"
                title="Venue"
                value={venueCity || "To be announced"}
              />
              <GoodToKnow
                icon="ion:ticket"
                title="Entry"
                value={isFree ? "Free claim — one per wallet" : `Up to ${maxPerUser} per wallet`}
              />
              <GoodToKnow
                icon="mdi:cash-refund"
                title="Refunds"
                value={
                  isRefundable
                    ? `Refundable for ${Math.round(REFUND_PERIOD_MS / 86_400_000)} days after the event ends (3% fee non-refundable)`
                    : "Non-refundable"
                }
              />
              <GoodToKnow icon="ph:coins-bold" title="Payments" value={coinLabels} />
              <GoodToKnow
                icon="ph:arrows-left-right-bold"
                title="Resale"
                value="Peer transfer (Kiosk) — coming soon"
              />
            </div>
          </div>

          {/* Markets — parimutuel prediction markets (Sellout Clock + range).
              Opt-in: the full section renders only once a market exists. While the
              existence query is loading we render NOTHING (no skeleton/flash). When
              none exists, a subtle ghost link lets ANY connected wallet open one —
              clicking it reveals the create cards (EventMarketsScreen, which shows
              its permissionless "Create …" CTAs in the no-market state). A new
              market appears live via refetchMarkets() (passed as onMarketChange). */}
          {marketsLoading ? null : hasMarket || showCreateMarket ? (
            <div className="space-y-3">
              <h2 className="section-label flex items-center gap-1.5">
                <Icon icon="mdi:chart-line" size={14} /> Markets
              </h2>
              <EventMarketsScreen
                eventId={id}
                eventSeq={eventSeq}
                maxTickets={maxTickets}
                onMarketChange={refetchMarkets}
              />
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="self-start text-muted-foreground"
              onClick={() => setShowCreateMarket(true)}
            >
              <Icon icon="mdi:plus" size={15} /> Add a prediction market
            </Button>
          )}

          {/* Reviews — POAP-gated (only attendees who hold this event's POAP can
              post). Shared on-chain: a public Walrus body + a `ReviewPosted`
              anchor (see lib/reviews.ts), queried back here; the gate is a real
              on-chain getOwnedObjects read. */}
          <ReviewsSection
            reviews={reviews}
            averageRating={reviewSummary.avg}
            reviewCount={reviewSummary.count}
            canReview={canReview}
            hasReviewed={alreadyReviewed}
            submitting={submittingReview}
            onSubmit={submitReview}
          />
        </div>

        {/* ---- Sticky ticket panel ---- */}
        <div>
          <Card className="space-y-4" style={{ position: "sticky", top: 24, padding: 16 }}>
            <div>
              <h2 className="section-label flex items-center gap-1.5" style={{ margin: 0 }}>
                <Icon icon="ion:ticket" size={14} /> Tickets
              </h2>
              <div className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
                {soldOut ? (
                  <span style={{ color: "var(--color-danger)" }}>Sold out</span>
                ) : (
                  <>
                    <span style={{ color: "var(--fg1)", fontWeight: 600 }}>{String(remaining)}</span> of{" "}
                    {String(maxTickets)} remaining
                  </>
                )}
              </div>
            </div>

            {/* Tiers from metadata (display only) */}
            {meta?.tiers && meta.tiers.length > 0 && (
              <div className="space-y-1.5">
                {meta.tiers.map((t, i) => (
                  <div
                    key={`${t.name}-${i}`}
                    className="flex items-center justify-between text-[13px]"
                    style={{ color: "var(--fg2)" }}
                  >
                    <span>{t.name}</span>
                    <span className="mono">{t.note ?? ""}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Buy / claim actions — open BuyTicketDialog (connect + submit live there) */}
            {isFree ? (
              <Button className="w-full" disabled={!canPurchase} onClick={openClaim}>
                <Icon icon="ion:ticket" size={16} />
                {!canPurchase ? statusLabel() : addr ? "Claim free ticket" : "Connect to claim"}
              </Button>
            ) : prices.length === 0 ? (
              <Badge variant="outline" role="status">Price not set by organizer</Badge>
            ) : (
              <div className="space-y-2">
                {prices.map((p) => {
                  const ci = coinInfo(p.coinType);
                  const total = totalWithFee(BigInt(p.price));
                  // 016: undefined balance (loading / disconnected) is treated as
                  // affordable so we don't flash-disable; only a confirmed-short
                  // connected wallet is blocked, with a faucet hint.
                  const bal = balancesQ.data ? (balanceByCoin.get(p.coinType) ?? 0n) : undefined;
                  const affordable = canAfford(bal, total);
                  return (
                    <div key={p.coinType} className="space-y-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            className="w-full"
                            disabled={!canPurchase || !affordable}
                            onClick={() => openBuy(p.coinType, BigInt(p.price))}
                          >
                            <Icon icon="ion:ticket" size={16} />
                            {!canPurchase
                              ? statusLabel()
                              : addr
                                ? `Buy · ${fmtAmount(total, ci.decimals)} ${ci.symbol}`
                                : "Connect to buy"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Total incl. 3% fee: {fmtAmount(total, ci.decimals)} {ci.symbol}
                        </TooltipContent>
                      </Tooltip>
                      {Boolean(addr) && !affordable && <InsufficientCoinHint symbol={ci.symbol} />}
                    </div>
                  );
                })}
                <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                  A 3% platform fee is added at checkout.
                </div>
              </div>
            )}

            {now < purchaseStartMs && (
              <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
                Sales open {fmtDate(purchaseStartMs)} at {fmtTime(purchaseStartMs)}.
              </div>
            )}

            {isOrganizer && (
              <Button asChild variant="outline" className="w-full">
                <Link href={`/manage/${id}`}>
                  <Icon icon="material-symbols-light:settings-rounded" size={16} /> Manage event
                </Link>
              </Button>
            )}
          </Card>
        </div>
      </div>

      <BuyTicketDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        payload={buyPayload}
        onSuccess={() => q.refetch()}
      />
    </div>
  );
}
