"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PACKAGE_ID } from "@/lib/config";
import { getFields } from "@/lib/ticketing";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import { useSuiQuery } from "@/lib/hooks";
import { Icon } from "@/components/Icon";
import { AddressDisplay } from "@/components/AddressDisplay";
import type {
  GetObjectParams,
  QueryEventsParams,
  PaginatedEvents,
  SuiEvent,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

// The on-chain check-in log. Not a config export, so we build the type string
// inline from PACKAGE_ID. Shape (sources/checkin.move::CheckedIn):
//   { event_seq, event_id, ticket_id, attendee, day, serial }
const EV_CHECKED_IN = `${PACKAGE_ID}::checkin::CheckedIn`;

interface CheckedInJson {
  event_seq: string | number;
  event_id: string;
  ticket_id: string;
  attendee: string;
  day: string | number;
  serial: string | number;
}

interface Admit {
  key: string;
  attendee: string;
  serial: string;
  day: number;
  ts: number | null;
}

type Mode = "scan" | "search";

export function DoorScreen({ id }: { id: string }) {
  // --- Event identity (name + venue from on-chain object + Walrus metadata) ---
  const eventQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id,
    options: { showContent: true },
  });
  const fields = eventQ.data ? getFields(eventQ.data) : null;
  const eventName = fields ? String(fields.name ?? "") : "";
  const uri = fields ? (fields.uri as string | undefined) : undefined;

  const [meta, setMeta] = useState<EventMetadata | null>(null);
  useEffect(() => {
    let alive = true;
    if (!uri) {
      setMeta(null);
      return;
    }
    getEventMetadata(uri).then((m) => {
      if (alive) setMeta(m);
    });
    return () => {
      alive = false;
    };
  }, [uri]);
  const venue = [meta?.venue, meta?.city].filter(Boolean).join(", ");

  // --- Live attendance (CheckedIn logs, scoped to this event) ---
  // Newest-first; refetched on an interval so the door view stays live.
  const checkinQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_CHECKED_IN }, order: "descending", limit: 50 },
    { refetchInterval: 8000, staleTime: 4000 },
  );

  const admits: Admit[] = useMemo(() => {
    if (!checkinQ.data) return [];
    return checkinQ.data.data
      .filter((ev: SuiEvent) => (ev.parsedJson as CheckedInJson)?.event_id === id)
      .map((ev: SuiEvent) => {
        const p = ev.parsedJson as CheckedInJson;
        return {
          key: `${ev.id.txDigest}:${ev.id.eventSeq}`,
          attendee: p.attendee,
          serial: String(p.serial),
          day: Number(p.day),
          ts: ev.timestampMs ? Number(ev.timestampMs) : null,
        };
      });
  }, [checkinQ.data, id]);

  const count = admits.length;

  // --- Mode toggle (UI only: the on-chain admit path is attendee self-admit or
  // a staff-signed voucher; this view monitors that, it does not sign txns) ---
  const [mode, setMode] = useState<Mode>("scan");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const ql = query.trim().toLowerCase();
    if (mode !== "search" || !ql) return admits;
    return admits.filter(
      (a) => a.attendee.toLowerCase().includes(ql) || a.serial.toLowerCase().includes(ql),
    );
  }, [admits, mode, query]);

  return (
    <div className="min-h-screen flex flex-col screen-in" style={{ background: "var(--app-bg)" }}>
      {/* === Top bar === */}
      <header
        className="flex items-center justify-between gap-3"
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--hair)" }}
      >
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 22, width: "auto", display: "block" }} />
          <span
            className="badge badge-green inline-flex items-center gap-1.5"
            title="Scoped door-staff view"
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: "var(--hi-green, var(--color-success))",
                boxShadow: "0 0 8px var(--hi-green, var(--color-success))",
                display: "inline-block",
              }}
            />
            Door staff
          </span>
        </div>
        <Link href="/checkin" className="btn btn-sm" title="Close door view">
          <Icon icon="ic:round-close" size={16} /> Close
        </Link>
      </header>

      <main className="grow w-full" style={{ maxWidth: 640, margin: "0 auto", padding: "20px 18px 0", width: "100%" }}>
        {/* === Event identity === */}
        <div className="space-y-1">
          <span className="eyebrow">
            <Icon icon="zondicons:inbox-check" size={14} /> Live door
          </span>
          {eventQ.isLoading ? (
            <h1 className="page-title mono" style={{ fontSize: 24, color: "var(--fg3)" }}>
              Loading event…
            </h1>
          ) : !fields ? (
            <h1 className="page-title" style={{ fontSize: 24 }}>
              Event not found
            </h1>
          ) : (
            <>
              <h1 className="page-title" style={{ fontSize: 26 }}>
                {eventName || "Untitled event"}
              </h1>
              <p className="page-sub" style={{ margin: 0 }}>
                {venue ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Icon icon="ic:round-place" size={14} /> {venue}
                  </span>
                ) : (
                  <span className="mono" style={{ color: "var(--fg3)" }}>
                    {id.slice(0, 10)}…{id.slice(-4)}
                  </span>
                )}
              </p>
            </>
          )}
        </div>

        {/* === Live attendance count === */}
        <div className="stat-tile fill flex items-center justify-between" style={{ marginTop: 18 }}>
          <div>
            <div className="stat-num" style={{ fontSize: 38 }}>
              {checkinQ.isLoading ? "—" : count}
            </div>
            <div className="stat-label inline-flex items-center gap-1.5">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: "var(--hi-green, var(--color-success))",
                  display: "inline-block",
                  animation: "pulse 1.6s ease-in-out infinite",
                }}
              />
              checked in
            </div>
          </div>
          <button
            className="btn btn-sm"
            onClick={() => checkinQ.refetch()}
            title="Refresh live count"
          >
            <Icon icon="ic:round-refresh" size={16} /> Refresh
          </button>
        </div>

        {/* === Mode toggle (UI) === */}
        <div className="flex gap-2" style={{ marginTop: 18 }}>
          <button
            className={`chip ${mode === "scan" ? "on" : ""}`}
            onClick={() => setMode("scan")}
            style={{ flex: 1, justifyContent: "center" }}
          >
            <Icon icon="ic:round-qr-code-scanner" size={15} /> Scan
          </button>
          <button
            className={`chip ${mode === "search" ? "on" : ""}`}
            onClick={() => setMode("search")}
            style={{ flex: 1, justifyContent: "center" }}
          >
            <Icon icon="ic:round-search" size={15} /> Search
          </button>
        </div>

        {mode === "scan" ? (
          <div className="card" style={{ marginTop: 12, textAlign: "center" }}>
            <div
              className="inline-flex items-center justify-center"
              style={{
                width: 96,
                height: 96,
                borderRadius: "var(--r-lg)",
                border: "2px dashed var(--hair-2)",
                color: "var(--fg3)",
                margin: "4px auto 10px",
              }}
            >
              <Icon icon="ic:round-qr-code-scanner" size={44} />
            </div>
            <div className="font-semibold">Monitoring admits</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              Attendees self-admit or are voucher-checked-in on-chain. New admits appear below in real time.
            </p>
          </div>
        ) : (
          <div style={{ position: "relative", marginTop: 12 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)" }}>
              <Icon icon="ic:round-search" size={18} />
            </span>
            <input
              id="door-search"
              aria-label="Search attendees"
              className="input"
              placeholder="Filter admits by address or serial…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 42 }}
            />
          </div>
        )}

        {/* === Scrolling recent admits === */}
        <div style={{ marginTop: 20 }}>
          <div className="section-label">Recent admits</div>
          {checkinQ.isLoading ? (
            <div className="card mono">Loading admits…</div>
          ) : checkinQ.error ? (
            <div className="card" style={{ color: "var(--color-danger)" }}>
              Couldn&apos;t load admits. <button className="btn btn-sm" onClick={() => checkinQ.refetch()}>Retry</button>
            </div>
          ) : shown.length === 0 ? (
            <div className="card">
              <div className="font-semibold">{query.trim() ? "No matches." : "No one in yet."}</div>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
                {query.trim()
                  ? "Try a different address or serial."
                  : "Admits land here the moment attendees check in."}
              </p>
            </div>
          ) : (
            <div
              className="card"
              style={{ padding: 0, maxHeight: 420, overflowY: "auto" }}
            >
              {shown.map((a, i) => (
                <div
                  key={a.key}
                  className="flex items-center justify-between gap-3"
                  style={{
                    padding: "12px 14px",
                    borderTop: i === 0 ? "none" : "1px solid var(--hair)",
                  }}
                >
                  <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                    <span
                      className="badge badge-green inline-flex"
                      style={{ flex: "none" }}
                      title="Admitted"
                    >
                      <Icon icon="zondicons:inbox-check" size={13} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="font-medium" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <AddressDisplay address={a.attendee} suffix={4} />
                      </div>
                      <div className="mono" style={{ color: "var(--fg3)", fontSize: 12 }}>
                        #{a.serial} · day {a.day + 1}
                      </div>
                    </div>
                  </div>
                  <div className="mono" style={{ color: "var(--fg2)", fontSize: 12, flex: "none", textAlign: "right" }}>
                    {a.ts ? (
                      <>
                        <div>{fmtTime(a.ts)}</div>
                        <div style={{ color: "var(--fg3)" }}>{fmtDay(a.ts)}</div>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* === Footer: door-only access note === */}
      <footer
        className="flex items-center justify-center gap-2"
        style={{ padding: "16px 18px 22px", color: "var(--fg3)", fontSize: 12.5 }}
      >
        <Icon icon="ic:round-shield" size={15} />
        Door-only access · read-only attendance · no funds or organizer controls
      </footer>
    </div>
  );
}

// --- inline date helpers (no extra deps) ---
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
