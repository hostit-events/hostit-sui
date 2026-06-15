"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useCurrentAccount, useSuiQuery } from "@/lib/hooks";
import { useEventList } from "@/lib/events";
import { COINS, PACKAGE_ID, EV_TICKET_MINTED, coinInfo, matchesCoinType } from "@/lib/config";
import { MyEvents } from "@/components/MyEvents";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { PaginatedEvents, QueryEventsParams } from "@mysten/sui/jsonRpc";

// Inline event-type strings (built the same way config builds EV_TICKET_MINTED).
const EV_POAP_CLAIMED = `${PACKAGE_ID}::poap::PoapClaimed`;
const EV_CHECKED_IN = `${PACKAGE_ID}::checkin::CheckedIn`;

// --- inline parsedJson shapes (match the Move event structs) ---
interface TicketMintedJson {
  event_seq: string | number;
  event_id: string;
  ticket_id: string;
  serial: string | number;
  buyer: string;
  recipient: string;
  coin_type: string; // ascii::String (no 0x, may be padded)
  total_paid: string | number;
}
interface CheckedInJson {
  event_seq: string | number;
  event_id: string;
}
interface PoapClaimedJson {
  event_seq: string | number;
  event_id: string;
}

interface MintRow {
  serial: string;
  buyer: string;
  coinType: string;
  totalPaid: bigint;
  timestampMs: number | null;
  eventSeq: string;
}

/** Resolve an emitted ascii coin_type to a known COINS entry (else `0x…`). */
function resolveCoin(coinType: string): string {
  return COINS.find((c) => matchesCoinType(coinType, c.type))?.type ?? `0x${coinType}`;
}

/** Format smallest-unit bigint with a coin's decimals, trimming trailing zeros. */
function fmtAmount(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr}`;
}

/** Compact one or more coin totals into a single human label. */
function grossLabel(byCoin: Map<string, bigint>): string {
  const parts = Array.from(byCoin.entries())
    .filter(([, v]) => v > 0n)
    .map(([type, units]) => {
      const ci = coinInfo(type);
      return `${fmtAmount(units, ci.decimals)} ${ci.symbol}`;
    });
  return parts.length ? parts.join(" · ") : "0";
}

function StatTile({
  icon,
  num,
  label,
  fill = false,
}: {
  icon: string;
  num: string;
  label: string;
  fill?: boolean;
}) {
  return (
    <div className={`stat-tile ${fill ? "fill" : ""}`}>
      <div className="flex items-center gap-1.5" style={{ color: fill ? "#fff" : "var(--hi-blue)" }}>
        <Icon icon={icon} size={16} />
        <span className="stat-label" style={fill ? { color: "rgba(255,255,255,.85)" } : undefined}>
          {label}
        </span>
      </div>
      <div className="stat-num" style={{ marginTop: 10, color: fill ? "#fff" : "var(--fg1)" }}>
        {num}
      </div>
    </div>
  );
}

type Tab = "overview" | "attendees" | "analytics";

export function DashboardScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const [tab, setTab] = useState<Tab>("overview");

  const { events, isLoading: eventsLoading, isError: eventsError, refetch: refetchEvents } = useEventList();

  // My events + the set of their event_seq (used to filter all on-chain logs).
  const myEvents = useMemo(
    () => (addr ? events.filter((e) => e.organizer === addr) : []),
    [events, addr],
  );
  const mySeqs = useMemo(() => new Set(myEvents.map((e) => e.eventSeq)), [myEvents]);
  const nameBySeq = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of myEvents) m.set(e.eventSeq, e.name);
    return m;
  }, [myEvents]);

  // TicketMinted logs (newest first). Filtered client-side to my events' seqs.
  const minted = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_TICKET_MINTED }, order: "descending", limit: 50 },
    { enabled: Boolean(addr), staleTime: 30_000 },
  );
  // CheckedIn logs — counts checked-in tickets for my events.
  const checkins = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_CHECKED_IN }, order: "descending", limit: 50 },
    { enabled: Boolean(addr), staleTime: 30_000 },
  );
  // PoapClaimed logs — counts POAPs minted across my events.
  const poaps = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_POAP_CLAIMED }, order: "descending", limit: 50 },
    { enabled: Boolean(addr), staleTime: 30_000 },
  );

  const mintRows: MintRow[] = useMemo(() => {
    if (!minted.data) return [];
    return minted.data.data.flatMap((ev) => {
      const p = ev.parsedJson as TicketMintedJson;
      const seq = String(p.event_seq);
      if (!mySeqs.has(seq)) return [];
      return [
        {
          serial: String(p.serial),
          buyer: String(p.buyer),
          coinType: resolveCoin(String(p.coin_type)),
          totalPaid: BigInt(String(p.total_paid ?? "0")),
          timestampMs: ev.timestampMs ? Number(ev.timestampMs) : null,
          eventSeq: seq,
        },
      ];
    });
  }, [minted.data, mySeqs]);

  const checkedInCount = useMemo(() => {
    if (!checkins.data) return 0;
    return checkins.data.data.reduce((n, ev) => {
      const p = ev.parsedJson as CheckedInJson;
      return mySeqs.has(String(p.event_seq)) ? n + 1 : n;
    }, 0);
  }, [checkins.data, mySeqs]);

  const poapCount = useMemo(() => {
    if (!poaps.data) return 0;
    return poaps.data.data.reduce((n, ev) => {
      const p = ev.parsedJson as PoapClaimedJson;
      return mySeqs.has(String(p.event_seq)) ? n + 1 : n;
    }, 0);
  }, [poaps.data, mySeqs]);

  // Gross revenue grouped by coin type (across all my events' sales).
  const grossByCoin = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const r of mintRows) m.set(r.coinType, (m.get(r.coinType) ?? 0n) + r.totalPaid);
    return m;
  }, [mintRows]);

  const ticketsSold = mintRows.length;
  const statsLoading = eventsLoading || minted.isLoading || checkins.isLoading;

  // --- not connected gate ---
  if (!addr) {
    return (
      <div className="space-y-8 screen-in">
        <Header />
        <Card>
          <CardContent>
            <div className="font-semibold flex items-center gap-2">
              <Icon icon="solar:wallet-bold" size={18} /> Connect your wallet
            </div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              The dashboard aggregates on-chain activity for events you organize. Connect a wallet to
              see your sales, attendees and analytics, or{" "}
              <Link href="/create" style={{ color: "var(--hi-blue)" }}>
                create your first event
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="space-y-8 screen-in">
      <Header />

      {/* segmented tabs */}
      <TabsList className="h-auto flex-wrap">
        {(
          [
            { id: "overview", label: "Overview", icon: "material-symbols-light:dashboard-rounded" },
            { id: "attendees", label: "Attendees", icon: "solar:users-group-rounded-bold" },
            { id: "analytics", label: "Analytics", icon: "material-symbols-light:analytics-rounded" },
          ] as { id: Tab; label: string; icon: string }[]
        ).map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            <Icon icon={t.icon} size={14} /> {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {/* ===================== OVERVIEW ===================== */}
      <TabsContent value="overview">
        <div className="space-y-8">
          <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <StatTile
              icon="ph:calendar-star-fill"
              num={statsLoading ? "…" : String(myEvents.length)}
              label="Your events"
              fill
            />
            <StatTile
              icon="ion:ticket"
              num={statsLoading ? "…" : ticketsSold.toLocaleString()}
              label="Tickets sold (recent)"
            />
            <StatTile
              icon="zondicons:inbox-check"
              num={statsLoading ? "…" : checkedInCount.toLocaleString()}
              label="Checked in (recent)"
            />
            <StatTile
              icon="solar:dollar-minimalistic-bold"
              num={statsLoading ? "…" : grossLabel(grossByCoin)}
              label="Gross revenue (recent)"
            />
          </section>
          <p className="text-xs" style={{ color: "var(--fg3)", marginTop: -16 }}>
            Sales, check-in and revenue figures are derived from the most recent on-chain activity
            and may undercount over the full history of your events.
          </p>

          {eventsError ? (
            <Card>
              <CardContent style={{ color: "var(--color-danger)" }} className="flex flex-wrap items-center gap-2">
                Couldn&apos;t load your events.{" "}
                <Button variant="outline" size="sm" onClick={() => refetchEvents()}>Retry</Button>
              </CardContent>
            </Card>
          ) : myEvents.length === 0 && !eventsLoading ? (
            <Card>
              <CardContent>
                <div className="font-semibold">You haven&apos;t created any events yet.</div>
                <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
                  <Link href="/create" style={{ color: "var(--hi-blue)" }}>
                    Create an event
                  </Link>{" "}
                  to start selling tickets — sales, attendees and revenue will show up here.
                </p>
              </CardContent>
            </Card>
          ) : (
            // Full organizer console (set price, withdraw, self-checkin toggle).
            <MyEvents address={addr} />
          )}
        </div>
      </TabsContent>

      {/* ===================== ATTENDEES ===================== */}
      <TabsContent value="attendees">
        <section className="space-y-5">
          <div>
            <span className="section-label">Buyers</span>
            <h2 className="page-title" style={{ marginTop: 8, fontSize: 22 }}>
              Attendees{" "}
              <span style={{ color: "var(--fg3)" }}>({mintRows.length})</span>
            </h2>
          </div>

          {minted.isLoading ? (
            <Card>
              <CardContent className="flex flex-col gap-2.5">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ) : mintRows.length === 0 ? (
            <Card>
              <CardContent>
                <div className="font-semibold">No tickets sold yet.</div>
                <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
                  When someone buys or claims a ticket to one of your events, they&apos;ll appear here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card className="py-0">
              <div style={{ overflowX: "auto" }}>
                <table
                  className="w-full text-sm"
                  style={{ borderCollapse: "collapse" }}
                  aria-label="Attendees: recent ticket mints across your events"
                >
                  <caption className="sr-only">
                    Recent ticket mints across your events, showing serial, event, buyer, coin,
                    amount paid and time.
                  </caption>
                  <thead>
                    <tr style={{ color: "var(--fg3)", textAlign: "left" }}>
                      <Th>Serial</Th>
                      <Th>Event</Th>
                      <Th>Buyer</Th>
                      <Th>Coin</Th>
                      <Th>Paid (incl. fee)</Th>
                      <Th>When</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {mintRows.map((r, i) => {
                      const ci = coinInfo(r.coinType);
                      return (
                        <tr
                          key={`${r.eventSeq}-${r.serial}-${i}`}
                          style={{ borderTop: "1px solid var(--hair)" }}
                        >
                          <Td>
                            <span className="mono">#{r.serial}</span>
                          </Td>
                          <Td>
                            <span style={{ color: "var(--fg2)" }}>
                              {nameBySeq.get(r.eventSeq) ?? `seq ${r.eventSeq}`}
                            </span>
                          </Td>
                          <Td>
                            <AddressDisplay address={r.buyer} suffix={4} />
                          </Td>
                          <Td>
                            <Badge variant="secondary">{ci.symbol}</Badge>
                          </Td>
                          <Td>
                            <span className="mono">
                              {r.totalPaid > 0n ? `${fmtAmount(r.totalPaid, ci.decimals)} ${ci.symbol}` : "Free"}
                            </span>
                          </Td>
                          <Td>
                            <span className="mono" style={{ color: "var(--fg3)" }}>
                              {r.timestampMs
                                ? new Date(r.timestampMs).toLocaleString(undefined, {
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "—"}
                            </span>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <p className="text-xs" style={{ color: "var(--fg3)" }}>
            Showing the most recent {minted.data?.data.length ?? 0} mint events across the network,
            filtered to your events.
          </p>
        </section>
      </TabsContent>

      {/* ===================== ANALYTICS ===================== */}
      <TabsContent value="analytics">
        <section className="space-y-6">
          <div>
            <span className="section-label">Performance</span>
            <h2 className="page-title" style={{ marginTop: 8, fontSize: 22 }}>
              Analytics
            </h2>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))" }}>
            <StatTile
              icon="ion:ticket"
              num={minted.isLoading ? "…" : ticketsSold.toLocaleString()}
              label="Tickets minted (recent)"
              fill
            />
            <StatTile
              icon="solar:dollar-minimalistic-bold"
              num={minted.isLoading ? "…" : grossLabel(grossByCoin)}
              label="Gross revenue (recent)"
            />
            <StatTile
              icon="zondicons:inbox-check"
              num={checkins.isLoading ? "…" : checkedInCount.toLocaleString()}
              label="Checked in (recent)"
            />
            <StatTile
              icon="streamline:star-badge-solid"
              num={poaps.isLoading ? "…" : poapCount.toLocaleString()}
              label="POAPs claimed (recent)"
            />
          </div>
          <p className="text-xs" style={{ color: "var(--fg3)" }}>
            These totals are aggregated from the most recent on-chain mint, check-in and POAP events
            and may undercount across the full history of your events.
          </p>

          {/* Per-event breakdown of gross by coin */}
          {grossByCoin.size > 0 && (
            <Card>
              <CardContent className="space-y-2.5">
                <div className="section-label">Gross by coin</div>
                <div className="flex flex-col gap-2">
                  {Array.from(grossByCoin.entries())
                    .filter(([, v]) => v > 0n)
                    .map(([type, units]) => {
                      const ci = coinInfo(type);
                      return (
                        <div key={type} className="flex items-center justify-between text-sm">
                          <Badge variant="secondary">{ci.symbol}</Badge>
                          <span className="mono">{fmtAmount(units, ci.decimals)} {ci.symbol}</span>
                        </div>
                      );
                    })}
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="text-sm">
            <CardContent>
              <div className="font-semibold flex items-center gap-2">
                <Icon icon="solar:safe-2-bold" size={18} /> Escrow &amp; settlement
              </div>
              <p style={{ color: "var(--fg2)", marginTop: 6 }}>
                Ticket revenue is held in per-event on-chain escrow, net of the 3% protocol fee. For
                refundable events, the proceeds become withdrawable only after the post-event refund
                window closes; otherwise they&apos;re available immediately. Withdraw to your wallet,
                per coin, from the{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 align-baseline"
                  style={{ color: "var(--hi-blue)" }}
                  onClick={() => setTab("overview")}
                >
                  Overview
                </Button>{" "}
                tab.
              </p>
            </CardContent>
          </Card>
        </section>
      </TabsContent>
    </Tabs>
  );
}

function Header() {
  return (
    <header className="relative">
      <div
        className="glow"
        style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.2 }}
      />
      <div>
        <span className="eyebrow">
          <Icon icon="material-symbols-light:analytics-rounded" size={14} /> Organizer
        </span>
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 34 }}>
          Dashboard
        </h1>
        <p className="page-sub">Live sales, attendees and revenue for the events you host.</p>
      </div>
    </header>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      style={{ padding: "12px 16px", fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}
    >
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>{children}</td>;
}
