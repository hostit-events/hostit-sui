"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ENOKI_ENABLED, coinInfo } from "@/lib/config";
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
  onCategory?: (cat: string) => void;
}

function fmtAmount(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
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
  onCategory,
}: EventCardProps) {
  const q = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id: eventId,
    options: { showContent: true },
  });
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [meta, setMeta] = useState<EventMetadata | null>(null);

  const f = getFields(q.data ?? {});
  const uri = f ? String(f.uri ?? "") : "";

  useEffect(() => {
    let alive = true;
    if (uri) {
      getEventMetadata(uri).then((m) => {
        if (!alive) return;
        setMeta(m);
        if (m?.category && onCategory) onCategory(m.category);
      });
    }
    return () => {
      alive = false;
    };
  }, [uri, onCategory]);

  if (!f) {
    const hue = hashHue(eventId);
    return (
      <div className="ev-card">
        <div className="poster" style={{ height: 150, ["--p1" as string]: `hsl(${hue} 90% 58%)`, ["--p2" as string]: `hsl(${(hue + 46) % 360} 88% 46%)` } as React.CSSProperties}>
          <div className="poster-noise" />
        </div>
        <div className="ev-body"><div className="mono">{eventId.slice(0, 14)}… loading</div></div>
      </div>
    );
  }

  const name = String(f.name);
  const minted = BigInt((f.minted as string) ?? "0");
  const maxTickets = BigInt((f.max_tickets as string) ?? "0");
  const startMs = Number(f.start_ms);
  const endMs = Number(f.end_ms);
  const purchaseStartMs = Number(f.purchase_start_ms);
  const isRefundable = Boolean(f.is_refundable);

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

  async function run(tx: Transaction) {
    if (!buyerAddress) return;
    setErr(null);
    try {
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: buyerAddress })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      q.refetch();
    } catch (e: unknown) {
      setErr(humanizeError(e));
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
    <div className="ev-card">
      <Link href={`/event/${eventId}`} className="poster" style={{ height: 150, display: "block", ["--p1" as string]: p1, ["--p2" as string]: p2 } as React.CSSProperties}>
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
          {verified && <span className="badge badge-magenta"><Icon icon="streamline:star-badge-solid" size={11} /> Verified</span>}
          {hasMarket && <span className="badge badge-soft"><Icon icon="mdi:chart-line" size={11} /> Market</span>}
          {isFree && <span className="badge badge-green">Free</span>}
          {meta?.tag && <span className="badge" style={{ background: "rgba(0,0,0,.4)", color: "#fff" }}>{meta.tag}</span>}
        </div>
        <div className="absolute mono" style={{ bottom: 12, left: 14, color: "rgba(255,255,255,.92)", textShadow: "0 1px 4px rgba(0,0,0,.6)" }}>
          {String(remaining)}/{String(maxTickets)} left
        </div>
      </Link>

      <div className="ev-body">
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

        <div className="ev-foot" style={{ flexWrap: "wrap" }}>
          {isFree ? (
            <button className="btn btn-primary btn-sm" disabled={!canAct || isPending} onClick={() => run(claimFreeTx({ eventId, recipient: buyerAddress! }))}>
              <Icon icon="ion:ticket" size={15} />
              {isPending ? "Claiming…" : canAct ? "Claim free" : statusLabel()}
            </button>
          ) : prices.length === 0 ? (
            <span className="badge badge-line">Price not set</span>
          ) : (
            <div className="flex gap-2 flex-wrap">
              {prices.map((p) => {
                const ci = coinInfo(p.coinType);
                return (
                  <button
                    key={p.coinType}
                    className="btn btn-primary btn-sm"
                    disabled={!canAct || isPending}
                    title={`Total incl. 3% fee: ${fmtAmount(totalWithFee(BigInt(p.price)), ci.decimals)} ${ci.symbol}`}
                    onClick={() => run(buyTx({ eventId, coinType: p.coinType, priceUnits: BigInt(p.price), recipient: buyerAddress!, sponsored: ENOKI_ENABLED }))}
                  >
                    <Icon icon="ion:ticket" size={15} />
                    {isPending ? "Buying…" : canAct ? `${fmtAmount(BigInt(p.price), ci.decimals)} ${ci.symbol}` : statusLabel()}
                  </button>
                );
              })}
            </div>
          )}
          {digest && <TxLink digest={digest} chars={8} className="mono" />}
        </div>
        {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
      </div>
    </div>
  );
}
