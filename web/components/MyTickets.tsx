"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
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
import { useEventObjects } from "@/lib/events";
import { humanizeError } from "@/lib/moveErrors";
import { useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import { Icon } from "./Icon";
import { TxLink } from "./TxLink";
import { EventPoster } from "@/components/EventPoster";
import { TicketQr } from "@/components/TicketQr";
import { TicketDialog } from "@/components/TicketDialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
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

// The scannable QR now lives in components/TicketQr.tsx; re-exported here so the
// existing `import { TicketQr } from "../MyTickets"` (and its test) keep working.
export { TicketQr };

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

  // Refundability + window live on the Event object, not the ticket. Batch-read
  // every ticket's event in ONE chunked multiGetObjects call (was an N+1
  // per-card getObject) and pass each resolved object down to its stub.
  const eventIds = useMemo(
    () => Array.from(new Set(tickets.map((t) => String(t.fields.event_id)))),
    [tickets],
  );
  const { byId: eventObjects, isLoading: eventsLoading, refetch: refetchEvents } = useEventObjects(eventIds);

  const refresh = () => {
    void q.refetch();
    void refetchEvents();
  };

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
        <p style={{ marginTop: 10 }}>
          No tickets yet. Tickets you buy or claim show up here.{" "}
          <Link href="/discover" style={{ color: "var(--hi-blue)" }}>Discover events</Link>.
        </p>
      </Card>
    );

  // Tickets are loaded; show a skeleton grid ONLY while the batched event objects
  // are genuinely still loading. If the batch resolved empty (e.g. events orphaned
  // by a fresh publish) or errored, fall through and render the tickets with
  // degraded refund info rather than a permanent skeleton.
  if (eventsLoading && eventObjects.size === 0)
    return (
      <section className="space-y-5">
        <div>
          <h2 className="page-title" style={{ marginTop: 12, fontSize: 26 }}>
            My tickets <span style={{ color: "var(--fg3)" }}>({tickets.length})</span>
          </h2>
        </div>
        <div className="ev-grid">
          {tickets.map((t) => (
            <Skeleton key={t.id} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      </section>
    );

  return (
    <section className="space-y-5">
      <div>
        <h2 className="page-title" style={{ marginTop: 12, fontSize: 26 }}>
          My tickets <span style={{ color: "var(--fg3)" }}>({tickets.length})</span>
        </h2>
      </div>
      <div className="ev-grid">
        {tickets.map((t) => (
          <TicketStub
            key={t.id}
            ticketId={t.id}
            fields={t.fields}
            eventObject={eventObjects.get(String(t.fields.event_id)) ?? null}
            address={address}
            onChange={refresh}
          />
        ))}
      </div>
    </section>
  );
}

function TicketStub({
  ticketId,
  fields,
  eventObject,
  address,
  onChange,
}: {
  ticketId: string;
  fields: Record<string, unknown>;
  /** Pre-fetched Event object from the batched multiGetObjects read. */
  eventObject: SuiObjectResponse | null;
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
  const [open, setOpen] = useState(false);

  const issued = status === TICKET_STATUS.ISSUED;
  const checkedIn = status === TICKET_STATUS.CHECKED_IN;
  const refundCoin = COINS.find((c) => matchesCoinType(paidType, c.type))?.type ?? `0x${paidType}`;
  const ci = coinInfo(refundCoin);

  // Refundability + window live on the Event object, not the ticket. The
  // parent batch-reads every event in one multiGetObjects and passes it down.
  const ef = getFields(eventObject ?? {});
  const isRefundable = ef ? Boolean(ef.is_refundable) : false;
  const endMs = ef ? Number(ef.end_ms) : 0;
  const refundOpensMs = endMs;
  const refundClosesMs = endMs + REFUND_PERIOD_MS;
  const now = Date.now();
  const inRefundWindow = now >= refundOpensMs && now <= refundClosesMs;
  const startMs = ef ? Number(ef.start_ms) : undefined;
  const eventUri = ef ? String(ef.uri ?? "") : undefined;

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

  // Check-in + refund controls — shared between the card face and the dialog so
  // the logic lives in one place. Each interactive control stops propagation so
  // tapping it doesn't also open the dialog.
  function renderActions() {
    return (
      <>
        {(issued || checkedIn) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  send(() => selfCheckInTx({ eventId, ticketId }), "Checked in");
                }}
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
                  onClick={(e) => {
                    e.stopPropagation();
                    send(() => refundTx({ eventId, ticketId, coinType: refundCoin, recipient: address }), "Refund requested");
                  }}
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
      </>
    );
  }

  return (
    <>
      <div className="ev-card relative">
        {/* Whole-card opener: a real <button> layered over the card so the card
            is clickable + keyboard-activatable WITHOUT nesting the Link/action
            buttons inside an interactive element — those sit above it via z-index
            (block-link pattern). */}
        <button
          type="button"
          aria-label={`Open ticket: ${name}`}
          onClick={() => setOpen(true)}
          className="absolute inset-0 z-[1] cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
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
              className="mono relative z-[2] self-start"
              style={{ color: "var(--fg3)", overflow: "hidden", textOverflow: "ellipsis" }}
            >
              event {eventId.slice(0, 10)}…
            </Link>
            {paid > 0n && (
              <Badge variant="secondary" className="self-start">
                paid {ci.symbol}
              </Badge>
            )}
            <div className="relative z-[2] flex gap-2 flex-wrap" style={{ marginTop: 2 }}>
              {renderActions()}
            </div>
          </div>
          <TicketQr ticketId={ticketId} />
        </div>
      </div>

      <TicketDialog
        open={open}
        onOpenChange={setOpen}
        ticketId={ticketId}
        name={name}
        serial={serial}
        eventId={eventId}
        checkedIn={checkedIn}
        startMs={startMs}
        uri={eventUri}
        actions={renderActions()}
      />
    </>
  );
}
