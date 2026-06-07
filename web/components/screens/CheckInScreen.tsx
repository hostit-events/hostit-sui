"use client";

import { useMemo, useState } from "react";
import { fromHex } from "@mysten/sui/utils";
import {
  ORGANIZER_CAP_TYPE,
  PACKAGE_ID,
} from "@/lib/config";
import { useEventList } from "@/lib/events";
import {
  getFields,
  addCheckinSignerTx,
  setAllowSelfCheckinTx,
} from "@/lib/ticketing";
import { useCurrentAccount, useSignAndExecute, useSuiQuery } from "@/lib/hooks";
import { useSuiNSNames } from "@/lib/verification";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import type { EventInfo } from "@/lib/events";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedEvents,
  PaginatedObjectsResponse,
  QueryEventsParams,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

const CHECKED_IN_EVENT = `${PACKAGE_ID}::checkin::CheckedIn`;

interface CheckedInJson {
  event_seq: string | number;
  event_id: string;
  ticket_id: string;
  attendee: string;
  day: string | number;
  serial: string | number;
}

/** Deterministic poster gradient from a seed (matches the brand poster motif). */
function posterVars(seed: string): React.CSSProperties {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return {
    ["--p1" as string]: `hsl(${hue} 92% 60%)`,
    ["--p2" as string]: `hsl(${(hue + 46) % 360} 90% 48%)`,
  } as React.CSSProperties;
}

export function CheckInScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const { events, isLoading } = useEventList();

  const mine = useMemo<EventInfo[]>(
    () => (addr ? events.filter((e) => e.organizer === addr) : []),
    [events, addr],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const picked = useMemo(
    () => mine.find((e) => e.eventId === selected) ?? null,
    [mine, selected],
  );

  if (!addr) {
    return (
      <div className="space-y-8 screen-in">
        <Header />
        <div className="card">
          <div className="font-semibold">Connect your wallet to run check-in.</div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            The console shows live attendance and signer management for events you
            organize.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 screen-in">
      <Header />

      <Explainer />

      <section className="space-y-3">
        <span className="section-label">Your events</span>
        {isLoading ? (
          <div className="card mono">Loading your events…</div>
        ) : mine.length === 0 ? (
          <div className="card">
            <div className="font-semibold">No events to staff.</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              You aren&apos;t the organizer of any event yet. Create one to manage
              the door.
            </p>
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {mine.map((e) => (
              <button
                key={e.eventId}
                className={`chip ${selected === e.eventId ? "on" : ""}`}
                onClick={() => setSelected(e.eventId)}
              >
                <Icon icon="ion:ticket" size={14} /> {e.name}
              </button>
            ))}
          </div>
        )}
      </section>

      {picked && <EventConsole key={picked.eventId} event={picked} organizer={addr} />}
    </div>
  );
}

function Header() {
  return (
    <header className="relative">
      <div
        className="glow"
        style={{ width: 380, height: 380, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }}
      />
      <span className="eyebrow">
        <Icon icon="zondicons:inbox-check" size={14} /> Check-in
      </span>
      <h1 className="page-title" style={{ marginTop: 12, fontSize: 34 }}>
        Door console
      </h1>
      <p className="page-sub">Live attendance, staff signers and self check-in — on Sui.</p>
    </header>
  );
}

function Explainer() {
  return (
    <div className="panel" style={{ padding: 18 }}>
      <div className="flex items-start gap-3">
        <span style={{ color: "var(--hi-blue)", marginTop: 2 }}>
          <Icon icon="ic:round-info" size={20} />
        </span>
        <div className="text-sm space-y-1" style={{ color: "var(--fg2)" }}>
          <div className="font-medium" style={{ color: "var(--fg1)" }}>
            How the door works
          </div>
          <p>
            Tickets are owned by attendees, so a staff member can&apos;t mutate them
            directly. At the gate there are two paths:
          </p>
          <ul className="space-y-1" style={{ listStyle: "disc", paddingLeft: 18 }}>
            <li>
              <strong>Self check-in</strong> (if enabled): the attendee taps{" "}
              <em>Check in</em> on their own ticket within the event window — no staff
              key needed.
            </li>
            <li>
              <strong>Staff voucher</strong>: a staff device signs an ed25519 voucher
              for <span className="mono">{"{event_id, ticket_id, expiry}"}</span>; the
              attendee submits it via the on-chain{" "}
              <span className="mono">check_in</span> path. Register the device&apos;s
              public key below so its vouchers are accepted.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function EventConsole({ event, organizer }: { event: EventInfo; organizer: string }) {
  const obj = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>("getObject", {
    id: event.eventId,
    options: { showContent: true },
  });
  const f = getFields(obj.data ?? {});
  const allowSelf = Boolean(f?.allow_self_checkin);

  // OrganizerCap that matches this event (gates signer + toggle calls).
  const capsQuery = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: organizer,
      filter: { StructType: ORGANIZER_CAP_TYPE },
      options: { showContent: true },
    },
  );
  const capId = useMemo(() => {
    if (!capsQuery.data) return null;
    for (const entry of capsQuery.data.data) {
      const cf = getFields(entry);
      if (cf && String(cf.event_id) === event.eventId) return entry.data?.objectId ?? null;
    }
    return null;
  }, [capsQuery.data, event.eventId]);

  const { mutateAsync, isPending } = useSignAndExecute();
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);

  async function toggleSelf() {
    if (!capId) return;
    setErr(null);
    try {
      const out = await mutateAsync({
        transaction: setAllowSelfCheckinTx({ capId, eventId: event.eventId, allow: !allowSelf }),
      });
      setDigest(out.digest);
      obj.refetch();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="space-y-6">
      <div className="card space-y-4" style={posterVars(event.eventId)}>
        <div className="poster flex items-center justify-between" style={{ padding: "16px 18px" }}>
          <div className="poster-noise" />
          <div className="relative">
            <div className="ev-title" style={{ color: "#fff" }}>{event.name}</div>
            <div className="mono" style={{ color: "rgba(255,255,255,.85)" }}>
              {event.eventId.slice(0, 12)}…
            </div>
          </div>
          <div className="relative flex gap-1.5 flex-wrap">
            {event.isFree && <span className="badge badge-green">Free</span>}
            <span className="badge" style={{ background: "rgba(255,255,255,.18)", color: "#fff" }}>
              seq {event.eventSeq}
            </span>
          </div>
        </div>
      </div>

      <Attendance eventId={event.eventId} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="section-label">Self check-in</span>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
                Let holders check themselves in within the window (no staff voucher).
              </p>
            </div>
            <div
              className={`switch ${allowSelf ? "on" : ""}`}
              role="switch"
              aria-checked={allowSelf}
              onClick={() => {
                if (!isPending && capId) toggleSelf();
              }}
              title={capId ? "Toggle self check-in" : "OrganizerCap for this event not found"}
            />
          </div>
          {!capId && (
            <div className="text-xs" style={{ color: "var(--color-danger)" }}>
              No matching OrganizerCap in this wallet — admin actions are disabled.
            </div>
          )}
        </div>

        <SignerManager capId={capId} eventId={event.eventId} isPending={isPending} />
      </div>

      {digest && <TxLink digest={digest} className="mono text-xs" style={{ color: "var(--fg3)" }} />}
      {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
    </section>
  );
}

function SignerManager({
  capId,
  eventId,
  isPending,
}: {
  capId: string | null;
  eventId: string;
  isPending: boolean;
}) {
  const { mutateAsync } = useSignAndExecute();
  const [hex, setHex] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parse a 32-byte ed25519 pubkey from hex (0x-prefixed or bare) → number[].
  function parsePubkey(): number[] | null {
    const clean = hex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== 64) return null;
    try {
      return Array.from(fromHex(clean));
    } catch {
      return null;
    }
  }

  const bytes = parsePubkey();
  const valid = bytes !== null;

  async function add() {
    if (!capId || !bytes) return;
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const out = await mutateAsync({
        transaction: addCheckinSignerTx({ capId, eventId, pubkey: bytes }),
      });
      setOk(out.digest);
      setHex("");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <span className="section-label">Staff signers</span>
        <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
          Register a staff device&apos;s 32-byte ed25519 public key (hex). Its signed
          vouchers will be accepted at <span className="mono">check_in</span>.
        </p>
      </div>
      <div className="field">
        <label className="label">ed25519 public key</label>
        <input
          className="input mono"
          placeholder="0x… (64 hex chars / 32 bytes)"
          value={hex}
          onChange={(e) => {
            setHex(e.target.value);
            setErr(null);
            setOk(null);
          }}
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          className="btn btn-primary"
          disabled={!capId || !valid || busy || isPending}
          onClick={add}
        >
          <Icon icon="ic:round-add" size={16} />
          {busy ? "Adding…" : "Add signer"}
        </button>
        {hex.trim().length > 0 && !valid && (
          <span className="badge badge-amber">Need exactly 32 bytes (64 hex)</span>
        )}
        {valid && <span className="badge badge-line">{bytes!.length} bytes</span>}
      </div>
      {!capId && (
        <div className="text-xs" style={{ color: "var(--fg3)" }}>
          OrganizerCap required to register signers.
        </div>
      )}
      {ok && <TxLink digest={ok} label="added · tx" className="mono text-xs" style={{ color: "var(--color-success)" }} />}
      {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
    </div>
  );
}

function Attendance({ eventId }: { eventId: string }) {
  const [mode, setMode] = useState<"qr" | "search">("qr");
  const q = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: CHECKED_IN_EVENT }, order: "descending", limit: 50 },
    { refetchInterval: 8_000 },
  );

  const rows = useMemo(() => {
    if (!q.data) return [];
    return q.data.data
      .map((ev) => ({ json: ev.parsedJson as CheckedInJson, ts: ev.timestampMs }))
      .filter((r) => r.json?.event_id === eventId);
  }, [q.data, eventId]);

  const attendees = useMemo(
    () => Array.from(new Set(rows.map((r) => r.json.attendee))),
    [rows],
  );
  const names = useSuiNSNames(attendees);

  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => {
      const nm = names.get(r.json.attendee);
      return (
        r.json.attendee.toLowerCase().includes(s) ||
        String(r.json.serial).includes(s) ||
        (nm ? nm.toLowerCase().includes(s) : false)
      );
    });
  }, [rows, search, names]);

  const uniqueCount = attendees.length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <div className="stat-tile fill">
          <div className="stat-num" style={{ color: "#fff" }}>{rows.length}</div>
          <div className="stat-label" style={{ color: "rgba(255,255,255,.8)" }}>Check-ins</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{uniqueCount}</div>
          <div className="stat-label">Unique attendees</div>
        </div>
        <div className="stat-tile">
          <div className="stat-num">{q.isLoading ? "…" : "live"}</div>
          <div className="stat-label">Refreshes every 8s</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="section-label">Recent check-ins</span>
        <div className="flex gap-2">
          <button className={`chip ${mode === "qr" ? "on" : ""}`} onClick={() => setMode("qr")}>
            <Icon icon="ic:round-qr-code-scanner" size={14} /> QR
          </button>
          <button className={`chip ${mode === "search" ? "on" : ""}`} onClick={() => setMode("search")}>
            <Icon icon="ic:round-search" size={14} /> Search
          </button>
        </div>
      </div>

      {mode === "qr" ? (
        <div className="panel" style={{ padding: 22, textAlign: "center" }}>
          <FauxQr seed={eventId} />
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 12 }}>
            Point an attendee&apos;s ticket QR at the staff scanner. On scan, the staff
            device signs a voucher and the attendee submits the on-chain check-in.
          </p>
          <p className="text-xs mono" style={{ color: "var(--fg3)", marginTop: 6 }}>
            event {eventId.slice(0, 14)}…
          </p>
        </div>
      ) : (
        <div style={{ position: "relative" }}>
          <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)" }}>
            <Icon icon="ic:round-search" size={18} />
          </span>
          <input
            className="input"
            placeholder="Search by address, suiNS or serial…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 42 }}
          />
        </div>
      )}

      {q.isLoading ? (
        <div className="card mono">Loading attendance…</div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <div className="font-semibold">
            {rows.length === 0 ? "No check-ins yet." : "No matches."}
          </div>
          <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
            {rows.length === 0
              ? "Attendance will appear here live as attendees check in at the door."
              : "Try a different address, name or serial."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r, i) => (
            <div
              key={`${r.json.ticket_id}-${i}`}
              className="panel flex items-center justify-between gap-3"
              style={{ padding: "12px 16px" }}
            >
              <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                <span style={{ color: "var(--hi-green)" }}>
                  <Icon icon="zondicons:inbox-check" size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className="text-sm">
                    <AddressDisplay address={r.json.attendee} suffix={4} />
                  </div>
                  <div className="mono text-xs" style={{ color: "var(--fg3)" }}>
                    #{String(r.json.serial)} · day {String(r.json.day)}
                  </div>
                </div>
              </div>
              <div className="mono text-xs" style={{ color: "var(--fg3)", textAlign: "right", flex: "none" }}>
                {r.ts ? new Date(Number(r.ts)).toLocaleString() : "—"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Deterministic ticket-stub QR motif (display only). */
function FauxQr({ seed, size = 132, dim = 13 }: { seed: string; size?: number; dim?: number }) {
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
        gap: 2,
        background: "#fff",
        padding: 8,
        borderRadius: 12,
        margin: "0 auto",
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
