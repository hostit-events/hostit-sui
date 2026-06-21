"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { fromHex, toHex, fromBase64 } from "@mysten/sui/utils";
import { useQuery } from "@tanstack/react-query";
import {
  COINS,
  EMAIL_ENABLED,
  ENOKI_ENABLED,
  NETWORK,
  ORGANIZER_CAP_TYPE,
  PACKAGE_ID,
  REFUND_PERIOD_MS,
  USDC_COIN_TYPE,
  coinInfo,
  fmtAmount,
  matchesCoinType,
  toUnits,
} from "@/lib/config";
import {
  addCheckinSignerTx,
  getFields,
  readEventCoinStats,
  removeCheckinSignerTx,
  removePriceTx,
  setAllowSelfCheckinTx,
  setCancelledTx,
  setIsFreeTx,
  setIsRefundableTx,
  setPoapEnabledTx,
  setPriceTx,
  updateEndTimeTx,
  updateMaxPerUserTx,
  updateMaxTicketsTx,
  updateMetadataTx,
  updateTimesTx,
  withdrawEventBalanceTx,
  type CoinStats,
} from "@/lib/ticketing";
import {
  bucketLabel,
  createRangeMarketTx,
  createSelloutMarketTx,
  parseMarketFields,
  parseRangeFields,
} from "@/lib/predict";
import { encryptForumMessage, forumPostAsOrganizerTx } from "@/lib/forum";
import { averageRating, listReviews } from "@/lib/reviews";
import { EV_EMAIL_GRANT_CREATED } from "@/lib/identity";
import { createSessionKey } from "@/lib/seal";
import { useSignPersonalMessage, decryptAttendeeEmail } from "@/lib/emailBinding";
import type { ProfileEnvelope } from "@/lib/profile";
import { useAllEvents } from "@/lib/events";
import { useEventMarkets } from "@/lib/markets";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { getEventMetadata, putEventMetadata, type EventMetadata } from "@/lib/metadata";
import { storeFile, readJson } from "@/lib/walrus";
import { CATEGORIES, catPalette, catGlyph } from "@/lib/data";
import {
  STAGE_LABEL,
  STAGE_ORDER,
  lifecycleStage,
  stageIndex,
  useNow,
  type LifecycleStage,
} from "@/lib/lifecycle";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { Copy } from "@/components/animate-ui/icons/copy";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";
import { TxLink } from "@/components/TxLink";
import { CapacityRing } from "@/components/CapacityRing";
import { CopilotLauncher } from "@/components/screens/CopilotLauncher";
import { DateTimePicker } from "@/components/DateTimePicker";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
  PaginatedObjectsResponse,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";

// === Inline helpers ===

/** Resolve a `type_name` coin string (no 0x, possibly padded) to a known coin type. */
function resolveCoinType(typeName: string): string {
  return COINS.find((c) => matchesCoinType(typeName, c.type))?.type ?? `0x${typeName}`;
}

/** SuiVision object URL (mainnet has no subdomain). */
function objectUrl(id: string): string {
  const sub = NETWORK === "mainnet" ? "" : `${NETWORK}.`;
  return `https://${sub}suivision.xyz/object/${id}`;
}

/**
 * Parse the Event's `checkin_signers` VecSet<vector<u8>> field into normalized
 * pubkeys. ponytail: the on-chain JSON shape of a populated `vector<u8>` element
 * isn't observable on testnet today (no event has signers yet), so we accept the
 * realistic encodings (number[], base64, hex) and normalize to 32 bytes; revoke
 * passes the same bytes back. Empty sets render fine regardless.
 */
function parseSignerPubkeys(field: unknown): { hex: string; bytes: number[] }[] {
  const f = field as { fields?: { contents?: unknown[] }; contents?: unknown[] } | undefined;
  const contents = f?.fields?.contents ?? f?.contents;
  if (!Array.isArray(contents)) return [];
  const out: { hex: string; bytes: number[] }[] = [];
  for (const el of contents) {
    let bytes: number[] | null = null;
    if (Array.isArray(el)) bytes = el.map(Number);
    else if (typeof el === "string") {
      try {
        bytes = Array.from(fromBase64(el));
      } catch {
        try {
          bytes = Array.from(fromHex(el.replace(/^0x/i, "")));
        } catch {
          bytes = null;
        }
      }
    }
    if (bytes && bytes.length === 32) out.push({ hex: toHex(Uint8Array.from(bytes)), bytes });
  }
  return out;
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

/** Shared submit + on-chain context passed to deck cards. */
interface DeckCtx {
  capId: string;
  eventId: string;
  addr: string;
  isPending: boolean;
  send: (tx: Transaction, after?: () => void) => Promise<void>;
  refetch: () => void;
}

export function EventManageScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const now = useNow();

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

  // --- On-chain activity logs for the telemetry stream (mints + check-ins) ---
  const mintedQ = useAllEvents(`${PACKAGE_ID}::market::TicketMinted`);
  const checkedQ = useAllEvents(`${PACKAGE_ID}::checkin::CheckedIn`);

  // --- Per-coin escrow + lifetime accounting (devInspect; dynamic-field reads) ---
  const client = useCurrentClient() as unknown as Parameters<typeof readEventCoinStats>[0];
  const statsQ = useQuery<Record<string, CoinStats>, Error>({
    queryKey: ["eventCoinStats", id, addr],
    enabled: Boolean(addr),
    staleTime: 15_000,
    queryFn: async () => {
      const out: Record<string, CoinStats> = {};
      for (const c of COINS) out[c.type] = await readEventCoinStats(client, id, c.type, addr!);
      return out;
    },
  });

  // --- Reviews summary (Wrapped) ---
  const reviewClient = useCurrentClient() as unknown as Parameters<typeof listReviews>[0];
  const reviewsQ = useQuery({
    queryKey: ["manageReviews", id],
    staleTime: 60_000,
    queryFn: () => listReviews(reviewClient, id),
  });

  // --- Walrus metadata (category, venue, city, cover, description, poap) ---
  const uri = f ? String(f.uri ?? "") : "";
  const [meta, setMeta] = useState<EventMetadata | null>(null);
  useEffect(() => {
    let alive = true;
    if (uri) getEventMetadata(uri).then((m) => alive && setMeta(m));
    return () => {
      alive = false;
    };
  }, [uri]);

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
  const tallyTruncated = Boolean(mintedQ.data?.truncated || checkedQ.data?.truncated);

  // Submit helper: sponsor gas when Enoki is on, else sign directly.
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
      statsQ.refetch();
      after?.();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  const [copied, setCopied] = useState(false);

  // === Gating / loading / error (preserved) ===
  if (!addr) {
    return (
      <div className="space-y-6 screen-in">
        <Card className="p-5">
          <div className="font-semibold">Connect your wallet</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            The command center needs the wallet that holds this event&apos;s OrganizerCap.
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
              <RefreshCw size={16} animate={capsQ.isFetching} loop /> Retry
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
  const isCancelled = Boolean(f.is_cancelled);
  const poapEnabled = Boolean(f.poap_enabled);
  const checkedInCount = Number(f.checked_in_count ?? 0);
  const poapClaimedCount = Number(f.poap_claimed_count ?? 0);

  const stage = lifecycleStage({ purchaseStartMs, startMs, endMs }, now);

  const cat = meta?.category;
  const [p1, p2] = catPalette(cat);
  const glyphIcon = catGlyph(cat);

  const publicUrl =
    typeof window !== "undefined" ? `${window.location.origin}/event/${id}` : `/event/${id}`;

  const reviewSummary = averageRating(reviewsQ.data ?? []);

  const ctx: DeckCtx = {
    capId,
    eventId: id,
    addr,
    isPending,
    send,
    refetch: () => {
      eventQ.refetch();
      statsQ.refetch();
    },
  };

  // Context handed to the AI co-pilot (live numbers only).
  const copilotEvent = {
    name,
    status: STAGE_LABEL[stage] + (isCancelled ? " · Cancelled" : ""),
    date: `${new Date(startMs).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })} – ${new Date(endMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    city: meta?.city,
    venue: meta?.venue,
    category: cat,
    sold: Number(minted),
    cap: Number(maxTickets),
    pct: maxTickets > 0n ? Number((minted * 100n) / maxTickets) : 0,
    checkedIn: checkedInCount,
    stage,
    cancelled: isCancelled,
  };

  return (
    <div className="screen-in" style={{ display: "grid", gap: 20 }}>
      {/* === Identity + provenance header === */}
      <Card className="relative gap-0 p-0 overflow-hidden">
        <div
          className="poster"
          style={{ height: 120, ["--p1" as string]: p1, ["--p2" as string]: p2 } as React.CSSProperties}
        >
          <div className="poster-noise" />
          <span className="poster-glyph">
            <Icon icon={glyphIcon} size={64} />
          </span>
        </div>
        <div style={{ padding: "16px 20px 18px" }} className="space-y-3">
          <div className="flex items-center justify-between gap-3" style={{ flexWrap: "wrap" }}>
            <div className="min-w-0">
              <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                <Badge variant={isCancelled ? "destructive" : "default"}>
                  {isCancelled ? "Cancelled" : STAGE_LABEL[stage]}
                </Badge>
                {isFree && <Badge variant="secondary">Free</Badge>}
                {isRefundable && <Badge variant="secondary">Refundable</Badge>}
              </div>
              <h1 className="page-title" style={{ fontSize: 26, marginTop: 8 }}>
                {name}
              </h1>
              <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg3)", marginTop: 6, flexWrap: "wrap" }}>
                <ProvenanceChip label="Event" id={id} />
                <ProvenanceChip label="Cap" id={capId} />
              </div>
            </div>
            <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
              <Button asChild variant="outline" size="sm">
                <Link href={`/event/${id}`}>
                  <Icon icon="ic:round-explore" size={15} /> Public page
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
                {copied ? <Icon icon="ic:round-check" size={15} /> : <Copy size={15} animateOnHover />}{" "}
                {copied ? "Copied!" : "Share"}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {isCancelled && (
        <Card className="p-4" style={{ border: "1px solid var(--color-danger)", background: "rgba(239,68,68,.06)" }}>
          <div className="flex items-center gap-2 font-semibold" style={{ color: "var(--color-danger)" }}>
            <Icon icon="material-symbols:cancel-outline" size={18} /> This event is cancelled
          </div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            Sales and withdrawals are closed. Every ticket holder can refund their ticket now from
            their wallet — escrow is reserved for them. You can un-cancel below.
          </p>
        </Card>
      )}

      {/* === Command center: stage rail + deck === */}
      <div className="grid gap-5 items-start lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-4">
          <StageRail current={stage} eventName={name} />
        </div>
        <div style={{ display: "grid", gap: 20 }}>
          {/* Capacity hero */}
          <Card className="p-5">
            <div className="flex items-center gap-5" style={{ flexWrap: "wrap" }}>
              <CapacityRing
                minted={Number(minted)}
                max={Number(maxTickets)}
                checkedIn={stage === "doorsOpen" || stage === "wrapped" ? checkedInCount : undefined}
                p1={p1}
                p2={p2}
              />
              <div className="space-y-2.5" style={{ flex: 1, minWidth: 200 }}>
                <a
                  href={objectUrl(id)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ fontSize: 11, color: "var(--fg3)" }}
                >
                  event.minted() ↗
                </a>
                <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))" }}>
                  <MiniStat label="Minted" value={`${minted}/${maxTickets}`} />
                  <MiniStat label="Checked in" value={String(checkedInCount)} />
                  {!isFree && (
                    <MiniStat
                      label="Escrow"
                      value={statsQ.isLoading ? "…" : escrowLabel(statsQ.data)}
                    />
                  )}
                  {poapEnabled && poapClaimedCount > 0 && (
                    <MiniStat label="POAPs" value={String(poapClaimedCount)} />
                  )}
                </div>
              </div>
            </div>
          </Card>

          {/* Stage-specific deck */}
          {(stage === "drafting" || stage === "onSale") && (
            <>
              {!isFree && <PricePanel ctx={ctx} stats={statsQ.data} />}
              <EditEventPanel
                capId={capId}
                eventId={id}
                meta={meta}
                currentName={name}
                currentSymbol={String(f.symbol ?? "")}
                currentUri={uri}
                startMs={startMs}
                endMs={endMs}
                purchaseStartMs={purchaseStartMs}
                maxTickets={maxTickets}
                minted={minted}
                maxPerUser={BigInt((f.max_per_user as string) ?? "0")}
                isFree={isFree}
                isRefundable={isRefundable}
                onDone={ctx.refetch}
              />
              <FreeRefundablePanel
                ctx={ctx}
                isFree={isFree}
                isRefundable={isRefundable}
                minted={minted}
              />
              <DoorPrepPanel ctx={ctx} signersField={f.checkin_signers} allowSelf={allowSelf} />
              <PoapPanel
                ctx={ctx}
                meta={meta}
                poapEnabled={poapEnabled}
                claimed={poapClaimedCount}
                currentName={name}
                currentSymbol={String(f.symbol ?? "")}
              />
              {stage === "onSale" && (
                <PredictionMarketsPanel
                  eventId={id}
                  eventSeq={eventSeq}
                  maxTickets={maxTickets}
                  send={send}
                  isPending={isPending}
                />
              )}
            </>
          )}

          {stage === "doorsOpen" && (
            <>
              <DoorModeCard eventId={id} />
              <DoorPrepPanel ctx={ctx} signersField={f.checkin_signers} allowSelf={allowSelf} />
              <EndTimePanel ctx={ctx} startMs={startMs} endMs={endMs} />
              <PoapPanel
                ctx={ctx}
                meta={meta}
                poapEnabled={poapEnabled}
                claimed={poapClaimedCount}
                currentName={name}
                currentSymbol={String(f.symbol ?? "")}
              />
              <PredictionMarketsPanel
                eventId={id}
                eventSeq={eventSeq}
                maxTickets={maxTickets}
                send={send}
                isPending={isPending}
              />
            </>
          )}

          {stage === "wrapped" && (
            <>
              {!isFree && (
                <MoneyPanel
                  ctx={ctx}
                  stats={statsQ.data}
                  loading={statsQ.isLoading}
                  isError={statsQ.isError}
                  isRefundable={isRefundable}
                  isCancelled={isCancelled}
                  endMs={endMs}
                  now={now}
                  withWithdraw
                />
              )}
              <PoapPanel
                ctx={ctx}
                meta={meta}
                poapEnabled={poapEnabled}
                claimed={poapClaimedCount}
                currentName={name}
                currentSymbol={String(f.symbol ?? "")}
              />
              <ReviewsSummaryPanel summary={reviewSummary} loading={reviewsQ.isLoading} eventId={id} />
              <OrganizerRecapPanel ctx={ctx} />
              <PredictionMarketsPanel
                eventId={id}
                eventSeq={eventSeq}
                maxTickets={maxTickets}
                send={send}
                isPending={isPending}
              />
            </>
          )}

          {/* Money peek (read-only) before wrapping */}
          {!isFree && stage !== "wrapped" && stage !== "drafting" && (
            <MoneyPanel
              ctx={ctx}
              stats={statsQ.data}
              loading={statsQ.isLoading}
              isError={statsQ.isError}
              isRefundable={isRefundable}
              isCancelled={isCancelled}
              endMs={endMs}
              now={now}
              withWithdraw={false}
            />
          )}

          {/* Telemetry stream */}
          <TelemetryStream
            mints={mints}
            checkins={checkins}
            loading={mintedQ.isLoading}
            truncated={tallyTruncated}
            publicUrl={publicUrl}
          />

          {/* Opted-in attendee emails (GH#96) */}
          <AttendeeEmailsCard ctx={ctx} />

          {/* Danger zone */}
          <CancelZone ctx={ctx} isCancelled={isCancelled} />
        </div>
      </div>

      <CopilotLauncher event={copilotEvent} />
    </div>
  );
}

// === Small presentational helpers ===

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold" style={{ fontSize: 18 }}>
        {value}
      </div>
      <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
        {label}
      </div>
    </div>
  );
}

function ProvenanceChip({ label, id }: { label: string; id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: "var(--fg3)" }}>{label}</span>
      <a href={objectUrl(id)} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--fg2)" }}>
        {id.slice(0, 6)}…{id.slice(-4)} ↗
      </a>
      <button
        aria-label={`Copy ${label} id`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(id);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* unavailable */
          }
        }}
        style={{ display: "inline-flex", color: "var(--fg3)" }}
      >
        <Icon icon={copied ? "ic:round-check" : "ph:copy"} size={12} />
      </button>
    </span>
  );
}

function escrowLabel(stats?: Record<string, CoinStats>): string {
  if (!stats) return "—";
  const parts = COINS.map((c) => {
    const v = stats[c.type]?.escrow ?? 0n;
    return v > 0n ? `${fmtAmount(v, c.decimals)} ${c.symbol}` : null;
  }).filter(Boolean);
  return parts.length ? parts.join(" · ") : "0";
}

// === Stage rail ===

function StageRail({ current, eventName }: { current: LifecycleStage; eventName: string }) {
  const idx = stageIndex(current);
  return (
    <Card className="p-4" aria-label="Event lifecycle">
      <div className="text-[11px] uppercase tracking-wide" style={{ color: "var(--fg3)", letterSpacing: ".06em" }}>
        Lifecycle
      </div>
      <div className="font-medium" style={{ marginTop: 2, marginBottom: 10 }} title={eventName}>
        {eventName.length > 26 ? eventName.slice(0, 26) + "…" : eventName}
      </div>
      <ol style={{ display: "grid", gap: 2 }}>
        {STAGE_ORDER.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "now" : "future";
          return (
            <li key={s} className="flex items-center gap-2.5" style={{ padding: "7px 0", opacity: state === "future" ? 0.45 : 1 }}>
              <span
                aria-hidden
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 999,
                  flexShrink: 0,
                  background:
                    state === "now" ? "var(--hi-blue, #4f8cff)" : state === "done" ? "var(--fg3)" : "transparent",
                  border: state === "future" ? "1px solid var(--fg3)" : "none",
                  boxShadow: state === "now" ? "0 0 0 4px rgba(79,140,255,.18)" : "none",
                }}
              />
              <span className="text-sm" style={{ fontWeight: state === "now" ? 600 : 400 }}>
                {STAGE_LABEL[s]}
              </span>
              {state === "now" && (
                <Badge variant="secondary" style={{ marginLeft: "auto", fontSize: 10 }}>
                  now
                </Badge>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// === Door mode (Doors Open) ===

function DoorModeCard({ eventId }: { eventId: string }) {
  return (
    <Card className="space-y-3 p-5">
      <div className="font-medium">Door mode</div>
      <p className="text-[13px]" style={{ color: "var(--fg3)" }}>
        Doors are open. Scan tickets at the entrance or let attendees check themselves in.
      </p>
      <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
        <Button asChild size="lg">
          <Link href={`/door/${eventId}`}>
            <Icon icon="material-symbols:door-front-outline" size={18} /> Open door scanner
          </Link>
        </Button>
        <Button asChild variant="outline" size="lg">
          <Link href="/checkin">
            <Icon icon="zondicons:inbox-check" size={16} /> Check-in console
          </Link>
        </Button>
      </div>
    </Card>
  );
}

// === Door prep: self check-in + signer roster (add + revoke) ===

function DoorPrepPanel({
  ctx,
  signersField,
  allowSelf,
}: {
  ctx: DeckCtx;
  signersField: unknown;
  allowSelf: boolean;
}) {
  const signers = useMemo(() => parseSignerPubkeys(signersField), [signersField]);
  const [hex, setHex] = useState("");

  function addSigner() {
    const clean = hex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean)) {
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
    ctx.send(addCheckinSignerTx({ capId: ctx.capId, eventId: ctx.eventId, pubkey: Array.from(bytes) }), () => {
      setHex("");
      ctx.refetch();
    });
  }

  return (
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
          disabled={ctx.isPending}
          onCheckedChange={() => {
            if (!ctx.isPending)
              ctx.send(setAllowSelfCheckinTx({ capId: ctx.capId, eventId: ctx.eventId, allow: !allowSelf }));
          }}
        />
      </div>

      <div style={{ borderTop: "1px solid var(--hair)", paddingTop: 14 }} className="space-y-3">
        <div>
          <div className="font-medium">Door signers</div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            ed25519 staff-device keys authorized to issue entry vouchers. Revoke a lost or
            compromised device immediately.
          </div>
        </div>

        {signers.length === 0 ? (
          <div
            className="text-[13px]"
            style={{ color: "var(--fg2)", background: "rgba(245,166,35,.08)", border: "1px solid var(--hi-amber)", borderRadius: 10, padding: 10 }}
          >
            No door signer registered — voucher scans at the gate will abort, so attendees can&apos;t
            be let in. Add a staff device key, or enable self check-in above.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {signers.map((sg) => (
              <div
                key={sg.hex}
                className="flex items-center justify-between gap-2"
                style={{ padding: "8px 10px", border: "1px solid var(--hair)", borderRadius: 10 }}
              >
                <span className="mono" style={{ fontSize: 12, color: "var(--fg2)" }}>
                  0x{sg.hex.slice(0, 10)}…{sg.hex.slice(-6)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={ctx.isPending}
                  onClick={() =>
                    ctx.send(
                      removeCheckinSignerTx({ capId: ctx.capId, eventId: ctx.eventId, pubkey: sg.bytes }),
                      ctx.refetch,
                    )
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
          <div className="grow" style={{ minWidth: 200 }}>
            <Input
              className="mono"
              placeholder="0x… (64 hex chars)"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
            />
          </div>
          <Button disabled={ctx.isPending} onClick={addSigner}>
            {ctx.isPending ? "Adding…" : "Add signer"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// === POAP toggle (arm/disable + claimed count) ===

function PoapPanel({
  ctx,
  meta,
  poapEnabled,
  claimed,
  currentName,
  currentSymbol,
}: {
  ctx: DeckCtx;
  meta: EventMetadata | null;
  poapEnabled: boolean;
  claimed: number;
  currentName: string;
  currentSymbol: string;
}) {
  const advertised = Boolean(meta?.poap);
  const [busy, setBusy] = useState(false);

  // Advertise = set `poap: true` in the Walrus metadata so the public page shows
  // it (the on-chain toggle below controls whether claiming actually works).
  async function advertise() {
    if (advertised) return;
    setBusy(true);
    try {
      const base: EventMetadata = meta ?? { v: 1, category: "community" };
      const next: EventMetadata = { ...base, v: 1, poap: true };
      const newUri = await putEventMetadata(next);
      const symbol = currentSymbol.trim() || "EVNT";
      await ctx.send(
        updateMetadataTx({ capId: ctx.capId, eventId: ctx.eventId, name: currentName, symbol, uri: newUri }),
      );
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">Proof of attendance (POAP)</div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            Checked-in holders can claim a POAP from the public page.{" "}
            {claimed > 0 ? `${claimed} claimed so far.` : "None claimed yet."}
          </div>
        </div>
        <Switch
          aria-label="POAP claiming enabled"
          checked={poapEnabled}
          disabled={ctx.isPending || busy}
          onCheckedChange={(v) =>
            ctx.send(setPoapEnabledTx({ capId: ctx.capId, eventId: ctx.eventId, value: Boolean(v) }))
          }
        />
      </div>
      {!advertised && (
        <div className="flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--hair)", paddingTop: 12 }}>
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            Not advertised on the public page yet.
          </div>
          <Button variant="outline" size="sm" disabled={ctx.isPending || busy} onClick={advertise}>
            {busy ? "Saving…" : "Advertise POAP"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// === Money: escrow withdraw + lifetime accounting ===

function MoneyPanel({
  ctx,
  stats,
  loading,
  isError,
  isRefundable,
  isCancelled,
  endMs,
  now,
  withWithdraw,
}: {
  ctx: DeckCtx;
  stats?: Record<string, CoinStats>;
  loading: boolean;
  isError: boolean;
  isRefundable: boolean;
  isCancelled: boolean;
  endMs: number;
  now: number;
  withWithdraw: boolean;
}) {
  const refundWindowOpen = isRefundable && now < endMs + REFUND_PERIOD_MS;
  const anyEscrow = COINS.some((c) => (stats?.[c.type]?.escrow ?? 0n) > 0n);

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">Money</div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            On-chain escrow and lifetime accounting. Buyers paid the price + a 3% protocol fee.
          </div>
        </div>
        <a href={objectUrl(ctx.eventId)} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11, color: "var(--fg3)" }}>
          escrow_value&lt;T&gt; ↗
        </a>
      </div>

      {isError && (
        <div className="text-[13px]" style={{ color: "var(--color-danger)" }}>
          Couldn&apos;t read on-chain escrow — withdraw is held until the read succeeds.
        </div>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {COINS.map((c) => {
          const st = stats?.[c.type];
          const escrow = st?.escrow ?? 0n;
          const canWithdraw =
            withWithdraw && !isError && !isCancelled && escrow > 0n && !refundWindowOpen;
          return (
            <div key={c.type} style={{ padding: "10px 0", borderBottom: "1px solid var(--hair)" }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">
                    {loading ? "…" : fmtAmount(escrow, c.decimals)} {c.symbol}
                    <span className="text-[11px]" style={{ color: "var(--fg3)", marginLeft: 6 }}>
                      withdrawable
                    </span>
                  </div>
                  <div className="mono text-[11px]" style={{ color: "var(--fg3)", marginTop: 2 }}>
                    gross {fmtAmount(st?.gross ?? 0n, c.decimals)} · fee {fmtAmount(st?.fee ?? 0n, c.decimals)} ·
                    refunded {fmtAmount(st?.refunded ?? 0n, c.decimals)}
                  </div>
                </div>
                {withWithdraw && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          size="sm"
                          disabled={ctx.isPending || !canWithdraw}
                          onClick={() =>
                            ctx.send(
                              withdrawEventBalanceTx({
                                capId: ctx.capId,
                                eventId: ctx.eventId,
                                coinType: c.type,
                                recipient: ctx.addr,
                              }),
                            )
                          }
                        >
                          <Icon icon="solar:download-minimalistic-bold" size={15} /> Withdraw
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isCancelled
                        ? "Cancelled — escrow is reserved for refunders"
                        : escrow === 0n
                          ? `No ${c.symbol} escrow to withdraw`
                          : refundWindowOpen
                            ? "Refund window still open — withdraw after it closes"
                            : `Withdraw all ${c.symbol} to your wallet`}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {withWithdraw && refundWindowOpen && anyEscrow && !isCancelled && (
        <p className="text-[11px]" style={{ color: "var(--fg3)" }}>
          This event is refundable — escrow unlocks for withdrawal after the refund window closes.
        </p>
      )}
    </Card>
  );
}

// === Reviews summary (Wrapped) ===

function ReviewsSummaryPanel({
  summary,
  loading,
  eventId,
}: {
  summary: { avg: number; count: number };
  loading: boolean;
  eventId: string;
}) {
  return (
    <Card className="space-y-2 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">Attendee reviews</div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/event/${eventId}`}>View all</Link>
        </Button>
      </div>
      {loading ? (
        <div className="mono text-sm" style={{ color: "var(--fg2)" }}>
          Loading…
        </div>
      ) : summary.count === 0 ? (
        <p className="text-[13px]" style={{ color: "var(--fg3)" }}>
          No reviews yet. Attendees who claimed a POAP can review from the public page.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 26, fontWeight: 700 }}>{summary.avg.toFixed(1)}</span>
          <span style={{ color: "var(--hi-amber)" }}>
            {"★".repeat(Math.round(summary.avg))}
            <span style={{ color: "var(--fg3)" }}>{"★".repeat(5 - Math.round(summary.avg))}</span>
          </span>
          <span className="text-[13px]" style={{ color: "var(--fg3)" }}>
            ({summary.count})
          </span>
        </div>
      )}
    </Card>
  );
}

// === Organizer recap (post to the event chat) ===

function OrganizerRecapPanel({ ctx }: { ctx: DeckCtx }) {
  const client = useCurrentClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function post() {
    const body = text.trim();
    if (!body) {
      toast.error("Write a short wrap-up first.");
      return;
    }
    setBusy(true);
    try {
      const blobId = await encryptForumMessage(client, ctx.eventId, {
        text: body,
        author: ctx.addr,
        ts: Date.now(),
      });
      await ctx.send(forumPostAsOrganizerTx(ctx.eventId, ctx.capId, "general", blobId), () => setText(""));
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div>
        <div className="font-medium">Post a wrap-up</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Thank attendees in the event chat. Encrypted; readable by ticket holders.
        </div>
      </div>
      <Textarea
        placeholder="Thanks for coming! Photos and the next date are…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex justify-end">
        <Button disabled={ctx.isPending || busy} onClick={post}>
          {busy ? "Posting…" : "Post to event chat"}
        </Button>
      </div>
    </Card>
  );
}

// === Free / refundable flips (guarded; meaningful pre-sale) ===

function FreeRefundablePanel({
  ctx,
  isFree,
  isRefundable,
  minted,
}: {
  ctx: DeckCtx;
  isFree: boolean;
  isRefundable: boolean;
  minted: bigint;
}) {
  const sold = minted > 0n;
  return (
    <Card className="space-y-3 p-5">
      <div className="font-medium">Ticket terms</div>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{isFree ? "Free event" : "Paid event"}</div>
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            {sold ? "Locked — tickets have already sold." : "Switch before any ticket sells."}
          </div>
        </div>
        <Switch
          aria-label="Paid event"
          checked={!isFree}
          disabled={ctx.isPending || sold}
          onCheckedChange={(v) =>
            ctx.send(setIsFreeTx({ capId: ctx.capId, eventId: ctx.eventId, value: !v }))
          }
        />
      </div>
      <div className="flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--hair)", paddingTop: 12 }}>
        <div>
          <div className="text-sm font-medium">Refundable</div>
          <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
            {sold && isRefundable
              ? "Can't be revoked after a sale."
              : "Holders can refund within the post-event window."}
          </div>
        </div>
        <Switch
          aria-label="Refundable"
          checked={isRefundable}
          disabled={ctx.isPending || (sold && isRefundable)}
          onCheckedChange={(v) =>
            ctx.send(setIsRefundableTx({ capId: ctx.capId, eventId: ctx.eventId, value: Boolean(v) }))
          }
        />
      </div>
    </Card>
  );
}

// === End-time extension (Doors Open) ===

function EndTimePanel({ ctx, startMs, endMs }: { ctx: DeckCtx; startMs: number; endMs: number }) {
  const [end, setEnd] = useState(() => msToLocal(endMs));
  function save() {
    const eMs = Date.parse(end);
    if (!Number.isFinite(eMs)) {
      toast.error("Pick a valid end time.");
      return;
    }
    if (eMs <= Date.now() || eMs <= startMs) {
      toast.error("New end must be in the future and after the start.");
      return;
    }
    ctx.send(updateEndTimeTx({ capId: ctx.capId, eventId: ctx.eventId, endMs: BigInt(eMs) }), ctx.refetch);
  }
  return (
    <Card className="space-y-3 p-5">
      <div>
        <div className="font-medium">Extend doors</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Push back when the event ends — the one schedule change allowed mid-event.
        </div>
      </div>
      <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <Label htmlFor="ee-end-extend">New end</Label>
          <DateTimePicker id="ee-end-extend" value={end} min={msToLocal(Date.now())} onChange={setEnd} />
        </div>
        <Button disabled={ctx.isPending} onClick={save}>
          {ctx.isPending ? "Saving…" : "Extend"}
        </Button>
      </div>
    </Card>
  );
}

// === Cancel (danger zone) ===

function CancelZone({ ctx, isCancelled }: { ctx: DeckCtx; isCancelled: boolean }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Card className="space-y-3 p-5" style={{ border: "1px solid var(--hair)" }}>
      <div className="font-medium" style={{ color: isCancelled ? "var(--fg)" : "var(--color-danger)" }}>
        {isCancelled ? "Reactivate event" : "Cancel event"}
      </div>
      <p className="text-[13px]" style={{ color: "var(--fg3)" }}>
        {isCancelled
          ? "Re-open the event: sales and withdrawals resume."
          : "Cancelling opens refunds for every holder immediately (even non-refundable) and blocks sales + your withdrawals until reactivated."}
      </p>
      {isCancelled ? (
        <Button
          variant="outline"
          disabled={ctx.isPending}
          onClick={() => ctx.send(setCancelledTx({ capId: ctx.capId, eventId: ctx.eventId, value: false }))}
        >
          Reactivate
        </Button>
      ) : !confirm ? (
        <Button variant="outline" onClick={() => setConfirm(true)} style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}>
          Cancel event…
        </Button>
      ) : (
        <div className="flex gap-2" style={{ flexWrap: "wrap" }}>
          <Button
            disabled={ctx.isPending}
            onClick={() => ctx.send(setCancelledTx({ capId: ctx.capId, eventId: ctx.eventId, value: true }), () => setConfirm(false))}
            style={{ background: "var(--color-danger)" }}
          >
            Yes, cancel & open refunds
          </Button>
          <Button variant="outline" onClick={() => setConfirm(false)}>
            Keep event
          </Button>
        </div>
      )}
    </Card>
  );
}

// === Telemetry stream (recent on-chain activity) ===

// === Opted-in attendee emails (organizer decrypt via Seal) ===

function AttendeeEmailsCard({ ctx }: { ctx: DeckCtx }) {
  const grantsQ = useAllEvents(EV_EMAIL_GRANT_CREATED);
  const client = useCurrentClient();
  const sign = useSignPersonalMessage();
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const grants = useMemo(() => {
    const seen = new Set<string>();
    const out: { user: string; grantId: string }[] = [];
    for (const ev of grantsQ.data?.data ?? []) {
      const p = ev.parsedJson as { grant_id: string; user: string; event_id: string };
      if (p.event_id !== ctx.eventId || seen.has(p.user)) continue;
      seen.add(p.user);
      out.push({ user: p.user, grantId: p.grant_id });
    }
    return out;
  }, [grantsQ.data, ctx.eventId]);

  async function reveal() {
    setBusy(true);
    try {
      // One signature mints the SessionKey; reused across every attendee row.
      const sk = await createSessionKey(client, ctx.addr, sign);
      const next: Record<string, string> = {};
      for (const g of grants) {
        try {
          const ptr = (await (await fetch(`/api/identity/profile-pointer?address=${g.user}`)).json()) as {
            blobId?: string | null;
          };
          if (!ptr.blobId) {
            next[g.user] = "(no profile)";
            continue;
          }
          const env = await readJson<ProfileEnvelope>(ptr.blobId);
          if (!env?.emailBlobId) {
            next[g.user] = "(no email)";
            continue;
          }
          next[g.user] = await decryptAttendeeEmail(
            client,
            sk,
            env.emailBlobId,
            ctx.capId,
            ctx.eventId,
            g.grantId,
          );
        } catch {
          next[g.user] = "(revoked / unavailable)";
        }
      }
      setEmails(next);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!EMAIL_ENABLED || grants.length === 0) return null;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-medium">Attendee emails</div>
          <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
            {grants.length} attendee{grants.length === 1 ? "" : "s"} opted to share their email.
            Decrypts in your browser via Seal — one signature.
          </div>
        </div>
        <Button size="sm" disabled={busy} onClick={reveal}>
          {busy ? "Decrypting…" : Object.keys(emails).length ? "Re-decrypt" : "Reveal emails"}
        </Button>
      </div>
      {Object.keys(emails).length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          {grants.map((g) => (
            <div
              key={g.user}
              className="flex items-center justify-between gap-3"
              style={{ padding: "8px 10px", border: "1px solid var(--hair)", borderRadius: 10 }}
            >
              <AddressDisplay address={g.user} suffix={4} />
              <span className="mono text-[13px]" style={{ color: "var(--fg2)" }}>
                {emails[g.user] ?? "…"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function TelemetryStream({
  mints,
  checkins,
  loading,
  truncated,
  publicUrl,
}: {
  mints: TicketMintedJson[];
  checkins: CheckedInJson[];
  loading: boolean;
  truncated: boolean;
  publicUrl: string;
}) {
  const checkedSet = useMemo(() => new Set(checkins.map((c) => c.ticket_id)), [checkins]);
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-2" style={{ flexWrap: "wrap" }}>
        <h2 className="page-title" style={{ fontSize: 20 }}>
          Telemetry <span style={{ color: "var(--fg3)" }}>({mints.length})</span>
        </h2>
        {truncated && (
          <Badge variant="outline" style={{ fontSize: 10 }}>
            partial · ~1000-log cap
          </Badge>
        )}
      </div>
      {loading ? (
        <Card className="mono p-5">Loading activity…</Card>
      ) : mints.length === 0 ? (
        <Card className="p-5">
          <div className="font-semibold">No mints yet.</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            Share your event link to start selling — <span className="mono">{publicUrl}</span>
          </p>
        </Card>
      ) : (
        <Card className="gap-0 py-0" style={{ overflow: "hidden" }}>
          {mints.slice(0, 14).map((m, i) => {
            const ci = coinInfo(resolveCoinType(m.coin_type));
            const isIn = checkedSet.has(m.ticket_id);
            return (
              <div
                key={`${m.ticket_id}-${i}`}
                className="flex items-center justify-between gap-3"
                style={{ padding: "11px 16px", borderBottom: i < Math.min(mints.length, 14) - 1 ? "1px solid var(--hair)" : "none" }}
              >
                <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                  <Badge variant="secondary" className="mono">
                    #{String(m.serial)}
                  </Badge>
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
                  {isIn && <Badge variant="default">In</Badge>}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </section>
  );
}

// === Prediction markets (organizer view) ===

// USDC pool volume formatter (collateral defaults to testnet USDC, 6 decimals).
const usdcInfo = coinInfo(USDC_COIN_TYPE);

// Default cutoffs for a fresh range market: quartiles of maxTickets. N=4 cutoffs
// -> 5 buckets. Cutoffs must be strictly increasing; dedup+sort and fall back to
// a single midpoint cutoff if everything collapses.
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

  const sellout = useMemo(() => (selloutQ.data ? parseMarketFields(selloutQ.data) : null), [selloutQ.data]);
  const range = useMemo(() => (rangeQ.data ? parseRangeFields(rangeQ.data) : null), [rangeQ.data]);

  const selloutPool = sellout ? sellout.totalYes + sellout.totalNo : 0n;
  const rangePool = range ? range.totals.reduce((a, b) => a + b, 0n) : 0n;
  const afterCreate = () => refetch();

  return (
    <section className="space-y-3">
      <div>
        <h2 className="page-title" style={{ fontSize: 20 }}>
          Prediction markets
        </h2>
        <p className="page-sub">
          Parimutuel pools on your sales, settled on-chain from the minted count. Anyone can open one
          (permissionless); betting and claiming live on the{" "}
          <Link href={`/event/${eventId}`} style={{ color: "var(--hi-blue)" }}>
            public event page
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
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
                <RefreshCw size={14} animate={selloutQ.isFetching} loop /> Retry
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
                  <Badge variant="secondary">{sellout.outcomeYes ? "Sold out" : "Did not sell out"}</Badge>
                )}
              </div>
            </div>
          ) : (
            <>
              <Button size="sm" disabled={isPending} onClick={() => send(createSelloutMarketTx(eventId, USDC_COIN_TYPE), afterCreate)}>
                <Icon icon="mdi:timer-sand" size={15} />
                {isPending ? "Opening…" : "Open Sellout Clock"}
              </Button>
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Parimutuel USDC pool, settled on-chain. No effect on ticket revenue.
              </div>
            </>
          )}
        </Card>

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
                <RefreshCw size={14} animate={rangeQ.isFetching} loop /> Retry
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
              <Button size="sm" disabled={isPending} onClick={() => send(createRangeMarketTx(eventId, USDC_COIN_TYPE, cutoffs), afterCreate)}>
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

// === Edit event (details / schedule / capacity) — #69 forms, reused ===

const EDIT_CATEGORIES = CATEGORIES.filter((c) => c.id !== "all");
const EDIT_MAX_TICKET_LIMIT = 10_000_000;

function msToLocal(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowLocal(): string {
  return msToLocal(Date.now());
}

function EditEventPanel({
  capId,
  eventId,
  meta,
  currentName,
  currentSymbol,
  currentUri,
  startMs,
  endMs,
  purchaseStartMs,
  maxTickets,
  minted,
  maxPerUser,
  onDone,
}: {
  capId: string;
  eventId: string;
  meta: EventMetadata | null;
  currentName: string;
  currentSymbol: string;
  currentUri: string;
  startMs: number;
  endMs: number;
  purchaseStartMs: number;
  maxTickets: bigint;
  minted: bigint;
  maxPerUser: bigint;
  isFree: boolean;
  isRefundable: boolean;
  onDone: () => void;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [open, setOpen] = useState(false);

  async function submit(tx: Transaction, successMsg: string): Promise<boolean> {
    if (!addr) {
      toast.error("Connect a wallet to edit this event.");
      return false;
    }
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success(successMsg, { description: <TxLink digest={out.digest} chars={10} /> });
      onDone();
      return true;
    } catch (e: unknown) {
      toast.error(humanizeError(e));
      return false;
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-2" style={{ flexWrap: "wrap" }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 20 }}>
            Details, schedule &amp; capacity
          </h2>
          <p className="page-sub">Each save is a separate cap-gated transaction.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
          <Icon icon={open ? "ph:caret-up-bold" : "ph:caret-down-bold"} size={15} />
          {open ? "Hide" : "Edit"}
        </Button>
      </div>

      {open && (
        <div className="space-y-4">
          {meta === null ? (
            <Card className="p-4 text-sm text-muted-foreground">Loading event details…</Card>
          ) : (
            <EditDetailsPanel
              meta={meta}
              currentName={currentName}
              currentSymbol={currentSymbol}
              currentUri={currentUri}
              capId={capId}
              eventId={eventId}
              isPending={isPending}
              submit={submit}
            />
          )}
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <EditSchedulePanel
              capId={capId}
              eventId={eventId}
              startMs={startMs}
              endMs={endMs}
              purchaseStartMs={purchaseStartMs}
              isPending={isPending}
              submit={submit}
            />
            <EditCapacityPanel
              capId={capId}
              eventId={eventId}
              maxTickets={maxTickets}
              minted={minted}
              maxPerUser={maxPerUser}
              isPending={isPending}
              submit={submit}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function EditDetailsPanel({
  meta,
  currentName,
  currentSymbol,
  currentUri,
  capId,
  eventId,
  isPending,
  submit,
}: {
  meta: EventMetadata | null;
  currentName: string;
  currentSymbol: string;
  currentUri: string;
  capId: string;
  eventId: string;
  isPending: boolean;
  submit: (tx: Transaction, successMsg: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(currentName);
  const [description, setDescription] = useState(meta?.description ?? "");
  const [category, setCategory] = useState(meta?.category ?? EDIT_CATEGORIES[0].id);
  const [tag, setTag] = useState(meta?.tag ?? "");
  const [venue, setVenue] = useState(meta?.venue ?? "");
  const [city, setCity] = useState(meta?.city ?? "");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      toast.error("Event name can't be empty.");
      return;
    }
    try {
      let coverBlobId = meta?.coverBlobId;
      if (coverFile) {
        setBusy("Uploading cover to Walrus…");
        coverBlobId = await storeFile(coverFile);
      }
      const base: EventMetadata = meta ?? { v: 1, category: category.trim() || "community" };
      const next: EventMetadata = { ...base, v: 1, category: category.trim() || base.category };
      const setOrDrop = (key: "tag" | "venue" | "city", value: string) => {
        const v = value.trim();
        if (v) next[key] = v;
        else delete next[key];
      };
      const desc = description.trim();
      if (desc) next.description = desc;
      else delete next.description;
      setOrDrop("tag", tag);
      setOrDrop("venue", venue);
      setOrDrop("city", city);
      if (coverBlobId) next.coverBlobId = coverBlobId;
      else delete next.coverBlobId;

      setBusy("Storing metadata on Walrus…");
      const sameAsBefore = meta !== null && JSON.stringify(next) === JSON.stringify(meta) && !coverFile;
      const newUri = sameAsBefore ? currentUri : await putEventMetadata(next);

      const symbol = currentSymbol.trim() || (category.trim().slice(0, 4).toUpperCase() || "EVNT");
      setBusy("Saving on-chain…");
      const ok = await submit(
        updateMetadataTx({ capId, eventId, name: name.trim(), symbol, uri: newUri }),
        "Details updated",
      );
      if (ok) setCoverFile(null);
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="font-medium">Details</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Name, description, location and cover — stored on Walrus, then written on-chain.
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ee-name">Event name</Label>
        <Input id="ee-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ee-description">Description</Label>
        <Textarea
          id="ee-description"
          placeholder="What is this event about? Who is it for?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ee-category">Category</Label>
          <Select value={category} onValueChange={(v) => setCategory(v)}>
            <SelectTrigger id="ee-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EDIT_CATEGORIES.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ee-tag">Tag (optional)</Label>
          <Input id="ee-tag" placeholder="e.g. Conference, Festival" value={tag} onChange={(e) => setTag(e.target.value)} />
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ee-venue">Venue</Label>
          <Input id="ee-venue" value={venue} onChange={(e) => setVenue(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ee-city">City</Label>
          <Input id="ee-city" value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ee-cover">Cover image (upload to replace)</Label>
        <Input id="ee-cover" type="file" accept="image/*" onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)} />
        <p className="text-[12px]" style={{ color: "var(--fg3)" }}>
          {coverFile ? (
            <>
              <Icon icon="ph:image-fill" size={13} /> {coverFile.name}
            </>
          ) : meta?.coverBlobId ? (
            "A cover is set — leave empty to keep it."
          ) : (
            "No cover yet — optional."
          )}
        </p>
      </div>

      {busy && (
        <div className="mono text-sm" style={{ color: "var(--hi-blue)" }}>
          <Icon icon="svg-spinners:3-dots-fade" size={15} /> {busy}
        </div>
      )}

      <div className="flex justify-end">
        <Button disabled={isPending || Boolean(busy)} onClick={save}>
          {busy || isPending ? "Saving…" : "Save details"}
        </Button>
      </div>
    </Card>
  );
}

function EditSchedulePanel({
  capId,
  eventId,
  startMs,
  endMs,
  purchaseStartMs,
  isPending,
  submit,
}: {
  capId: string;
  eventId: string;
  startMs: number;
  endMs: number;
  purchaseStartMs: number;
  isPending: boolean;
  submit: (tx: Transaction, successMsg: string) => Promise<boolean>;
}) {
  const [locked] = useState(() => startMs < Date.now());
  const [start, setStart] = useState(() => msToLocal(startMs));
  const [end, setEnd] = useState(() => msToLocal(endMs));
  const [saleOpensNow, setSaleOpensNow] = useState(() => purchaseStartMs <= Date.now());
  const [purchaseStart, setPurchaseStart] = useState(() => msToLocal(purchaseStartMs));

  function validate(sMs: number, eMs: number, pMs: number): string | null {
    if (![sMs, eMs, pMs].every(Number.isFinite)) return "Dates must be valid.";
    if (sMs < Date.now() - 60_000) return "Start can't be in the past.";
    if (eMs <= sMs) return "End must be after start.";
    if (pMs > sMs) return "Sale can't open after the event starts.";
    if (pMs > eMs) return "Sale can't open after the event ends.";
    return null;
  }

  async function save() {
    if (locked) return;
    const sMs = Date.parse(start);
    const eMs = Date.parse(end);
    const pMs = saleOpensNow ? Math.min(Date.now(), sMs) : Date.parse(purchaseStart);
    const err = validate(sMs, eMs, pMs);
    if (err) {
      toast.error(err);
      return;
    }
    await submit(
      updateTimesTx({ capId, eventId, startMs: BigInt(sMs), endMs: BigInt(eMs), purchaseStartMs: BigInt(pMs) }),
      "Schedule updated",
    );
  }

  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="font-medium">Schedule</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Start, end and when sales open.
        </div>
      </div>

      {locked ? (
        <div
          className="text-sm"
          style={{ color: "var(--fg2)", background: "rgba(245,166,35,.08)", border: "1px solid var(--hi-amber)", borderRadius: 10, padding: 12 }}
        >
          <Icon icon="ph:lock-fill" size={14} style={{ color: "var(--hi-amber)" }} /> This event has
          already started, so its schedule is locked (use “Extend doors” to push back the end).
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ee-start">Event starts</Label>
              <DateTimePicker id="ee-start" value={start} min={nowLocal()} onChange={setStart} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ee-end">Event ends</Label>
              <DateTimePicker id="ee-end" value={end} min={start} onChange={setEnd} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Sales open immediately</div>
              <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
                Otherwise pick when purchases open.
              </div>
            </div>
            <Switch aria-label="Sales open immediately" checked={saleOpensNow} onCheckedChange={(v) => setSaleOpensNow(Boolean(v))} />
          </div>
          {!saleOpensNow && (
            <div className="space-y-1.5">
              <Label htmlFor="ee-purchase-start">Sales open</Label>
              <DateTimePicker id="ee-purchase-start" value={purchaseStart} min={nowLocal()} onChange={setPurchaseStart} />
            </div>
          )}

          <div className="flex justify-end">
            <Button disabled={isPending} onClick={save}>
              {isPending ? "Saving…" : "Save schedule"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

function EditCapacityPanel({
  capId,
  eventId,
  maxTickets,
  minted,
  maxPerUser,
  isPending,
  submit,
}: {
  capId: string;
  eventId: string;
  maxTickets: bigint;
  minted: bigint;
  maxPerUser: bigint;
  isPending: boolean;
  submit: (tx: Transaction, successMsg: string) => Promise<boolean>;
}) {
  const [maxTicketsStr, setMaxTicketsStr] = useState(String(maxTickets));
  const [maxPerUserStr, setMaxPerUserStr] = useState(String(maxPerUser));

  async function saveMaxTickets() {
    const n = Number(maxTicketsStr);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error("Max tickets must be a whole number greater than 0.");
      return;
    }
    if (n > EDIT_MAX_TICKET_LIMIT) {
      toast.error(`Max tickets can't exceed ${EDIT_MAX_TICKET_LIMIT.toLocaleString()}.`);
      return;
    }
    if (BigInt(n) < minted) {
      toast.error(`Max tickets can't be below the ${String(minted)} already sold.`);
      return;
    }
    await submit(updateMaxTicketsTx({ capId, eventId, maxTickets: BigInt(n) }), "Max tickets updated");
  }

  async function saveMaxPerUser() {
    const n = Number(maxPerUserStr);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error("Max per attendee must be a whole number greater than 0.");
      return;
    }
    await submit(updateMaxPerUserTx({ capId, eventId, maxPerUser: BigInt(n) }), "Max per attendee updated");
  }

  const ticketFloor = minted > 0n ? Number(minted) : 1;

  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="font-medium">Capacity</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Total tickets and per-attendee limit.
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ee-max-tickets">Max tickets</Label>
        <div className="flex items-end gap-2">
          <Input id="ee-max-tickets" type="number" min={ticketFloor} step="1" value={maxTicketsStr} onChange={(e) => setMaxTicketsStr(e.target.value)} />
          <Button variant="outline" disabled={isPending} onClick={saveMaxTickets}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-[12px]" style={{ color: "var(--fg3)" }}>
          {String(minted)} sold so far — can&apos;t go below that.
        </p>
      </div>

      <div className="space-y-1.5" style={{ borderTop: "1px solid var(--hair)", paddingTop: 14 }}>
        <Label htmlFor="ee-max-per-user">Max per attendee</Label>
        <div className="flex items-end gap-2">
          <Input id="ee-max-per-user" type="number" min={1} step="1" value={maxPerUserStr} onChange={(e) => setMaxPerUserStr(e.target.value)} />
          <Button variant="outline" disabled={isPending} onClick={saveMaxPerUser}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
        <p className="text-[12px]" style={{ color: "var(--fg3)" }}>
          How many tickets one wallet can hold. Must be greater than 0.
        </p>
      </div>
    </Card>
  );
}

// === Price control (per-coin) + remove price ===

function PricePanel({ ctx, stats }: { ctx: DeckCtx; stats?: Record<string, CoinStats> }) {
  const [coin, setCoin] = useState(COINS[0].type);
  const [priceStr, setPriceStr] = useState("1");

  async function setPrice() {
    const dec = coinInfo(coin).decimals;
    const units = toUnits(priceStr, dec);
    if (units === null) {
      toast.error(`Enter a valid price with at most ${dec} decimal places.`);
      return;
    }
    if (units <= 0n) {
      toast.error("Enter a price greater than zero.");
      return;
    }
    await ctx.send(setPriceTx({ capId: ctx.capId, eventId: ctx.eventId, coinType: coin, price: units }), ctx.refetch);
  }

  return (
    <Card className="space-y-3 p-5">
      <div>
        <div className="font-medium">Pricing</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Buyers pay this plus a 3% platform fee. Price per coin type.
        </div>
      </div>
      <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
        <div className="space-y-1.5">
          <Label>Coin</Label>
          <Select value={coin} onValueChange={(v) => setCoin(v)}>
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
            onChange={(e) => setPriceStr(e.target.value)}
          />
        </div>
        <Button disabled={ctx.isPending} onClick={setPrice}>
          {ctx.isPending ? "Setting…" : "Set price"}
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2" style={{ borderTop: "1px solid var(--hair)", paddingTop: 10 }}>
        <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
          Delist a coin (only when its escrow is empty).
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={ctx.isPending || (stats?.[coin]?.escrow ?? 0n) > 0n}
          onClick={() => ctx.send(removePriceTx({ capId: ctx.capId, eventId: ctx.eventId, coinType: coin }), ctx.refetch)}
        >
          Remove {coinInfo(coin).symbol} price
        </Button>
      </div>
    </Card>
  );
}
