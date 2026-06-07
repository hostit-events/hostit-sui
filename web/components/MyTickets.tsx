"use client";

import { useMemo, useState } from "react";
import {
  COINS,
  ENOKI_ENABLED,
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
import type { GetOwnedObjectsParams, PaginatedObjectsResponse } from "@mysten/sui/jsonRpc";

/** Deterministic faux-QR matrix (ticket-stub motif). */
function Qr({ seed, size = 54, dim = 11 }: { seed: string; size?: number; dim?: number }) {
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

  if (q.isLoading) return null;
  if (tickets.length === 0) return null;

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

function posterVars(seed: string): React.CSSProperties {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return { "--p1": `hsl(${hue} 92% 60%)`, "--p2": `hsl(${(hue + 46) % 360} 90% 48%)` } as React.CSSProperties;
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
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  const issued = status === TICKET_STATUS.ISSUED;
  const checkedIn = status === TICKET_STATUS.CHECKED_IN;
  const refundCoin = COINS.find((c) => matchesCoinType(paidType, c.type))?.type ?? `0x${paidType}`;
  const ci = coinInfo(refundCoin);

  async function send(build: () => ReturnType<typeof selfCheckInTx>) {
    setErr(null);
    try {
      const tx = build();
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: address })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      onChange();
    } catch (e: unknown) {
      setErr(humanizeError(e));
    }
  }

  return (
    <div className="ev-card" style={posterVars(ticketId)}>
      {/* poster header strip */}
      <div className="poster flex items-center justify-between" style={{ padding: "14px 16px" }}>
        <div className="poster-noise" />
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
            <span className="badge badge-green">Checked in</span>
          ) : (
            <span className="badge" style={{ background: "rgba(255,255,255,.18)", color: "#fff" }}>
              Valid
            </span>
          )}
        </div>
      </div>

      {/* perforation seam */}
      <div style={{ height: 0, borderTop: "2px dashed rgba(255,255,255,.22)", margin: "0 12px" }} />

      <div className="ev-body" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
        <div className="flex flex-col gap-2 grow" style={{ minWidth: 0 }}>
          <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            event {eventId.slice(0, 10)}…
          </div>
          {paid > 0n && (
            <span className="badge badge-soft" style={{ alignSelf: "flex-start" }}>
              paid {ci.symbol}
            </span>
          )}
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 2 }}>
            {(issued || checkedIn) && (
              <button
                className="btn btn-primary btn-sm"
                disabled={isPending}
                onClick={() => send(() => selfCheckInTx({ eventId, ticketId }))}
                title="Self check-in (organizer must enable it, within the event window). Staffed gates use an ed25519 voucher."
              >
                <Icon icon="zondicons:inbox-check" size={15} /> Check in
              </button>
            )}
            {issued && paid > 0n && (
              <button
                className="btn btn-sm"
                disabled={isPending}
                onClick={() => send(() => refundTx({ eventId, ticketId, coinType: refundCoin, recipient: address }))}
                title="Refundable events only, within the post-event refund window."
              >
                Refund
              </button>
            )}
          </div>
          {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
          {digest && <TxLink digest={digest} className="mono text-xs" style={{ color: "var(--color-success)" }} />}
        </div>
        <Qr seed={ticketId} />
      </div>
    </div>
  );
}
