"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ENOKI_ENABLED,
  TICKET_STATUS,
  TICKET_TYPE,
} from "@/lib/config";
import { getFields } from "@/lib/ticketing";
import { claimPoapTx, POAP_TYPE } from "@/lib/poap";
import { catPalette, catGlyph, PAL } from "@/lib/data";
import { useCurrentAccount, useSignAndExecute, useSponsorAndExecute, useSuiQuery } from "@/lib/hooks";
import { useSuiNSName } from "@/lib/suins";
import { MyTickets } from "@/components/MyTickets";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import type {
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
} from "@mysten/sui/jsonRpc";

type Tab = "tickets" | "collectibles" | "saved";

/** Deterministic category id from a numeric event seq → stable poster palette. */
function paletteCatForSeq(seq: string): string {
  const keys = Object.keys(PAL).filter((k) => k !== "default");
  let h = 2166136261;
  for (let i = 0; i < seq.length; i++) {
    h ^= seq.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return keys[Math.abs(h) % keys.length];
}

export function WalletScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;

  if (!addr) {
    return (
      <div className="space-y-8 screen-in">
        <header className="relative">
          <div className="glow" style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }} />
          <h1 className="page-title" style={{ fontSize: 34 }}>Your tickets &amp; collectibles</h1>
          <p className="page-sub">Connect a wallet to see your tickets, POAPs and saved events.</p>
        </header>
        <div className="card flex flex-col items-center text-center gap-3" style={{ padding: 40 }}>
          <span style={{ color: "var(--hi-blue)" }}><Icon icon="solar:wallet-bold" size={44} /></span>
          <div className="font-semibold" style={{ fontSize: 18 }}>No wallet connected</div>
          <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>
            Connect your Sui wallet using the button in the top bar to access your wallet. In the meantime you can{" "}
            <Link href="/" style={{ color: "var(--hi-blue)" }}>discover events</Link>.
          </p>
        </div>
      </div>
    );
  }

  return <WalletInner addr={addr} />;
}

function WalletInner({ addr }: { addr: string }) {
  const [tab, setTab] = useState<Tab>("tickets");
  const { data: suinsName } = useSuiNSName(addr);

  const ticketsQuery = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: addr,
      filter: { StructType: TICKET_TYPE },
      options: { showContent: true, showType: true },
    },
  );

  const poapsQuery = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: addr,
      filter: { StructType: POAP_TYPE },
      options: { showContent: true },
    },
  );

  const tickets = useMemo(() => {
    if (!ticketsQuery.data) return [];
    return ticketsQuery.data.data.flatMap((entry) => {
      const fields = getFields(entry);
      if (!entry.data?.objectId || !fields) return [];
      return [{ id: entry.data.objectId, fields }];
    });
  }, [ticketsQuery.data]);

  const poaps = useMemo(() => {
    if (!poapsQuery.data) return [];
    return poapsQuery.data.data.flatMap((entry) => {
      const fields = getFields(entry);
      if (!entry.data?.objectId || !fields) return [];
      return [{ id: entry.data.objectId, fields }];
    });
  }, [poapsQuery.data]);

  const checkedIn = useMemo(
    () => tickets.filter((t) => Number(t.fields.status) === TICKET_STATUS.CHECKED_IN),
    [tickets],
  );

  const TABS: { id: Tab; label: string; icon: string; count?: number }[] = [
    { id: "tickets", label: "My tickets", icon: "ion:ticket", count: tickets.length },
    { id: "collectibles", label: "Collectibles", icon: "ph:medal-fill", count: poaps.length },
    { id: "saved", label: "Saved", icon: "solar:bookmark-bold" },
  ];

  return (
    <div className="space-y-8 screen-in">
      {/* Profile header */}
      <header className="card relative flex items-center gap-4" style={{ overflow: "hidden" }}>
        <div className="glow" style={{ width: 300, height: 300, background: "rgba(0,124,250,.4)", top: -160, right: -40, opacity: 0.2 }} />
        <div
          className="poster flex items-center justify-center"
          style={{ width: 64, height: 64, flex: "none", ["--p1" as string]: "var(--hi-blue)", ["--p2" as string]: "var(--hi-magenta)" } as React.CSSProperties}
        >
          <div className="poster-noise" />
          <span className="relative" style={{ color: "#fff" }}><Icon icon="solar:wallet-bold" size={30} /></span>
        </div>
        <div className="relative grow" style={{ minWidth: 0 }}>
          <div className="page-title" style={{ fontSize: 24 }}>
            {suinsName ? `@${suinsName}` : "Your wallet"}
          </div>
          <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 6 }}>
            <AddressDisplay address={addr} suffix={4} />
            <span className="badge badge-soft"><Icon icon="ion:ticket" size={11} /> {tickets.length} ticket{tickets.length === 1 ? "" : "s"}</span>
            {poaps.length > 0 && <span className="badge badge-magenta"><Icon icon="ph:medal-fill" size={11} /> {poaps.length} POAP{poaps.length === 1 ? "" : "s"}</span>}
          </div>
        </div>
      </header>

      {/* Claim POAP strip — checked-in tickets with an unclaimed proof-of-attendance */}
      {checkedIn.length > 0 && (
        <section className="card space-y-3">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--hi-magenta)" }}><Icon icon="ph:medal-fill" size={18} /></span>
            <div>
              <div className="font-semibold">Claim your proof-of-attendance</div>
              <p className="text-sm" style={{ color: "var(--fg2)" }}>
                You checked in to {checkedIn.length} event{checkedIn.length === 1 ? "" : "s"}. Mint a POAP for each (once per ticket).
              </p>
            </div>
          </div>
          <div className="space-y-2">
            {checkedIn.map((t) => (
              <ClaimPoapRow
                key={t.id}
                ticketId={t.id}
                fields={t.fields}
                address={addr}
                onClaimed={() => {
                  ticketsQuery.refetch();
                  poapsQuery.refetch();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* Segmented tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.id} className={`chip ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            <Icon icon={t.icon} size={14} /> {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span style={{ opacity: 0.7 }}> ({t.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === "tickets" && (
        <div>
          {ticketsQuery.isLoading ? (
            <div className="card mono">Loading tickets…</div>
          ) : tickets.length === 0 ? (
            <EmptyState
              icon="ion:ticket"
              title="No tickets yet"
              body={<>Tickets you buy or claim show up here.{" "}<Link href="/" style={{ color: "var(--hi-blue)" }}>Discover events</Link>.</>}
            />
          ) : (
            <MyTickets address={addr} />
          )}
        </div>
      )}

      {tab === "collectibles" && (
        <div>
          {poapsQuery.isLoading ? (
            <div className="card mono">Loading collectibles…</div>
          ) : poaps.length === 0 ? (
            <EmptyState
              icon="ph:medal-fill"
              title="No collectibles yet"
              body={<>Check in to an event, then claim a POAP from the strip above to start your collection.</>}
            />
          ) : (
            <div className="ev-grid">
              {poaps.map((p) => (
                <PoapCard key={p.id} fields={p.fields} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "saved" && (
        <EmptyState
          icon="solar:bookmark-bold"
          title="Nothing saved yet"
          body={<>Bookmarks live on your device for now. Browse the{" "}<Link href="/" style={{ color: "var(--hi-blue)" }}>Discover</Link>{" "}feed and save events you want to come back to. (On-chain wishlists are coming in v2.)</>}
        />
      )}
    </div>
  );
}

function EmptyState({ icon, title, body }: { icon: string; title: string; body: React.ReactNode }) {
  return (
    <div className="card flex flex-col items-center text-center gap-2" style={{ padding: 40 }}>
      <span style={{ color: "var(--fg3)" }}><Icon icon={icon} size={38} /></span>
      <div className="font-semibold" style={{ fontSize: 16 }}>{title}</div>
      <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>{body}</p>
    </div>
  );
}

function PoapCard({ fields }: { fields: Record<string, unknown> }) {
  const name = String(fields.name ?? "POAP");
  const eventSeq = String(fields.event_seq ?? "0");
  const eventId = String(fields.event_id ?? "");
  const [p1, p2] = catPalette(paletteCatForSeq(eventSeq));
  const glyph = catGlyph(paletteCatForSeq(eventSeq));

  return (
    <div className="ev-card">
      <div
        className="poster flex items-center justify-center"
        style={{ height: 150, ["--p1" as string]: p1, ["--p2" as string]: p2 } as React.CSSProperties}
      >
        <div className="poster-noise" />
        <span className="poster-glyph"><Icon icon={glyph} size={64} /></span>
        <div className="absolute" style={{ top: 12, left: 12 }}>
          <span className="badge" style={{ background: "rgba(0,0,0,.4)", color: "#fff" }}>
            <Icon icon="ph:medal-fill" size={11} /> POAP
          </span>
        </div>
        <div className="relative flex flex-col items-center gap-1" style={{ color: "#fff" }}>
          <span style={{ opacity: 0.92 }}><Icon icon="ph:seal-check-fill" size={30} /></span>
        </div>
      </div>
      <div className="ev-body">
        <div className="ev-title" style={{ color: "var(--fg1)" }}>{name}</div>
        <div className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--fg3)" }}>
          <Icon icon="proicons:calendar" size={14} />
          <span className="mono">event #{eventSeq}</span>
        </div>
        {eventId && (
          <Link href={`/event/${eventId}`} className="mono" style={{ color: "var(--fg3)", overflow: "hidden", textOverflow: "ellipsis" }}>
            {eventId.slice(0, 12)}…
          </Link>
        )}
      </div>
    </div>
  );
}

function ClaimPoapRow({
  ticketId,
  fields,
  address,
  onClaimed,
}: {
  ticketId: string;
  fields: Record<string, unknown>;
  address: string;
  onClaimed: () => void;
}) {
  const name = String(fields.name ?? "Ticket");
  const eventId = String(fields.event_id ?? "");
  const serial = String(fields.serial ?? "");
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const isPending = regular.isPending || sponsored.isPending;
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [digest, setDigest] = useState<string | null>(null);

  async function claim() {
    setErr(null);
    try {
      const tx = claimPoapTx(eventId, ticketId);
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: address })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      setDone(true);
      onClaimed();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="panel flex items-center justify-between gap-3" style={{ padding: "12px 14px" }}>
      <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
        <span className="badge badge-green" style={{ flex: "none" }}>Checked in</span>
        <div style={{ minWidth: 0 }}>
          <div className="font-medium" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
          <div className="mono">#{serial} · event {eventId.slice(0, 10)}…</div>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1" style={{ flex: "none" }}>
        {done ? (
          <span className="badge badge-magenta"><Icon icon="ph:seal-check-fill" size={12} /> Claimed</span>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={isPending} onClick={claim}>
            <Icon icon="ph:medal-fill" size={14} /> {isPending ? "Claiming…" : "Claim POAP"}
          </button>
        )}
        {digest && <TxLink digest={digest} className="mono text-xs" style={{ color: "var(--color-success)" }} />}
        {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)", maxWidth: 200 }}>{err}</div>}
      </div>
    </div>
  );
}
