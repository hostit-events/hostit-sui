"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { fromHex } from "@mysten/sui/utils";
import {
  COINS,
  ENOKI_ENABLED,
  ORGANIZER_CAP_TYPE,
  PACKAGE_ID,
  USDC_COIN_TYPE,
  coinInfo,
  matchesCoinType,
} from "@/lib/config";
import {
  addCheckinSignerTx,
  getFields,
  setAllowSelfCheckinTx,
  setPriceTx,
  withdrawEventBalanceTx,
} from "@/lib/ticketing";
import {
  bucketLabel,
  createRangeMarketTx,
  createSelloutMarketTx,
  parseMarketFields,
  parseRangeFields,
} from "@/lib/predict";
import { useEventMarkets } from "@/lib/markets";
import { useCurrentAccount, useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { catPalette, catGlyph } from "@/lib/data";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { CopilotLauncher } from "@/components/screens/CopilotLauncher";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedEvents,
  PaginatedObjectsResponse,
  QueryEventsParams,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";

// === Inline helpers ===

/** Format smallest-unit bigint into a human amount, trimming trailing zeros. */
function fmtAmount(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

/** Resolve a `type_name` coin string (no 0x, possibly padded) to a known coin type. */
function resolveCoinType(typeName: string): string {
  return COINS.find((c) => matchesCoinType(typeName, c.type))?.type ?? `0x${typeName}`;
}

interface TicketMintedJson {
  event_seq: string | number;
  event_id: string;
  ticket_id: string;
  serial: string | number;
  buyer: string;
  recipient: string;
  coin_type: string;
  total_paid: string | number;
}

interface CheckedInJson {
  event_seq: string | number;
  event_id: string;
  ticket_id: string;
  attendee: string;
  serial: string | number;
}

export function EventManageScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  // --- The event object ---
  const eventQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id,
    options: { showContent: true },
  });
  const f = getFields(eventQ.data ?? {});

  // --- Find the OrganizerCap for THIS event among the connected wallet's caps ---
  const capsQ = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: ORGANIZER_CAP_TYPE },
      options: { showContent: true },
    },
    { enabled: Boolean(addr) },
  );
  const capId = useMemo(() => {
    if (!capsQ.data) return null;
    for (const entry of capsQ.data.data) {
      const cf = getFields(entry);
      if (cf && String(cf.event_id) === id) return entry.data?.objectId ?? null;
    }
    return null;
  }, [capsQ.data, id]);

  // --- Mint log (sales / gross / attendees) for this event ---
  const mintedQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: `${PACKAGE_ID}::market::TicketMinted` }, order: "descending", limit: 50 },
    { staleTime: 30_000 },
  );
  // --- Check-in log for this event ---
  const checkedQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: `${PACKAGE_ID}::checkin::CheckedIn` }, order: "descending", limit: 50 },
    { staleTime: 30_000 },
  );

  // --- Walrus metadata (category, venue, city, cover, description) ---
  const uri = f ? String(f.uri ?? "") : "";
  const [meta, setMeta] = useState<EventMetadata | null>(null);
  useEffect(() => {
    let alive = true;
    if (uri) getEventMetadata(uri).then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [uri]);

  // Derived rows scoped to this event.
  const eventSeq = f ? String(f.event_seq) : "";
  const mints = useMemo(() => {
    if (!mintedQ.data) return [] as TicketMintedJson[];
    return mintedQ.data.data
      .map((e) => e.parsedJson as TicketMintedJson)
      .filter((p) => p.event_id === id || String(p.event_seq) === eventSeq);
  }, [mintedQ.data, id, eventSeq]);
  const checkins = useMemo(() => {
    if (!checkedQ.data) return [] as CheckedInJson[];
    return checkedQ.data.data
      .map((e) => e.parsedJson as CheckedInJson)
      .filter((p) => p.event_id === id || String(p.event_seq) === eventSeq);
  }, [checkedQ.data, id, eventSeq]);

  // Gross per coin (sum of total_paid grouped by coin type).
  const grossByCoin = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const p of mints) {
      const ct = resolveCoinType(p.coin_type);
      m.set(ct, (m.get(ct) ?? 0n) + BigInt(p.total_paid ?? 0));
    }
    return m;
  }, [mints]);

  // Withdraw + self-check-in toggle are both on the sponsor allowlist, so gas is
  // sponsored when Enoki is on — organizers never need SUI.
  async function send(tx: Transaction, after?: () => void) {
    try {
      const out =
        ENOKI_ENABLED && addr
          ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
          : await regular.mutateAsync({ transaction: tx });
      toast.success("Transaction submitted", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      eventQ.refetch();
      after?.();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  const [copied, setCopied] = useState(false);

  // === Gating / loading / error ===
  if (!addr) {
    return (
      <div className="space-y-6 screen-in">
        <Card className="p-5">
          <div className="font-semibold">Connect your wallet</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            The organizer cockpit needs the wallet that holds this event&apos;s OrganizerCap.
          </p>
        </Card>
      </div>
    );
  }
  if (eventQ.isLoading || capsQ.isLoading) {
    return <Card className="mono screen-in p-5">Loading event…</Card>;
  }
  if (!f) {
    return (
      <Card className="screen-in p-5">
        <div className="font-semibold">Event not found</div>
        <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
          <span className="mono">{id.slice(0, 14)}…</span> didn&apos;t resolve to an Event object.
        </p>
      </Card>
    );
  }
  if (capsQ.isError) {
    return (
      <div className="space-y-5 screen-in">
        <Card className="p-5">
          <div className="font-semibold">Could not load your organizer permissions</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            We couldn&apos;t check whether this wallet holds the OrganizerCap for this event.
          </p>
          <div className="flex gap-2" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <Button size="sm" onClick={() => capsQ.refetch()}>
              <Icon icon="ic:round-refresh" size={16} /> Retry
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/event/${id}`}>
                <Icon icon="ic:round-explore" size={16} /> View public page
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }
  if (!capId) {
    return (
      <div className="space-y-5 screen-in">
        <Card className="p-5">
          <span className="eyebrow">
            <Icon icon="material-symbols:lock-outline" size={14} /> Restricted
          </span>
          <h2 className="page-title" style={{ marginTop: 12, fontSize: 26 }}>
            Not your event
          </h2>
          <p className="page-sub">
            This wallet doesn&apos;t hold the OrganizerCap for{" "}
            <span className="mono">{id.slice(0, 12)}…</span>. Only the organizer can manage it.
          </p>
          <div className="flex gap-2" style={{ marginTop: 16, flexWrap: "wrap" }}>
            <Button asChild variant="outline">
              <Link href={`/event/${id}`}>
                <Icon icon="ic:round-explore" size={16} /> View public page
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/discover">Back to discover</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // === Event facts ===
  const name = String(f.name);
  const minted = BigInt((f.minted as string) ?? "0");
  const maxTickets = BigInt((f.max_tickets as string) ?? "0");
  const startMs = Number(f.start_ms);
  const endMs = Number(f.end_ms);
  const purchaseStartMs = Number(f.purchase_start_ms);
  const isFree = Boolean(f.is_free);
  const isRefundable = Boolean(f.is_refundable);
  const allowSelf = Boolean(f.allow_self_checkin);

  const now = Date.now();
  const pct = maxTickets > 0n ? Number((minted * 100n) / maxTickets) : 0;
  const checkedInCount = checkins.length;

  let status: string;
  let statusVariant: "default" | "secondary" | "outline";
  if (now > endMs) {
    status = "Ended";
    statusVariant = "outline";
  } else if (now >= startMs) {
    status = "Live";
    statusVariant = "default";
  } else if (now >= purchaseStartMs) {
    status = "On sale";
    statusVariant = "default";
  } else {
    status = "Upcoming";
    statusVariant = "secondary";
  }

  const cat = meta?.category;
  const [p1, p2] = catPalette(cat);
  const glyphIcon = catGlyph(cat);
  const dateLabel = `${new Date(startMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })} – ${new Date(endMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  // Primary gross label for the stat tile + copilot context.
  const grossEntries = Array.from(grossByCoin.entries());
  const grossLabel =
    grossEntries.length === 0
      ? isFree
        ? "Free"
        : "—"
      : grossEntries
          .map(([ct, v]) => {
            const ci = coinInfo(ct);
            return `${fmtAmount(v, ci.decimals)} ${ci.symbol}`;
          })
          .join(" · ");

  const publicUrl =
    typeof window !== "undefined" ? `${window.location.origin}/event/${id}` : `/event/${id}`;

  // Context handed to the AI co-pilot (live numbers only).
  const copilotEvent = {
    name,
    status,
    date: dateLabel,
    city: meta?.city,
    venue: meta?.venue,
    category: cat,
    sold: Number(minted),
    cap: Number(maxTickets),
    pct,
    revenue: grossLabel,
    priceLabel: grossEntries.length ? grossLabel : isFree ? "Free" : "Not set",
  };

  return (
    <div className="space-y-8 screen-in">
      {/* === Header (gradient poster + identity) === */}
      <Card className="relative gap-0 p-0 overflow-hidden">
        <div
          className="poster"
          style={
            {
              height: 200,
              ["--p1" as string]: p1,
              ["--p2" as string]: p2,
            } as React.CSSProperties
          }
        >
          <div className="poster-noise" />
          <span className="poster-glyph">
            <Icon icon={glyphIcon} size={96} />
          </span>
        </div>
        <div style={{ padding: "18px 22px 22px" }} className="space-y-3">
          <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
            <Badge variant={statusVariant}>{status}</Badge>
            {isFree && <Badge variant="secondary">Free</Badge>}
            {isRefundable && <Badge variant="secondary">Refundable</Badge>}
            {meta?.tag && <Badge variant="outline">{meta.tag}</Badge>}
          </div>
          <h1 className="page-title" style={{ fontSize: 30 }}>
            {name}
          </h1>
          <div className="flex items-center gap-4 text-[13px]" style={{ color: "var(--fg3)", flexWrap: "wrap" }}>
            <span className="flex items-center gap-1.5">
              <Icon icon="proicons:calendar" size={14} /> {dateLabel}
            </span>
            {(meta?.venue || meta?.city) && (
              <span className="flex items-center gap-1.5">
                <Icon icon="carbon:location" size={14} />
                {[meta?.venue, meta?.city].filter(Boolean).join(" · ")}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Icon icon="solar:user-rounded-bold" size={14} />
              <AddressDisplay address={String(f.organizer)} suffix={4} />
            </span>
          </div>
          <div className="flex gap-2" style={{ flexWrap: "wrap", marginTop: 4 }}>
            <Button asChild variant="outline" size="sm">
              <Link href="/checkin">
                <Icon icon="zondicons:inbox-check" size={15} /> Check-in
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/door/${id}`}>
                <Icon icon="material-symbols:door-front-outline" size={15} /> Door view
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/forum/${id}`}>
                <Icon icon="ion:chatbubbles" size={15} /> Event chat
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/event/${id}`}>
                <Icon icon="ic:round-explore" size={15} /> View public page
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(publicUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard unavailable */
                }
              }}
            >
              <Icon icon="solar:copy-linear" size={15} /> {copied ? "Copied!" : "Copy link"}
            </Button>
          </div>
        </div>
      </Card>

      {/* === Stat tiles === */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="stat-tile fill">
          <div className="stat-num" style={{ color: "#fff" }}>
            {String(minted)}
            <span style={{ fontSize: 18, opacity: 0.7 }}>/{String(maxTickets)}</span>
          </div>
          <div className="stat-label" style={{ color: "rgba(255,255,255,.78)" }}>
            Tickets sold
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{grossEntries.length ? grossLabel : isFree ? "Free" : "—"}</div>
          <div className="stat-label">Gross sales (recent)</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{checkedInCount}</div>
          <div className="stat-label">Checked in (recent)</div>
        </div>
      </div>
      <p className="text-[11px]" style={{ color: "var(--fg3)", marginTop: -16 }}>
        Gross sales and check-ins are tallied from the 50 most recent on-chain logs, not the full
        history. On-chain escrow isn&apos;t exposed as a readable field — withdraw to settle.
      </p>

      {/* === Capacity bar === */}
      <Card className="space-y-2 p-5">
        <div className="flex items-center justify-between text-sm">
          <span className="section-label" style={{ color: "var(--fg2)" }}>
            Capacity
          </span>
          <span className="mono">
            {String(minted)}/{String(maxTickets)} · {pct}%
          </span>
        </div>
        <div
          style={{
            height: 10,
            borderRadius: 999,
            background: "rgba(255,255,255,.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, pct)}%`,
              height: "100%",
              background: `linear-gradient(90deg, ${p1}, ${p2})`,
              transition: "width .3s ease",
            }}
          />
        </div>
      </Card>

      {/* === Payout panel === */}
      <section className="space-y-4">
        <div>
          <span className="eyebrow">
            <Icon icon="solar:wallet-money-bold" size={14} /> Payouts
          </span>
          <h2 className="page-title" style={{ marginTop: 12, fontSize: 22 }}>
            Withdraw revenue
          </h2>
          <p className="page-sub">
            Settle accrued balances to your wallet. Refundable events: only after the post-event
            refund window.
          </p>
        </div>
        <Card className="space-y-3 p-5">
          {isFree ? (
            <div className="text-sm" style={{ color: "var(--fg2)" }}>
              This is a free event — there are no balances to withdraw.
            </div>
          ) : (
            <div className="space-y-2">
              {COINS.map((c) => {
                const gross = grossByCoin.get(c.type) ?? 0n;
                const noGross = gross === 0n;
                return (
                  <div
                    key={c.type}
                    className="flex items-center justify-between gap-3"
                    style={{ padding: "10px 0", borderBottom: "1px solid var(--hair)" }}
                  >
                    <div>
                      <div className="font-medium">{c.symbol}</div>
                      <div className="mono" style={{ fontSize: 12, color: "var(--fg3)" }}>
                        {fmtAmount(gross, c.decimals)} {c.symbol} grossed
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="sm"
                          disabled={isPending || noGross}
                          onClick={() =>
                            send(
                              withdrawEventBalanceTx({
                                capId,
                                eventId: id,
                                coinType: c.type,
                                recipient: addr,
                              }),
                            )
                          }
                        >
                          <Icon icon="solar:download-minimalistic-bold" size={15} /> Withdraw {c.symbol}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {noGross
                          ? `No recent ${c.symbol} sales to withdraw`
                          : `Withdraw all accrued ${c.symbol} to ${addr}`}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                );
              })}
              <p className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Grossed figures are tallied from recent on-chain logs; the on-chain balance is the
                source of truth for what a withdraw settles.
              </p>
            </div>
          )}
        </Card>
      </section>

      {/* === Controls: pricing + check-in === */}
      <section className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {!isFree && <PricePanel capId={capId} eventId={id} onDone={() => eventQ.refetch()} />}

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium">Self check-in</div>
              <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
                Let holders check themselves in within the event window.
              </div>
            </div>
            <Switch
              aria-label="Self check-in"
              checked={allowSelf}
              disabled={isPending}
              onCheckedChange={() => {
                if (!isPending) send(setAllowSelfCheckinTx({ capId, eventId: id, allow: !allowSelf }));
              }}
            />
          </div>

          <div style={{ borderTop: "1px solid var(--hair)", paddingTop: 14 }}>
            <SignerPanel capId={capId} eventId={id} />
          </div>
        </Card>
      </section>

      {/* === Prediction markets (organizer view: open + pool volume) === */}
      <PredictionMarketsPanel
        eventId={id}
        eventSeq={eventSeq}
        maxTickets={maxTickets}
        send={send}
        isPending={isPending}
      />

      {/* === Attendees preview === */}
      <section className="space-y-4">
        <div className="flex items-end justify-between gap-2" style={{ flexWrap: "wrap" }}>
          <div>
            <span className="eyebrow">
              <Icon icon="solar:users-group-rounded-bold" size={14} /> Attendees
            </span>
            <h2 className="page-title" style={{ marginTop: 12, fontSize: 22 }}>
              Recent buyers <span style={{ color: "var(--fg3)" }}>({mints.length})</span>
            </h2>
          </div>
        </div>
        {mintedQ.isLoading ? (
          <Card className="mono p-5">Loading attendees…</Card>
        ) : mints.length === 0 ? (
          <Card className="p-5">
            <div className="font-semibold">No tickets yet.</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              Share your event link to start selling.
            </p>
          </Card>
        ) : (
          <Card className="gap-0 py-0" style={{ overflow: "hidden" }}>
            {mints.slice(0, 12).map((m, i) => {
              const ci = coinInfo(resolveCoinType(m.coin_type));
              const isCheckedIn = checkins.some((c) => c.ticket_id === m.ticket_id);
              return (
                <div
                  key={`${m.ticket_id}-${i}`}
                  className="flex items-center justify-between gap-3"
                  style={{
                    padding: "12px 18px",
                    borderBottom: i < Math.min(mints.length, 12) - 1 ? "1px solid var(--hair)" : "none",
                  }}
                >
                  <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                    <Badge variant="secondary" className="mono">#{String(m.serial)}</Badge>
                    <AddressDisplay address={m.recipient} suffix={4} />
                  </div>
                  <div className="flex items-center gap-2.5">
                    {BigInt(m.total_paid ?? 0) > 0n ? (
                      <span className="mono" style={{ fontSize: 13, color: "var(--fg2)" }}>
                        {fmtAmount(BigInt(m.total_paid), ci.decimals)} {ci.symbol}
                      </span>
                    ) : (
                      <Badge variant="outline">Free</Badge>
                    )}
                    {isCheckedIn && <Badge variant="default">In</Badge>}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      {/* === AI Co-pilot (always-accessible floating launcher) === */}
      <CopilotLauncher event={copilotEvent} />
    </div>
  );
}

// === Prediction markets (organizer view) ===

// USDC pool volume formatter (collateral defaults to testnet USDC, 6 decimals).
const usdcInfo = coinInfo(USDC_COIN_TYPE);

// Default cutoffs for a fresh range market: quartiles of maxTickets. N=4 cutoffs
// -> 5 buckets. Cutoffs must be strictly increasing; with a tiny maxTickets the
// naive quartiles can collide (e.g. max=2 -> [0,1,1,2]), so we dedup+sort and
// fall back to a single midpoint cutoff if everything collapses. (Mirrors the
// defaultCutoffs in EventMarketsScreen; kept local since it isn't exported.)
function defaultCutoffs(maxTickets: bigint): bigint[] {
  if (maxTickets <= 0n) return [1n];
  const raw = [maxTickets / 4n, maxTickets / 2n, (3n * maxTickets) / 4n, maxTickets];
  const positive = raw.filter((c) => c > 0n);
  const uniqueSorted = Array.from(new Set(positive.map((c) => c.toString())))
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (uniqueSorted.length === 0) return [maxTickets > 1n ? maxTickets / 2n : 1n];
  return uniqueSorted;
}

/**
 * Organizer-facing prediction-markets section: surfaces the two parimutuel
 * markets attached to this event (the binary "Sellout Clock" and the N+1 bucket
 * "Final tickets sold" range market). If a kind has no market yet, the organizer
 * can open one (permissionless on-chain, but offered here as a convenience);
 * once a market exists we read its live pool volume via getObject -> parse.
 * Full betting/settle/claim lives on the public event page (EventMarketsScreen);
 * this panel is read + open only. Submits through the screen's sponsored `send`.
 */
function PredictionMarketsPanel({
  eventId,
  eventSeq,
  maxTickets,
  send,
  isPending,
}: {
  eventId: string;
  eventSeq: string;
  maxTickets: bigint;
  send: (tx: Transaction, after?: () => void) => Promise<void>;
  isPending: boolean;
}) {
  const { selloutMarketId, rangeMarketId, loading, refetch } = useEventMarkets(eventSeq);
  const cutoffs = useMemo(() => defaultCutoffs(maxTickets), [maxTickets]);

  // Live pool reads (only when a market of that kind exists).
  const selloutQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id: selloutMarketId ?? "", options: { showContent: true } },
    { enabled: Boolean(selloutMarketId), staleTime: 15_000 },
  );
  const rangeQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id: rangeMarketId ?? "", options: { showContent: true } },
    { enabled: Boolean(rangeMarketId), staleTime: 15_000 },
  );

  const sellout = useMemo(
    () => (selloutQ.data ? parseMarketFields(selloutQ.data) : null),
    [selloutQ.data],
  );
  const range = useMemo(
    () => (rangeQ.data ? parseRangeFields(rangeQ.data) : null),
    [rangeQ.data],
  );

  const selloutPool = sellout ? sellout.totalYes + sellout.totalNo : 0n;
  const rangePool = range ? range.totals.reduce((a, b) => a + b, 0n) : 0n;

  // Refetch the discovery logs + the relevant object after a create succeeds.
  const afterCreate = () => refetch();

  return (
    <section className="space-y-4">
      <div>
        <span className="eyebrow">
          <Icon icon="mdi:chart-line" size={14} /> Prediction markets
        </span>
        <h2 className="page-title" style={{ marginTop: 12, fontSize: 22 }}>
          Sellout & final-sales markets
        </h2>
        <p className="page-sub">
          Open parimutuel markets on your event&apos;s sales so attendees can bet on the outcome.
          These pools settle on-chain from the minted count — they don&apos;t touch your revenue.
          Betting, settling and claiming live on the{" "}
          <Link href={`/event/${eventId}`} style={{ color: "var(--hi-blue)" }}>
            public event page
          </Link>
          .
        </p>
      </div>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
      >
        {/* --- Sellout Clock --- */}
        <Card className="space-y-3 p-5">
          <div className="flex items-center gap-2">
            <Icon icon="mdi:timer-sand" size={16} style={{ color: "var(--fg2)" }} />
            <div className="font-medium">Sellout Clock</div>
          </div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            Will this event reach {String(maxTickets)} tickets before doors?
          </div>
          {loading ? (
            <div className="mono text-sm" style={{ color: "var(--fg2)" }}>
              Loading…
            </div>
          ) : selloutMarketId && selloutQ.isError ? (
            <div className="space-y-2">
              <div className="text-sm" style={{ color: "var(--color-danger)" }}>
                Couldn&apos;t load this market&apos;s pool.
              </div>
              <Button variant="outline" size="sm" onClick={() => selloutQ.refetch()}>
                <Icon icon="ic:round-refresh" size={14} /> Retry
              </Button>
            </div>
          ) : selloutMarketId ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: "var(--fg2)" }}>Pool volume</span>
                <span className="mono">
                  {fmtAmount(selloutPool, usdcInfo.decimals)} {usdcInfo.symbol}
                </span>
              </div>
              <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                <Badge variant="default">YES {fmtAmount(sellout?.totalYes ?? 0n, usdcInfo.decimals)}</Badge>
                <Badge variant="outline">NO {fmtAmount(sellout?.totalNo ?? 0n, usdcInfo.decimals)}</Badge>
                {sellout?.settled && (
                  <Badge variant="secondary">
                    {sellout.outcomeYes ? "Sold out" : "Did not sell out"}
                  </Badge>
                )}
              </div>
            </div>
          ) : (
            <>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() => send(createSelloutMarketTx(eventId, USDC_COIN_TYPE), afterCreate)}
              >
                <Icon icon="mdi:timer-sand" size={15} />
                {isPending ? "Opening…" : "Open Sellout Clock"}
              </Button>
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Parimutuel USDC pool, settled on-chain. No effect on ticket revenue.
              </div>
            </>
          )}
        </Card>

        {/* --- Final tickets sold (range) --- */}
        <Card className="space-y-3 p-5">
          <div className="flex items-center gap-2">
            <Icon icon="mdi:chart-bar" size={16} style={{ color: "var(--fg2)" }} />
            <div className="font-medium">Final tickets sold</div>
          </div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            How many tickets will this event ultimately sell?
          </div>
          {loading ? (
            <div className="mono text-sm" style={{ color: "var(--fg2)" }}>
              Loading…
            </div>
          ) : rangeMarketId && range ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: "var(--fg2)" }}>Pool volume</span>
                <span className="mono">
                  {fmtAmount(rangePool, usdcInfo.decimals)} {usdcInfo.symbol}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {range.totals.map((t, i) => (
                  <Badge key={i} variant="outline" className="mono" style={{ fontSize: 11 }}>
                    {bucketLabel(range.cutoffs, i)}: {fmtAmount(t, usdcInfo.decimals)}
                  </Badge>
                ))}
              </div>
              {range.settled && (
                <Badge variant="secondary" className="mono">
                  Winner: {bucketLabel(range.cutoffs, range.winningBucket)}
                </Badge>
              )}
            </div>
          ) : rangeMarketId && rangeQ.isError ? (
            <div className="space-y-2">
              <div className="text-sm" style={{ color: "var(--color-danger)" }}>
                Couldn&apos;t load this market&apos;s pool.
              </div>
              <Button variant="outline" size="sm" onClick={() => rangeQ.refetch()}>
                <Icon icon="ic:round-refresh" size={14} /> Retry
              </Button>
            </div>
          ) : rangeMarketId ? (
            <div className="mono text-sm" style={{ color: "var(--fg2)" }}>
              Loading…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: cutoffs.length + 1 }, (_, i) => (
                  <Badge key={i} variant="outline" className="mono" style={{ fontSize: 11 }}>
                    {bucketLabel(cutoffs, i)}
                  </Badge>
                ))}
              </div>
              <Button
                size="sm"
                disabled={isPending}
                onClick={() =>
                  send(createRangeMarketTx(eventId, USDC_COIN_TYPE, cutoffs), afterCreate)
                }
              >
                <Icon icon="mdi:chart-bar" size={15} />
                {isPending ? "Opening…" : "Open final-sales market"}
              </Button>
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Ranges default to quartiles of {String(maxTickets)} max tickets. Settled on-chain.
              </div>
            </>
          )}
        </Card>
      </div>
    </section>
  );
}

// === Price control (per-coin) ===
function PricePanel({
  capId,
  eventId,
  onDone,
}: {
  capId: string;
  eventId: string;
  onDone: () => void;
}) {
  const account = useCurrentAccount();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [coin, setCoin] = useState(COINS[0].type);
  const [priceStr, setPriceStr] = useState("1");

  // Parse the decimal string into smallest-unit bigint without float rounding.
  // Returns null on malformed input or excess fractional digits.
  function priceUnits(): bigint | null {
    const dec = coinInfo(coin).decimals;
    const s = priceStr.trim();
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
    const [whole, frac = ""] = s.split(".");
    if (frac.length > dec) return null; // more precision than the coin supports
    const padded = frac.padEnd(dec, "0");
    return BigInt(whole || "0") * 10n ** BigInt(dec) + BigInt(padded || "0");
  }

  async function submit() {
    const dec = coinInfo(coin).decimals;
    const units = priceUnits();
    if (units === null) {
      toast.error(`Enter a valid price with at most ${dec} decimal places.`);
      return;
    }
    if (units <= 0n) {
      toast.error("Enter a price greater than zero.");
      return;
    }
    const addr = account?.address;
    if (!addr) {
      toast.error("Connect a wallet to set a price.");
      return;
    }
    try {
      const tx = setPriceTx({ capId, eventId, coinType: coin, price: units });
      // set_price is on the sponsor allowlist — sponsor gas so organizers
      // without SUI can price events (mirrors create_event).
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Price updated", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      onDone();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div>
        <div className="font-medium">Set price</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Buyers pay this plus a 3% platform fee.
        </div>
      </div>
      <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
        <div className="space-y-1.5">
          <Label>Coin</Label>
          <Select
            value={coin}
            onValueChange={(v) => {
              setCoin(v);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COINS.map((c) => (
                <SelectItem key={c.type} value={c.type}>
                  {c.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grow space-y-1.5">
          <Label>Price ({coinInfo(coin).symbol})</Label>
          <Input
            type="number"
            min={0}
            step={(10 ** -coinInfo(coin).decimals).toFixed(coinInfo(coin).decimals)}
            value={priceStr}
            onChange={(e) => {
              setPriceStr(e.target.value);
            }}
          />
        </div>
        <Button disabled={isPending} onClick={submit}>
          {isPending ? "Setting…" : "Set price"}
        </Button>
      </div>
    </Card>
  );
}

// === Add check-in signer (ed25519 pubkey, hex) ===
function SignerPanel({ capId, eventId }: { capId: string; eventId: string }) {
  const account = useCurrentAccount();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [hex, setHex] = useState("");

  async function add() {
    const clean = hex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length === 0) {
      toast.error("Enter a hex-encoded ed25519 public key.");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = fromHex(clean);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Invalid hex.");
      return;
    }
    if (bytes.length !== 32) {
      toast.error(`Public key must be 32 bytes (got ${bytes.length}).`);
      return;
    }
    const addr = account?.address;
    if (!addr) {
      toast.error("Connect a wallet to add a signer.");
      return;
    }
    try {
      const tx = addCheckinSignerTx({ capId, eventId, pubkey: Array.from(bytes) });
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Signer added", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      setHex("");
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <div className="space-y-2">
      <div className="font-medium">Add check-in signer</div>
      <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
        Authorize a staff device&apos;s ed25519 public key (32 bytes, hex) to issue entry vouchers.
      </div>
      <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 200 }}>
          <Input
            className="mono"
            placeholder="0x… (64 hex chars)"
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
            }}
          />
        </div>
        <Button disabled={isPending} onClick={add}>
          {isPending ? "Adding…" : "Add signer"}
        </Button>
      </div>
    </div>
  );
}
