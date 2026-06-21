"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { toast } from "sonner";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { EMAIL_ENABLED, ENOKI_ENABLED, PACKAGE_ID, TICKET_TYPE } from "@/lib/config";
import { useAllEvents } from "@/lib/events";
import { checkInTx, getFields } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import { getTurnstileToken } from "@/lib/turnstileClient";
import {
  clearStaffKeypair,
  extractTicketId,
  generateStaffKeypair,
  importStaffKeypair,
  loadStaffKeypair,
  signVoucher,
  staffPubkeyHex,
} from "@/lib/staffKey";
import { getEventMetadata, type EventMetadata } from "@/lib/metadata";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { Icon } from "@/components/Icon";
import { Copy } from "@/components/animate-ui/icons/copy";
import { RefreshCw } from "@/components/animate-ui/icons/refresh-cw";
import { TxLink } from "@/components/TxLink";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiEvent,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";

// Camera scanner is browser-only (getUserMedia / BarcodeDetector) — load it
// client-side, never during SSR.
const QrScanner = dynamic(() => import("@/components/QrScanner").then((m) => m.QrScanner), {
  ssr: false,
  loading: () => (
    <Card className="mono p-4 text-center">
      Starting camera…
    </Card>
  ),
});

// How long a signed voucher stays valid. Kept short: the attendee should submit
// the check-in right at the gate.
const VOUCHER_TTL_MS = 5 * 60 * 1000;

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

type Mode = "admit" | "monitor" | "search";

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
  // FULLY enumerate the global CheckedIn log (cursor-followed via useAllEvents,
  // ~1000-log bound) instead of a single capped 50-log page — newest-first the
  // door would otherwise drop this event's older admits once ~50 newer check-ins
  // exist platform-wide. useAllEvents has no refetchInterval, so liveness is
  // restored via the 8s interval effect below.
  const checkinQ = useAllEvents(EV_CHECKED_IN);

  // Keep the door view live: useAllEvents has no built-in polling, so re-run the
  // enumeration every 8s (matching the old refetchInterval). Cleanup clears the
  // timer so no stray refetch fires after unmount.
  useEffect(() => {
    const t = setInterval(() => void checkinQ.refetch(), 8000);
    return () => clearInterval(t);
  }, [checkinQ.refetch]);

  const admits: Admit[] = useMemo(() => {
    if (!checkinQ.data) return [];
    // checkinQ.data is useAllEvents' { data, truncated } envelope (≅ the old
    // PaginatedEvents): .data is the SuiEvent[], same hop count as before.
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

  // --- Mode toggle: "admit" runs the staff voucher check-in (scan/enter a ticket,
  // sign the ed25519 voucher, submit on-chain); "monitor"/"search" are read-only. ---
  const [mode, setMode] = useState<Mode>("admit");
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 22, width: "auto", display: "block" }} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="inline-flex items-center gap-1.5">
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
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Scoped door-staff view</TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="outline" size="sm">
              <Link href="/checkin">
                <Icon icon="ic:round-close" size={16} /> Close
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close door view</TooltipContent>
        </Tooltip>
      </header>

      <main className="grow w-full" style={{ maxWidth: 640, margin: "0 auto", padding: "20px 18px 0", width: "100%" }}>
        {/* === Event identity === */}
        <div className="space-y-1">
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => checkinQ.refetch()}>
                <RefreshCw size={16} animate={checkinQ.isFetching} loop /> Refresh
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh live count</TooltipContent>
          </Tooltip>
        </div>

        {/* === Mode toggle === */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="mt-[18px]">
          <TabsList className="w-full">
            <TabsTrigger value="admit" className="flex-1">
              <Icon icon="zondicons:inbox-check" size={15} /> Admit
            </TabsTrigger>
            <TabsTrigger value="monitor" className="flex-1">
              <Icon icon="ic:round-monitor" size={15} /> Monitor
            </TabsTrigger>
            <TabsTrigger value="search" className="flex-1">
              <Icon icon="ic:round-search" size={15} /> Search
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === "admit" ? (
          <AdmitPanel eventId={id} onAdmitted={() => checkinQ.refetch()} />
        ) : mode === "monitor" ? (
          <Card className="mt-3 p-4 text-center">
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
              <Icon icon="ic:round-monitor" size={44} />
            </div>
            <div className="font-semibold">Monitoring admits</div>
            <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
              Attendees self-admit or are voucher-checked-in on-chain. New admits appear below in real time.
            </p>
          </Card>
        ) : (
          <div style={{ position: "relative", marginTop: 12 }}>
            <span style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--fg3)", zIndex: 1 }}>
              <Icon icon="ic:round-search" size={18} />
            </span>
            <Input
              id="door-search"
              aria-label="Search attendees"
              placeholder="Filter admits by address or serial…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-[42px]"
            />
          </div>
        )}

        {/* === Scrolling recent admits === */}
        <div style={{ marginTop: 20 }}>
          <div className="section-label">Recent admits</div>
          {checkinQ.isLoading ? (
            <Card className="mono p-4">Loading admits…</Card>
          ) : checkinQ.error ? (
            <Card className="p-4" style={{ color: "var(--color-danger)" }}>
              Couldn&apos;t load admits.{" "}
              <Button variant="outline" size="sm" onClick={() => checkinQ.refetch()}>Retry</Button>
            </Card>
          ) : shown.length === 0 ? (
            <Card className="p-4">
              <div className="font-semibold">{query.trim() ? "No matches." : "No one in yet."}</div>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
                {query.trim()
                  ? "Try a different address or serial."
                  : "Admits land here the moment attendees check in."}
              </p>
            </Card>
          ) : (
            <Card
              className="p-0"
              style={{ maxHeight: 420, overflowY: "auto" }}
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="secondary" className="inline-flex" style={{ flex: "none" }}>
                          <Icon icon="zondicons:inbox-check" size={13} />
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>Admitted</TooltipContent>
                    </Tooltip>
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
            </Card>
          )}
          {checkinQ.data?.truncated && (
            <p
              className="mono text-sm"
              style={{ color: "var(--fg3)", textAlign: "center", marginTop: 12 }}
            >
              Showing the most recent check-ins — older admits aren&apos;t all loaded yet.
            </p>
          )}
        </div>
      </main>

      {/* === Footer: door-only access note === */}
      <footer
        className="flex items-center justify-center gap-2"
        style={{ padding: "16px 18px 22px", color: "var(--fg3)", fontSize: 12.5 }}
      >
        <Icon icon="ic:round-shield" size={15} />
        Door-only access · voucher check-in + live attendance · no funds or organizer controls
      </footer>
    </div>
  );
}

// === Staff voucher check-in ===
//
// The on-chain `checkin::check_in` takes the attendee's ticket as `&mut Ticket`,
// so the transaction is submitted by whoever holds the ticket (the attendee, or
// the attendee's wallet at a kiosk) — the staff device's job is to *sign* the
// ed25519 voucher that authorizes it. This panel: (1) manages the staff key on
// this device, (2) reads a ticket id (camera QR or typed), (3) signs the voucher
// with the staff key locally, and (4) submits the check-in via the connected
// wallet using the standard sponsored/direct submit helper.
function AdmitPanel({ eventId, onAdmitted }: { eventId: string; onAdmitted: () => void }) {
  const account = useCurrentAccount();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();

  const client = useCurrentClient() as unknown as {
    getOwnedObjects: (p: GetOwnedObjectsParams) => Promise<PaginatedObjectsResponse>;
  };

  const [keypair, setKeypair] = useState<Ed25519Keypair | null>(null);
  useEffect(() => {
    setKeypair(loadStaffKeypair());
  }, []);

  // Will-call lookup: find an attendee's ticket for THIS event by email (GH#96).
  const [emailInput, setEmailInput] = useState("");
  const [lookupBusy, setLookupBusy] = useState(false);

  const [useCamera, setUseCamera] = useState(false);
  const [ticketInput, setTicketInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Camera/decode errors are surfaced inline (separate from admit/tx errors,
  // which now route to Sonner toast) so the scanner's onError can't clobber a
  // real check-in result.
  const [camErr, setCamErr] = useState<string | null>(null);
  const [lastTicket, setLastTicket] = useState<string | null>(null);

  // Dedup + cooldown: a QR scanner re-fires the same value many times a second.
  // Without a guard, one successful admit would loop forever. Track the last
  // ticket we successfully admitted and when, and ignore re-scans of it within
  // the cooldown window.
  const lastAdmittedId = useRef<string | null>(null);
  const lastAdmittedAt = useRef<number>(0);
  const ADMIT_COOLDOWN_MS = 4000;

  // Admit a ticket: sign the voucher with the staff key, submit the check-in.
  async function admit(rawTicket: string) {
    const ticketId = extractTicketId(rawTicket);
    if (!ticketId) {
      toast.error("Couldn't read a ticket id from that input. Expect a 0x… object id.");
      return;
    }
    if (!keypair) {
      toast.error("Set up a staff signing key first (below).");
      return;
    }
    if (!account?.address) {
      toast.error("Connect the ticket-holder's wallet to submit the check-in.");
      return;
    }
    setBusy(true);
    setLastTicket(ticketId);
    try {
      const voucher = await signVoucher(
        keypair,
        eventId,
        ticketId,
        BigInt(Date.now() + VOUCHER_TTL_MS),
      );
      const tx = checkInTx({ eventId, ticketId, ...voucher });
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: account.address })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Admitted", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      setTicketInput("");
      lastAdmittedId.current = ticketId;
      lastAdmittedAt.current = Date.now();
      onAdmitted();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Resolve an email → its registered wallet → that wallet's ticket for this
  // event, and fill the ticket id. The holder still submits the check-in (they
  // own the ticket), so this is will-call verification + auto-fill, not a
  // staff-side override.
  async function findByEmail() {
    const em = emailInput.trim();
    if (!em) return;
    setLookupBusy(true);
    try {
      const turnstileToken = await getTurnstileToken();
      const r = await fetch("/api/identity/lookup-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: em, turnstileToken }),
      });
      const j = (await r.json()) as { address?: string | null; error?: string };
      if (!r.ok) throw new Error(j.error || "Lookup failed");
      if (!j.address) {
        toast.error("No account is registered to that email.");
        return;
      }
      const owner = j.address;
      const res = await client.getOwnedObjects({
        owner,
        filter: { StructType: TICKET_TYPE },
        options: { showContent: true },
      });
      const tickets = (res.data ?? [])
        .map((e) => ({ id: e.data?.objectId, f: getFields(e) }))
        .filter((t) => t.id && t.f && String(t.f.event_id) === eventId);
      if (tickets.length === 0) {
        toast.error("That attendee holds no ticket for this event.");
        return;
      }
      const issued = tickets.find((t) => Number(t.f!.status) === 0) ?? tickets[0];
      setTicketInput(issued.id!);
      const checkedIn = Number(issued.f!.status) === 1;
      const sameWallet = account?.address === owner;
      toast.success(
        `Found ${tickets.length} ticket${tickets.length === 1 ? "" : "s"}${checkedIn ? " · already checked in" : ""}`,
        {
          description: sameWallet
            ? "This wallet holds it — sign the voucher to admit."
            : "Ticket id filled. The holder must connect THIS wallet to submit the check-in.",
        },
      );
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setLookupBusy(false);
    }
  }

  return (
    <div className="space-y-3" style={{ marginTop: 12 }}>
      {EMAIL_ENABLED && (
        <Card className="space-y-2 p-4">
          <span className="section-label">Will-call — find by email</span>
          <div className="flex items-end gap-2" style={{ flexWrap: "wrap" }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <Input
                type="email"
                placeholder="attendee@example.com"
                value={emailInput}
                disabled={lookupBusy}
                onChange={(e) => setEmailInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void findByEmail();
                }}
              />
            </div>
            <Button variant="outline" disabled={lookupBusy} onClick={findByEmail}>
              {lookupBusy ? "Finding…" : "Find ticket"}
            </Button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--fg3)" }}>
            Looks up the attendee&apos;s ticket and fills it below. They still tap in with their own
            wallet (the ticket is theirs).
          </p>
        </Card>
      )}

      {/* Reader: camera QR or typed/pasted ticket id */}
      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="section-label">Admit attendee</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={useCamera ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setCamErr(null);
                  setUseCamera((v) => !v);
                }}
              >
                <Icon icon="ic:round-qr-code-scanner" size={14} /> {useCamera ? "Camera on" : "Scan QR"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle the camera QR scanner</TooltipContent>
          </Tooltip>
        </div>

        {useCamera && (
          <div style={{ position: "relative" }}>
            <QrScanner
              paused={busy}
              onDecode={(v) => {
                if (busy) return;
                // Dedup + cooldown: ignore re-scans of the ticket we just
                // admitted within the cooldown window so the same QR can't be
                // re-admitted in a loop.
                const ticketId = extractTicketId(v);
                if (
                  ticketId &&
                  ticketId === lastAdmittedId.current &&
                  Date.now() - lastAdmittedAt.current < ADMIT_COOLDOWN_MS
                ) {
                  return;
                }
                admit(v);
              }}
              onError={(m) => setCamErr(m)}
            />
            {camErr && (
              <div className="text-xs break-words" style={{ color: "var(--color-danger)", marginTop: 6 }}>
                {camErr}
              </div>
            )}
            <p className="text-xs" style={{ color: "var(--fg3)", marginTop: 6 }}>
              Point the camera at the attendee&apos;s ticket QR. Requires camera permission and HTTPS.
            </p>
          </div>
        )}

        <div className="field">
          <Label htmlFor="door-ticket">Ticket id</Label>
          <Input
            id="door-ticket"
            className="mono"
            placeholder="0x… ticket object id"
            value={ticketInput}
            onChange={(e) => setTicketInput(e.target.value)}
            spellCheck={false}
          />
        </div>
        <Button
          className="w-full"
          disabled={busy || !ticketInput.trim() || !keypair}
          onClick={() => admit(ticketInput)}
        >
          <Icon icon="zondicons:inbox-check" size={16} />
          {busy ? "Admitting…" : "Sign voucher & check in"}
        </Button>

        {lastTicket && (
          <div className="mono text-xs" style={{ color: "var(--fg3)" }}>
            ticket {lastTicket.slice(0, 12)}…{lastTicket.slice(-4)}
          </div>
        )}
        <p className="text-xs" style={{ color: "var(--fg3)" }}>
          The check-in is submitted by the connected wallet (the ticket holder). At a kiosk, the
          attendee taps in their wallet; the staff key only signs the voucher.
        </p>
      </Card>

      <StaffKeyManager keypair={keypair} onChange={setKeypair} />
    </div>
  );
}

// Per-device staff signing key. Generated or imported here, persisted in this
// browser's localStorage, and used only to sign vouchers locally — the private
// key is never displayed, logged, or sent anywhere. The organizer registers the
// *public* key on the event (Check-in → Staff signers).
function StaffKeyManager({
  keypair,
  onChange,
}: {
  keypair: Ed25519Keypair | null;
  onChange: (kp: Ed25519Keypair | null) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const pubHex = keypair ? staffPubkeyHex(keypair) : null;

  function doImport() {
    setErr(null);
    try {
      const kp = importStaffKeypair(secret);
      onChange(kp);
      setSecret("");
      setImporting(false);
    } catch {
      setErr("That isn't a valid Sui private key (expected a suiprivkey1… string).");
    }
  }

  async function copyPub() {
    if (!pubHex) return;
    try {
      await navigator.clipboard.writeText(pubHex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; the key stays visible to copy manually */
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div>
        <span className="section-label">Staff signing key</span>
        <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 4 }}>
          {keypair
            ? "This device can sign check-in vouchers. The organizer must register the public key below on the event."
            : "Set up a key so this device can sign check-in vouchers. The private key stays on this device."}
        </p>
      </div>

      {keypair ? (
        <>
          <div className="field">
            <Label>Public key (register this on the event)</Label>
            <div className="flex items-center gap-2">
              <Input className="mono" value={pubHex ?? ""} readOnly spellCheck={false} />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={copyPub}>
                    {copied ? (
                      <Icon icon="ic:round-check" size={15} />
                    ) : (
                      <Copy size={15} animateOnHover />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy public key</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  clearStaffKeypair();
                  onChange(null);
                }}
              >
                <Icon icon="ic:round-delete-outline" size={15} /> Forget key
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forget this device&apos;s staff key</TooltipContent>
          </Tooltip>
        </>
      ) : importing ? (
        <>
          <div className="field">
            <Label htmlFor="staff-secret">Sui private key</Label>
            <Input
              id="staff-secret"
              className="mono"
              type="password"
              placeholder="suiprivkey1…"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setErr(null);
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" disabled={!secret.trim()} onClick={doImport}>
              Import key
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setImporting(false);
                setSecret("");
                setErr(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            onClick={() => {
              setErr(null);
              onChange(generateStaffKeypair());
            }}
          >
            <Icon icon="ic:round-add" size={15} /> Generate key
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
            Import existing
          </Button>
        </div>
      )}

      {err && <div className="text-xs break-words" style={{ color: "var(--color-danger)" }}>{err}</div>}
    </Card>
  );
}

// --- inline date helpers (no extra deps) ---
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
