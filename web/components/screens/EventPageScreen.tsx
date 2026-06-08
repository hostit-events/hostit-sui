"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Transaction } from "@mysten/sui/transactions";
import { ENOKI_ENABLED, REFUND_PERIOD_MS, coinInfo } from "@/lib/config";
import { buyTx, claimFreeTx, getFields, totalWithFee } from "@/lib/ticketing";
import {
  useCurrentAccount,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { useEventList } from "@/lib/events";
import { humanizeError } from "@/lib/moveErrors";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { blobUrl, isBlobId } from "@/lib/walrus";
import { catPalette, catGlyph } from "@/lib/data";
import { useIsVerified } from "@/lib/verification";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { EventMarketsScreen } from "@/components/screens/EventMarketsScreen";
import type { GetObjectParams, SuiObjectResponse } from "@mysten/sui/jsonRpc";

// Inline amount formatter (mirrors EventCard; not exported from a lib).
function fmtAmount(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

// Inline FNV hash for a deterministic fallback poster hue when no category meta.
function hashHue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

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

function GoodToKnow({ icon, title, value }: { icon: string; title: string; value: string }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="flex items-center gap-1.5 eyebrow" style={{ margin: 0 }}>
        <Icon icon={icon} size={14} /> {title}
      </div>
      <div className="text-sm" style={{ color: "var(--fg1)", marginTop: 6 }}>
        {value}
      </div>
    </div>
  );
}

export function EventPageScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id,
    options: { showContent: true },
  });

  const { pricesBySeq } = useEventList();

  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const [meta, setMeta] = useState<EventMetadata | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

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

  // ---- loading / error / not-found ----
  if (q.isLoading) {
    return (
      <div className="space-y-6 screen-in">
        <div className="poster" style={{ height: 240 }}>
          <div className="poster-noise" />
        </div>
        <div className="card mono">Loading event…</div>
      </div>
    );
  }
  if (!f) {
    return (
      <div className="space-y-6 screen-in">
        <div className="card">
          <div className="font-semibold">Event not found.</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            This object isn&apos;t a HostIt event, or it failed to load.{" "}
            <Link href="/discover" style={{ color: "var(--hi-blue)" }}>
              Back to Discover
            </Link>
            .
          </p>
        </div>
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
  const canAct = Boolean(addr) && !soldOut && windowOpen;
  const isOrganizer = Boolean(addr) && addr === organizer;

  const prices = pricesBySeq.get(eventSeq) ?? [];

  const cat = meta?.category;
  const [p1, p2] = cat
    ? catPalette(cat)
    : (() => {
        const hue = hashHue(id);
        return [`hsl(${hue} 90% 58%)`, `hsl(${(hue + 46) % 360} 88% 46%)`] as [string, string];
      })();
  const coverUrl =
    meta?.coverBlobId && isBlobId(meta.coverBlobId) ? blobUrl(meta.coverBlobId) : undefined;
  const glyphIcon = catGlyph(cat);

  const venueCity = [meta?.venue, meta?.city].filter(Boolean).join(" · ");
  const coinLabels = prices.length
    ? Array.from(new Set(prices.map((p) => coinInfo(p.coinType).symbol))).join(", ")
    : isFree
      ? "Free"
      : "—";

  async function run(tx: Transaction) {
    if (!addr) return;
    setErr(null);
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      q.refetch();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  function statusLabel(): string {
    if (!addr) return "Connect wallet to buy";
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
            ["--p1" as string]: p1,
            ["--p2" as string]: p2,
          } as React.CSSProperties
        }
      >
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
        <span className="poster-glyph">
          <Icon icon={glyphIcon} size={120} />
        </span>
        <div
          className="absolute flex gap-1.5"
          style={{ top: 14, left: 14, flexWrap: "wrap" }}
        >
          {meta?.tag && (
            <span className="badge" style={{ background: "rgba(0,0,0,.45)", color: "#fff" }}>
              {meta.tag}
            </span>
          )}
          {isFree && <span className="badge badge-green">Free</span>}
          {verified && (
            <span className="badge badge-magenta">
              <Icon icon="streamline:star-badge-solid" size={11} /> Verified
            </span>
          )}
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
            {cat && <span className="eyebrow">{cat}</span>}
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
          <div className="card flex flex-wrap items-center justify-between gap-3" style={{ padding: 16 }}>
            <div className="flex items-center gap-2 text-sm">
              <Icon icon="solar:user-rounded-bold" size={16} />
              <span style={{ color: "var(--fg2)" }}>Hosted by</span>
              <AddressDisplay address={organizer} suffix={4} />
              {verified && (
                <span className="badge badge-magenta">
                  <Icon icon="streamline:star-badge-solid" size={11} /> Verified
                </span>
              )}
            </div>
            <Link href={`/forum/${id}`} className="btn btn-sm">
              <Icon icon="ion:chatbubbles" size={15} /> Event chat
            </Link>
          </div>

          {/* About */}
          <div className="space-y-3">
            <h2 className="eyebrow">
              <Icon icon="ph:info-bold" size={14} /> About
            </h2>
            <p className="text-sm whitespace-pre-wrap" style={{ color: "var(--fg2)", lineHeight: 1.7 }}>
              {meta?.description?.trim() || "No description was provided for this event."}
            </p>
          </div>

          {/* Good to know */}
          <div className="space-y-3">
            <h2 className="eyebrow">
              <Icon icon="ph:list-checks-bold" size={14} /> Good to know
            </h2>
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
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
                    ? `Refundable up to ${Math.round(REFUND_PERIOD_MS / 86_400_000)} days before`
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

          {/* Markets — parimutuel prediction markets (Sellout Clock + range) */}
          <div className="space-y-3">
            <h2 className="eyebrow">
              <Icon icon="mdi:chart-line" size={14} /> Markets
            </h2>
            <EventMarketsScreen eventId={id} eventSeq={eventSeq} maxTickets={maxTickets} />
          </div>
        </div>

        {/* ---- Sticky ticket panel ---- */}
        <div>
          <div className="card space-y-4" style={{ position: "sticky", top: 24 }}>
            <div>
              <h2 className="eyebrow" style={{ margin: 0 }}>
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

            {/* Buy / claim actions */}
            {isFree ? (
              <button
                className="btn btn-primary btn-block"
                disabled={!canAct || isPending}
                onClick={() => run(claimFreeTx({ eventId: id, recipient: addr! }))}
              >
                <Icon icon="ion:ticket" size={16} />
                {isPending ? "Claiming…" : canAct ? "Claim free ticket" : statusLabel()}
              </button>
            ) : prices.length === 0 ? (
              <span className="badge badge-line">Price not set by organizer</span>
            ) : (
              <div className="space-y-2">
                {prices.map((p) => {
                  const ci = coinInfo(p.coinType);
                  const total = totalWithFee(BigInt(p.price));
                  return (
                    <button
                      key={p.coinType}
                      className="btn btn-primary btn-block"
                      disabled={!canAct || isPending}
                      title={`Total incl. 3% fee: ${fmtAmount(total, ci.decimals)} ${ci.symbol}`}
                      onClick={() =>
                        run(
                          buyTx({
                            eventId: id,
                            coinType: p.coinType,
                            priceUnits: BigInt(p.price),
                            recipient: addr!,
                            sponsored: ENOKI_ENABLED,
                          }),
                        )
                      }
                    >
                      <Icon icon="ion:ticket" size={16} />
                      {isPending
                        ? "Buying…"
                        : canAct
                          ? `Buy · ${fmtAmount(BigInt(p.price), ci.decimals)} ${ci.symbol}`
                          : statusLabel()}
                    </button>
                  );
                })}
                <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
                  A 3% platform fee is added at checkout.
                </div>
              </div>
            )}

            {!addr && (
              <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
                Connect a wallet to buy or claim.
              </div>
            )}
            {now < purchaseStartMs && (
              <div className="text-[12px]" style={{ color: "var(--fg3)" }}>
                Sales open {fmtDate(purchaseStartMs)} at {fmtTime(purchaseStartMs)}.
              </div>
            )}

            {digest && (
              <TxLink
                digest={digest}
                className="mono text-[12px]"
                style={{ color: "var(--color-success)" }}
                before={<><Icon icon="ph:check-circle-bold" size={13} />{" "}</>}
              />
            )}
            {err && (
              <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>
                {err}
              </div>
            )}

            {isOrganizer && (
              <Link href={`/manage/${id}`} className="btn btn-block">
                <Icon icon="material-symbols-light:settings-rounded" size={16} /> Manage event
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
