"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { CopilotPanel } from "@/components/screens/CopilotPanel";
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
    setActionErr(null);
    try {
      const out =
        ENOKI_ENABLED && addr
          ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
          : await regular.mutateAsync({ transaction: tx });
      setActionDigest(out.digest);
      eventQ.refetch();
      after?.();
    } catch (e: unknown) {
      setActionErr(humanizeError(e));
    }
  }

  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionDigest, setActionDigest] = useState<string | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // === Gating / loading / error ===
  if (!addr) {
    return (
      <div className="space-y-6 screen-in">
        <div className="card">
          <div className="font-semibold">Connect your wallet</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            The organizer cockpit needs the wallet that holds this event&apos;s OrganizerCap.
          </p>
        </div>
      </div>
    );
  }
  if (eventQ.isLoading || capsQ.isLoading) {
    return <div className="card mono screen-in">Loading event…</div>;
  }
  if (!f) {
    return (
      <div className="card screen-in">
        <div className="font-semibold">Event not found</div>
        <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
          <span className="mono">{id.slice(0, 14)}…</span> didn&apos;t resolve to an Event object.
        </p>
      </div>
    );
  }
  if (!capId) {
    return (
      <div className="space-y-5 screen-in">
        <div className="card">
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
            <Link href={`/event/${id}`} className="btn">
              <Icon icon="ic:round-explore" size={16} /> View public page
            </Link>
            <Link href="/discover" className="btn">
              Back to discover
            </Link>
          </div>
        </div>
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
  let statusClass: string;
  if (now > endMs) {
    status = "Ended";
    statusClass = "badge-line";
  } else if (now >= startMs) {
    status = "Live";
    statusClass = "badge-green";
  } else if (now >= purchaseStartMs) {
    status = "On sale";
    statusClass = "badge-blue";
  } else {
    status = "Upcoming";
    statusClass = "badge-amber";
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
    views: undefined,
    priceLabel: grossEntries.length ? grossLabel : isFree ? "Free" : "Not set",
  };

  return (
    <div className="space-y-8 screen-in">
      {/* === Header (gradient poster + identity) === */}
      <header className="panel" style={{ position: "relative" }}>
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
            <span className={`badge ${statusClass}`}>{status}</span>
            {isFree && <span className="badge badge-green">Free</span>}
            {isRefundable && <span className="badge badge-soft">Refundable</span>}
            {meta?.tag && <span className="badge badge-line">{meta.tag}</span>}
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
            <Link href="/checkin" className="btn btn-sm">
              <Icon icon="zondicons:inbox-check" size={15} /> Check-in
            </Link>
            <Link href={`/event/${id}`} className="btn btn-sm">
              <Icon icon="ic:round-explore" size={15} /> View public page
            </Link>
            <button
              className="btn btn-sm"
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
            </button>
          </div>
        </div>
      </header>

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
          <div className="stat-label">Gross sales</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{checkedInCount}</div>
          <div className="stat-label">Checked in</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num" title="On-chain escrow isn't exposed as a readable field; withdraw to settle.">
            —
          </div>
          <div className="stat-label">In escrow</div>
        </div>
      </div>

      {/* === Capacity bar === */}
      <div className="card space-y-2">
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
      </div>

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
        <div className="card space-y-3">
          {isFree ? (
            <div className="text-sm" style={{ color: "var(--fg2)" }}>
              This is a free event — there are no balances to withdraw.
            </div>
          ) : (
            <div className="space-y-2">
              {COINS.map((c) => {
                const gross = grossByCoin.get(c.type) ?? 0n;
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
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={isPending}
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
                      title={`Withdraw all accrued ${c.symbol} to ${addr}`}
                    >
                      <Icon icon="solar:download-minimalistic-bold" size={15} /> Withdraw {c.symbol}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* === Controls: pricing + check-in === */}
      <section className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {!isFree && <PricePanel capId={capId} eventId={id} onDone={() => eventQ.refetch()} />}

        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="font-medium">Self check-in</div>
              <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
                Let holders check themselves in within the event window.
              </div>
            </div>
            <div
              className={`switch ${allowSelf ? "on" : ""}`}
              role="switch"
              aria-checked={allowSelf}
              onClick={() => {
                if (!isPending) send(setAllowSelfCheckinTx({ capId, eventId: id, allow: !allowSelf }));
              }}
            />
          </div>

          <div style={{ borderTop: "1px solid var(--hair)", paddingTop: 14 }}>
            <SignerPanel capId={capId} eventId={id} />
          </div>
        </div>
      </section>

      {/* === Prediction markets (organizer view: open + pool volume) === */}
      <PredictionMarketsPanel
        eventId={id}
        eventSeq={eventSeq}
        maxTickets={maxTickets}
        send={send}
        isPending={isPending}
      />

      {actionDigest && (
        <TxLink digest={actionDigest} className="mono text-xs" style={{ color: "var(--color-success)" }} />
      )}
      {actionErr && (
        <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>
          {actionErr}
        </div>
      )}

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
          <div className="card mono">Loading attendees…</div>
        ) : mints.length === 0 ? (
          <div className="card">
            <div className="font-semibold">No tickets yet.</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              Share your event link to start selling.
            </p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
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
                    <span className="badge badge-soft mono">#{String(m.serial)}</span>
                    <AddressDisplay address={m.recipient} suffix={4} />
                  </div>
                  <div className="flex items-center gap-2.5">
                    {BigInt(m.total_paid ?? 0) > 0n ? (
                      <span className="mono" style={{ fontSize: 13, color: "var(--fg2)" }}>
                        {fmtAmount(BigInt(m.total_paid), ci.decimals)} {ci.symbol}
                      </span>
                    ) : (
                      <span className="badge badge-line">Free</span>
                    )}
                    {isCheckedIn && <span className="badge badge-green">In</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* === AI Co-pilot (collapsible) === */}
      <section className="space-y-3">
        <button
          className="btn btn-block"
          style={{ justifyContent: "space-between" }}
          onClick={() => setCopilotOpen((o) => !o)}
        >
          <span className="flex items-center gap-2">
            <Icon icon="solar:magic-stick-3-bold" size={16} /> AI Co-pilot
          </span>
          <Icon icon={copilotOpen ? "ic:round-expand-less" : "ic:round-expand-more"} size={18} />
        </button>
        {copilotOpen && <CopilotPanel event={copilotEvent} />}
      </section>
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
        <div className="card space-y-3">
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
          ) : selloutMarketId ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span style={{ color: "var(--fg2)" }}>Pool volume</span>
                <span className="mono">
                  {fmtAmount(selloutPool, usdcInfo.decimals)} {usdcInfo.symbol}
                </span>
              </div>
              <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
                <span className="badge badge-green">YES {fmtAmount(sellout?.totalYes ?? 0n, usdcInfo.decimals)}</span>
                <span className="badge badge-line">NO {fmtAmount(sellout?.totalNo ?? 0n, usdcInfo.decimals)}</span>
                {sellout?.settled && (
                  <span className="badge badge-soft">
                    {sellout.outcomeYes ? "Sold out" : "Did not sell out"}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <>
              <button
                className="btn btn-primary btn-sm"
                disabled={isPending}
                onClick={() => send(createSelloutMarketTx(eventId, USDC_COIN_TYPE), afterCreate)}
              >
                <Icon icon="mdi:timer-sand" size={15} />
                {isPending ? "Opening…" : "Open Sellout Clock"}
              </button>
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Parimutuel USDC pool, settled on-chain. No effect on ticket revenue.
              </div>
            </>
          )}
        </div>

        {/* --- Final tickets sold (range) --- */}
        <div className="card space-y-3">
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
                  <span key={i} className="badge badge-line mono" style={{ fontSize: 11 }}>
                    {bucketLabel(range.cutoffs, i)}: {fmtAmount(t, usdcInfo.decimals)}
                  </span>
                ))}
              </div>
              {range.settled && (
                <span className="badge badge-soft mono">
                  Winner: {bucketLabel(range.cutoffs, range.winningBucket)}
                </span>
              )}
            </div>
          ) : rangeMarketId ? (
            <div className="mono text-sm" style={{ color: "var(--fg2)" }}>
              Loading…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {Array.from({ length: cutoffs.length + 1 }, (_, i) => (
                  <span key={i} className="badge badge-line mono" style={{ fontSize: 11 }}>
                    {bucketLabel(cutoffs, i)}
                  </span>
                ))}
              </div>
              <button
                className="btn btn-primary btn-sm"
                disabled={isPending}
                onClick={() =>
                  send(createRangeMarketTx(eventId, USDC_COIN_TYPE, cutoffs), afterCreate)
                }
              >
                <Icon icon="mdi:chart-bar" size={15} />
                {isPending ? "Opening…" : "Open final-sales market"}
              </button>
              <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                Ranges default to quartiles of {String(maxTickets)} max tickets. Settled on-chain.
              </div>
            </>
          )}
        </div>
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
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);

  function priceUnits(): bigint {
    const dec = coinInfo(coin).decimals;
    const n = Number(priceStr);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return BigInt(Math.round(n * 10 ** dec));
  }

  async function submit() {
    setErr(null);
    setOk(false);
    const units = priceUnits();
    if (units <= 0n) {
      setErr("Enter a price greater than zero.");
      return;
    }
    const addr = account?.address;
    if (!addr) {
      setErr("Connect a wallet to set a price.");
      return;
    }
    try {
      const tx = setPriceTx({ capId, eventId, coinType: coin, price: units });
      // set_price is on the sponsor allowlist — sponsor gas so organizers
      // without SUI can price events (mirrors create_event).
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      setOk(true);
      onDone();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <div className="font-medium">Set price</div>
        <div className="text-[13px]" style={{ color: "var(--fg3)" }}>
          Buyers pay this plus a 3% platform fee.
        </div>
      </div>
      <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
        <div>
          <label className="label">Coin</label>
          <select className="select" value={coin} onChange={(e) => setCoin(e.target.value)}>
            {COINS.map((c) => (
              <option key={c.type} value={c.type}>
                {c.symbol}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label className="label">Price ({coinInfo(coin).symbol})</label>
          <input
            className="input"
            type="number"
            min={0}
            step="any"
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" disabled={isPending} onClick={submit}>
          {isPending ? "Setting…" : "Set price"}
        </button>
      </div>
      {ok && (
        <div className="text-xs flex items-center gap-2" style={{ color: "var(--color-success)" }}>
          Price updated.{digest && <TxLink digest={digest} className="mono" />}
        </div>
      )}
      {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
    </div>
  );
}

// === Add check-in signer (ed25519 pubkey, hex) ===
function SignerPanel({ capId, eventId }: { capId: string; eventId: string }) {
  const account = useCurrentAccount();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [hex, setHex] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);

  async function add() {
    setErr(null);
    setOk(false);
    const clean = hex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length === 0) {
      setErr("Enter a hex-encoded ed25519 public key.");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = fromHex(clean);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Invalid hex.");
      return;
    }
    if (bytes.length !== 32) {
      setErr(`Public key must be 32 bytes (got ${bytes.length}).`);
      return;
    }
    const addr = account?.address;
    if (!addr) {
      setErr("Connect a wallet to add a signer.");
      return;
    }
    try {
      const tx = addCheckinSignerTx({ capId, eventId, pubkey: Array.from(bytes) });
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      setOk(true);
      setHex("");
    } catch (e: unknown) {
      setErr(humanizeError(e));
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
          <input
            className="input mono"
            placeholder="0x… (64 hex chars)"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" disabled={isPending} onClick={add}>
          {isPending ? "Adding…" : "Add signer"}
        </button>
      </div>
      {ok && (
        <div className="text-xs flex items-center gap-2" style={{ color: "var(--color-success)" }}>
          Signer added.{digest && <TxLink digest={digest} className="mono" />}
        </div>
      )}
      {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
    </div>
  );
}
