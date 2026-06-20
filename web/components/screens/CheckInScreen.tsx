"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { fromHex } from "@mysten/sui/utils";
import {
  ORGANIZER_CAP_TYPE,
  PACKAGE_ID,
} from "@/lib/config";
import { useAllEvents, useEventList } from "@/lib/events";
import {
  getFields,
  addCheckinSignerTx,
  setAllowSelfCheckinTx,
} from "@/lib/ticketing";
import { useCurrentAccount, useSignAndExecute, useSuiQuery } from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { useSuiNSNames } from "@/lib/verification";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { EventInfo } from "@/lib/events";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
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
  const { events, isLoading, isError, refetch } = useEventList();

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
        <Card className="p-5">
          <div className="font-semibold">Connect your wallet to run check-in.</div>
          <p className="text-sm text-muted-foreground mt-1">
            The console shows live attendance and signer management for events you
            organize.
          </p>
        </Card>
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
          <Card className="p-5 mono" role="status">Loading your events…</Card>
        ) : isError ? (
          <Card className="p-5 flex items-center gap-3 flex-wrap text-destructive">
            Couldn&apos;t load your events.{" "}
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </Card>
        ) : mine.length === 0 ? (
          <Card className="p-5" role="status">
            <div className="font-semibold">No events to staff.</div>
            <p className="text-sm text-muted-foreground mt-1">
              You aren&apos;t the organizer of any event yet. Create one to manage
              the door.
            </p>
          </Card>
        ) : (
          <ToggleGroup
            type="single"
            value={selected ?? ""}
            onValueChange={(v) => v && setSelected(v)}
            className="flex-wrap justify-start"
          >
            {mine.map((e) => (
              <ToggleGroupItem key={e.eventId} value={e.eventId}>
                <Icon icon="ion:ticket" size={14} /> {e.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
    <Card className="p-[18px]">
      <div className="flex items-start gap-3">
        <span className="text-primary mt-0.5">
          <Icon icon="ic:round-info" size={20} />
        </span>
        <div className="text-sm space-y-1 text-muted-foreground">
          <div className="font-medium text-foreground">
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
    </Card>
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

  async function toggleSelf() {
    if (!capId) return;
    try {
      const out = await mutateAsync({
        transaction: setAllowSelfCheckinTx({ capId, eventId: event.eventId, allow: !allowSelf }),
      });
      toast.success(allowSelf ? "Self check-in disabled" : "Self check-in enabled", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      obj.refetch();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <section className="space-y-6">
      <Card className="space-y-4" style={posterVars(event.eventId)}>
        <div className="poster flex items-center justify-between" style={{ padding: "16px 18px" }}>
          <div className="poster-noise" />
          <div className="relative">
            <div className="ev-title" style={{ color: "#fff" }}>{event.name}</div>
            <div className="mono" style={{ color: "rgba(255,255,255,.85)" }}>
              {event.eventId.slice(0, 12)}…
            </div>
          </div>
          <div className="relative flex items-center gap-2 flex-wrap">
            {event.isFree && <Badge variant="secondary">Free</Badge>}
            <Badge variant="secondary">seq {event.eventSeq}</Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/door/${event.eventId}`}>
                    <Icon icon="ic:round-meeting-room" size={14} /> Open door view
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open the full-screen door view for this event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/manage/${event.eventId}`}>
                    <Icon icon="ic:round-settings" size={14} /> Manage
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Manage this event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/forum/${event.eventId}`}>
                    <Icon icon="ic:round-forum" size={14} /> Forum
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open the attendee forum for this event</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </Card>

      <Attendance eventId={event.eventId} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <span className="section-label">Self check-in</span>
              <p className="text-sm text-muted-foreground mt-1">
                Let holders check themselves in within the window (no staff voucher).
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Switch
                    checked={allowSelf}
                    aria-label={`Self check-in ${allowSelf ? "enabled" : "disabled"}`}
                    disabled={isPending || !capId}
                    onCheckedChange={() => {
                      if (!isPending && capId) toggleSelf();
                    }}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {capId ? "Toggle self check-in" : "OrganizerCap for this event not found"}
              </TooltipContent>
            </Tooltip>
          </div>
          {capsQuery.isError ? (
            <div className="text-xs text-destructive flex items-center gap-2 flex-wrap" role="status">
              Could not load your organizer permissions —{" "}
              <Button variant="outline" size="sm" onClick={() => capsQuery.refetch()}>Retry</Button>
            </div>
          ) : !capId && !capsQuery.isLoading ? (
            <div className="text-xs text-destructive">
              No matching OrganizerCap in this wallet — admin actions are disabled.
            </div>
          ) : null}
        </Card>

        <SignerManager
          capId={capId}
          eventId={event.eventId}
          isPending={isPending}
          capsError={capsQuery.isError}
          capsLoading={capsQuery.isLoading}
        />
      </div>
    </section>
  );
}

function SignerManager({
  capId,
  eventId,
  isPending,
  capsError,
  capsLoading,
}: {
  capId: string | null;
  eventId: string;
  isPending: boolean;
  capsError: boolean;
  capsLoading: boolean;
}) {
  const { mutateAsync } = useSignAndExecute();
  const [hex, setHex] = useState("");
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
    setBusy(true);
    try {
      const out = await mutateAsync({
        transaction: addCheckinSignerTx({ capId, eventId, pubkey: bytes }),
      });
      toast.success("Signer added", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      setHex("");
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 space-y-3">
      <div>
        <span className="section-label">Staff signers</span>
        <p className="text-sm text-muted-foreground mt-1">
          Register a staff device&apos;s 32-byte ed25519 public key (hex). Its signed
          vouchers will be accepted at <span className="mono">check_in</span>.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="signer-pubkey">ed25519 public key</Label>
        <Input
          id="signer-pubkey"
          className="mono"
          placeholder="0x… (64 hex chars / 32 bytes)"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          disabled={!capId || !valid || busy || isPending}
          onClick={add}
        >
          <Icon icon="ic:round-add" size={16} />
          {busy ? "Adding…" : "Add signer"}
        </Button>
        {hex.trim().length > 0 && !valid && (
          <Badge variant="secondary">Need exactly 32 bytes (64 hex)</Badge>
        )}
        {valid && <Badge variant="outline">{bytes!.length} bytes</Badge>}
      </div>
      {capsError ? (
        <div className="text-xs text-destructive" role="status">
          Could not load your organizer permissions.
        </div>
      ) : !capId && !capsLoading ? (
        <div className="text-xs text-muted-foreground">
          OrganizerCap required to register signers.
        </div>
      ) : null}
    </Card>
  );
}

function Attendance({ eventId }: { eventId: string }) {
  const [mode, setMode] = useState<"qr" | "search">("qr");
  // FULLY enumerate the global CheckedIn log (cursor-followed via useAllEvents,
  // ~1000-log bound) instead of a single capped 50-log page — newest-first the
  // list would otherwise drop this event's older check-ins once ~50 newer ones
  // exist platform-wide. Liveness (the old 8s refetchInterval) is restored by the
  // interval effect below, since useAllEvents has no built-in polling.
  const q = useAllEvents(CHECKED_IN_EVENT);

  useEffect(() => {
    const t = setInterval(() => void q.refetch(), 8_000);
    return () => clearInterval(t);
  }, [q.refetch]);

  const rows = useMemo(() => {
    if (!q.data) return [];
    // q.data is useAllEvents' { data, truncated } envelope (≅ the old
    // PaginatedEvents): .data is the SuiEvent[], same hop count as before.
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

      <Tabs value={mode} onValueChange={(v) => setMode(v as "qr" | "search")} className="space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="section-label">Recent check-ins</span>
          <TabsList>
            <TabsTrigger value="qr">
              <Icon icon="ic:round-qr-code-scanner" size={14} /> QR
            </TabsTrigger>
            <TabsTrigger value="search">
              <Icon icon="ic:round-search" size={14} /> Search
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="qr">
          <Card className="text-center" style={{ padding: 22 }}>
            <FauxQr seed={eventId} />
            <p className="text-sm text-muted-foreground mt-3">
              Point an attendee&apos;s ticket QR at the staff scanner. On scan, the staff
              device signs a voucher and the attendee submits the on-chain check-in.
            </p>
            <p className="text-xs mono text-muted-foreground mt-1.5">
              event {eventId.slice(0, 14)}…
            </p>
          </Card>
        </TabsContent>

        <TabsContent value="search">
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)" }}>
              <Icon icon="ic:round-search" size={18} />
            </span>
            <Input
              placeholder="Search by address, suiNS or serial…"
              aria-label="Search check-ins by address, suiNS or serial"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 42 }}
            />
          </div>
        </TabsContent>
      </Tabs>

      {q.isLoading ? (
        <Card className="p-5 mono" role="status">Loading attendance…</Card>
      ) : filtered.length === 0 ? (
        <Card className="p-5" role="status">
          <div className="font-semibold">
            {rows.length === 0 ? "No check-ins yet." : "No matches."}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {rows.length === 0
              ? "Attendance will appear here live as attendees check in at the door."
              : "Try a different address, name or serial."}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((r, i) => (
            <Card
              key={`${r.json.ticket_id}-${i}`}
              className="flex flex-row items-center justify-between gap-3"
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
                  <div className="mono text-xs text-muted-foreground">
                    #{String(r.json.serial)} · day {String(r.json.day)}
                  </div>
                </div>
              </div>
              <div className="mono text-xs text-muted-foreground" style={{ textAlign: "right", flex: "none" }}>
                {r.ts ? new Date(Number(r.ts)).toLocaleString() : "—"}
              </div>
            </Card>
          ))}
        </div>
      )}
      {q.data?.truncated && (
        <p className="mono text-sm" style={{ color: "var(--fg3)", textAlign: "center" }}>
          Showing the most recent check-ins — older ones aren&apos;t all loaded yet.
        </p>
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
