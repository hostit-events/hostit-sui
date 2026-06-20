"use client";

import { useMemo } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  COINS,
  ENOKI_ENABLED,
  REFUND_PERIOD_MS,
  TICKET_STATUS,
  TICKET_TYPE,
  coinInfo,
  matchesCoinType,
} from "@/lib/config";
import { refundTx, selfCheckInTx, getFields } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import { useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import { Icon } from "./Icon";
import { TxLink } from "./TxLink";
import { EventPoster } from "@/components/EventPoster";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

function fmtRefundDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Deterministic faux-QR matrix (ticket-stub motif). Retained as the SSR/loading
 * fallback look; the scannable QR is rendered by {@link TicketQr}.
 */
function FauxQr({ seed, size = 54, dim = 11 }: { seed: string; size?: number; dim?: number }) {
  const cells = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const out: boolean[] = [];
    for (let i = 0; i < dim * dim; i++) {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      out.push((h >>> 0) % 100 < 48);
    }
    return out;
  }, [seed, dim]);
  const isFinder = (r: number, c: number) =>
    (r < 3 && c < 3) || (r < 3 && c >= dim - 3) || (r >= dim - 3 && c < 3);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "grid",
        gridTemplateColumns: `repeat(${dim},1fr)`,
        gridTemplateRows: `repeat(${dim},1fr)`,
        gap: 1.4,
        background: "#fff",
        padding: 4,
        borderRadius: 7,
        flex: "none",
      }}
    >
      {cells.map((on, i) => {
        const r = Math.floor(i / dim);
        const c = i % dim;
        const f = isFinder(r, c);
        const fill = f
          ? r === 0 || r === 2 || r === dim - 1 || r === dim - 3 || c === 0 || c === 2 || c === dim - 1 || c === dim - 3
          : on;
        return <span key={i} style={{ background: fill ? "#0C112B" : "transparent", borderRadius: 1 }} />;
      })}
    </div>
  );
}

/**
 * Real, scannable QR encoding the ticket's bare on-chain object id. The door
 * camera scanner decodes it and `extractTicketId` (lib/staffKey.ts) reads the id
 * directly via its `isValidSuiObjectId` branch — so the encoded value MUST be the
 * bare object id, with no URL/JSON wrapper. `QRCodeSVG` renders an inline SVG and
 * is SSR-safe (no canvas/DOM-measure), so no client-only guard is needed.
 */
export function TicketQr({ ticketId, size = 54 }: { ticketId: string; size?: number }) {
  return (
    <div style={{ background: "#fff", padding: 4, borderRadius: 7, flex: "none", lineHeight: 0 }}>
      <QRCodeSVG
        value={ticketId}
        size={size}
        bgColor="#ffffff"
        fgColor="#0C112B"
        level="M"
        aria-label="Ticket QR code"
      />
    </div>
  );
}

export function MyTickets({ address }: { address: string }) {
  const q = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: address,
      filter: { StructType: TICKET_TYPE },
      options: { showContent: true, showType: true },
    },
  );

  const tickets = useMemo(() => {
    if (!q.data) return [];
    return q.data.data.flatMap((entry) => {
      const fields = getFields(entry);
      if (!entry.data?.objectId || !fields) return [];
      return [{ id: entry.data.objectId, fields }];
    });
  }, [q.data]);

  if (q.isLoading)
    return (
      <Card className="mono p-4" role="status" aria-live="polite">
        Loading your tickets…
      </Card>
    );
  if (q.error)
    return (
      <Card className="flex flex-row flex-wrap items-center gap-2 p-4" style={{ color: "var(--color-danger)" }}>
        Couldn&apos;t load your tickets.{" "}
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
      </Card>
    );
  if (tickets.length === 0)
    return (
      <Card className="p-4" style={{ color: "var(--fg3)" }}>
        <span className="eyebrow">
          <Icon icon="ion:ticket" size={14} /> Wallet
        </span>
        <p style={{ marginTop: 10 }}>
          No tickets yet. Tickets you buy or claim show up here.{" "}
          <Link href="/discover" style={{ color: "var(--hi-blue)" }}>Discover events</Link>.
        </p>
      </Card>
    );

  return (
    <section className="space-y-5">
      <div>
        <span className="eyebrow">
          <Icon icon="ion:ticket" size={14} /> Wallet
        </span>
        <h2 className="page-title" style={{ marginTop: 12, fontSize: 26 }}>
          My tickets <span style={{ color: "var(--fg3)" }}>({tickets.length})</span>
        </h2>
      </div>
      <div className="ev-grid">
        {tickets.map((t) => (
          <TicketStub key={t.id} ticketId={t.id} fields={t.fields} address={address} onChange={() => q.refetch()} />
        ))}
      </div>
    </section>
  );
}

function TicketStub({
  ticketId,
  fields,
  address,
  onChange,
}: {
  ticketId: string;
  fields: Record<string, unknown>;
  address: string;
  onChange: () => void;
}) {
  const name = String(fields.name);
  const status = Number(fields.status);
  const serial = String(fields.serial);
  const eventId = String(fields.event_id);
  const paid = BigInt((fields.paid as string) ?? "0");
  const paidType = String(fields.paid_type ?? "");
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;

  const issued = status === TICKET_STATUS.ISSUED;
  const checkedIn = status === TICKET_STATUS.CHECKED_IN;
  const refundCoin = COINS.find((c) => matchesCoinType(paidType, c.type))?.type ?? `0x${paidType}`;
  const ci = coinInfo(refundCoin);

  // Refundability + window live on the Event object, not the ticket.
  const eventQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id: eventId,
    options: { showContent: true },
  });
  const ef = getFields(eventQ.data ?? {});
  const isRefundable = ef ? Boolean(ef.is_refundable) : false;
  const endMs = ef ? Number(ef.end_ms) : 0;
  const refundOpensMs = endMs;
  const refundClosesMs = endMs + REFUND_PERIOD_MS;
  const now = Date.now();
  const inRefundWindow = now >= refundOpensMs && now <= refundClosesMs;

  async function send(build: () => ReturnType<typeof selfCheckInTx>, success: string) {
    try {
      const tx = build();
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: address })
        : await regular.mutateAsync({ transaction: tx });
      toast.success(success, {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      onChange();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <div className="ev-card">
      {/* poster header strip */}
      <div className="poster flex items-center justify-between" style={{ padding: "14px 16px" }}>
        <EventPoster seed={ticketId} glyph={false} className="absolute inset-0" />
        <div className="relative">
          <div className="ev-title" style={{ color: "#fff" }}>
            {name}
          </div>
          <div className="mono" style={{ color: "rgba(255,255,255,.85)" }}>
            #{serial}
          </div>
        </div>
        <div className="relative">
          {checkedIn ? (
            <Badge variant="secondary">Checked in</Badge>
          ) : (
            <Badge variant="secondary" style={{ background: "rgba(255,255,255,.18)", color: "#fff" }}>
              Valid
            </Badge>
          )}
        </div>
      </div>

      {/* perforation seam */}
      <div style={{ height: 0, borderTop: "2px dashed rgba(255,255,255,.22)", margin: "0 12px" }} />

      <div className="ev-body" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div className="flex flex-col gap-2 grow" style={{ minWidth: 0 }}>
          <Link
            href={`/event/${eventId}`}
            className="mono"
            style={{ color: "var(--fg3)", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            event {eventId.slice(0, 10)}…
          </Link>
          {paid > 0n && (
            <Badge variant="secondary" className="self-start">
              paid {ci.symbol}
            </Badge>
          )}
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 2 }}>
            {(issued || checkedIn) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    disabled={isPending}
                    onClick={() => send(() => selfCheckInTx({ eventId, ticketId }), "Checked in")}
                  >
                    <Icon icon="zondicons:inbox-check" size={15} /> Check in
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Self check-in (organizer must enable it, within the event window). Staffed gates use an ed25519 voucher.
                </TooltipContent>
              </Tooltip>
            )}
            {issued && paid > 0n && ef && (
              isRefundable && inRefundWindow ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isPending}
                      onClick={() => send(() => refundTx({ eventId, ticketId, coinType: refundCoin, recipient: address }), "Refund requested")}
                    >
                      Refund
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refund window closes {fmtRefundDate(refundClosesMs)}.</TooltipContent>
                </Tooltip>
              ) : !isRefundable ? (
                <Badge variant="secondary" className="self-start">
                  Non-refundable
                </Badge>
              ) : now < refundOpensMs ? (
                <Badge variant="secondary" className="self-start">
                  Refundable {fmtRefundDate(refundOpensMs)} – {fmtRefundDate(refundClosesMs)}
                </Badge>
              ) : (
                <Badge variant="secondary" className="self-start">
                  Refund window closed
                </Badge>
              )
            )}
          </div>
        </div>
        <TicketQr ticketId={ticketId} />
      </div>
    </div>
  );
}
