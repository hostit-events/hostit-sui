"use client";

import { useMemo, useReducer } from "react";
import {
  PACKAGE_ID,
  TICKET_TYPE,
  EV_EVENT_CREATED,
  EV_TICKET_MINTED,
} from "./config";
import { POAP_TYPE } from "./poap";
import { getFields } from "./ticketing";
import { useCurrentAccount, useSuiQuery } from "./hooks";
import { useAllEvents } from "./events";
import type {
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  SuiEvent,
} from "@mysten/sui/jsonRpc";

// PoapClaimed log type (built the same way config builds EV_TICKET_MINTED; the
// DashboardScreen inlines it identically — there is no exported constant yet).
const EV_POAP_CLAIMED = `${PACKAGE_ID}::poap::PoapClaimed`;

// localStorage key for read/dismissed inbox state. Distinct from SettingsScreen's
// `hostit:notifs` (preference toggles) and `hostit:profile`.
const INBOX_KEY = "hostit:notif-inbox";

export type NotificationType = "purchase" | "publish" | "reminder";

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  description: string;
  /** Real on-chain `timestampMs` (or object-derived ms) — never fabricated. */
  timestamp: number;
  read: boolean;
  eventId?: string;
}

/** Persisted inbox state: ids marked read, ids dismissed (hidden). */
export interface InboxState {
  read: string[];
  dismissed: string[];
}

// ── SSR-safe localStorage helpers (mirror SettingsScreen lsRead/lsWrite) ──
export function lsRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsWrite(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — fail silently */
  }
}

export function readInbox(): InboxState {
  const s = lsRead<Partial<InboxState>>(INBOX_KEY, {});
  return { read: s.read ?? [], dismissed: s.dismissed ?? [] };
}

export function writeInbox(state: InboxState) {
  lsWrite(INBOX_KEY, state);
}

// ── Parsed shapes from on-chain reads ──────────────────────────────────
export interface OwnedRef {
  /** Object id of the Ticket / Poap. */
  objectId: string;
  /** The bound Event object id (both Ticket and Poap carry `event_id`). */
  eventId: string;
  /** Event name as stored on the object (Ticket.name / Poap.name). */
  name: string;
}

interface EventCreatedJson {
  event_id: string;
  organizer: string;
  name: string;
}

interface TicketMintedJson {
  event_id: string;
  ticket_id: string;
  recipient: string;
  serial: string | number;
}

interface PoapClaimedJson {
  event_id: string;
  recipient: string;
}

export interface DerivedInputs {
  address: string;
  /** Tickets owned by `address` (from getOwnedObjects + TICKET_TYPE). */
  ownedTickets: OwnedRef[];
  /** POAPs owned by `address` (from getOwnedObjects + POAP_TYPE). */
  ownedPoaps: OwnedRef[];
  /** EventCreated logs (newest-first), with on-chain timestampMs. */
  createdEvents: SuiEvent[];
  /** TicketMinted logs (newest-first), with on-chain timestampMs. */
  mintedTickets: SuiEvent[];
  /** PoapClaimed logs (newest-first), with on-chain timestampMs. */
  claimedPoaps: SuiEvent[];
  /** ids previously dismissed (hidden) by the user. */
  dismissed: Set<string>;
  /** ids previously marked read by the user. */
  read: Set<string>;
}

const MAX_ITEMS = 8;

function tsOf(ev: SuiEvent): number {
  return ev.timestampMs ? Number(ev.timestampMs) : 0;
}

/**
 * Pure, chain-free derivation of the inbox feed from on-chain reads + the
 * persisted read/dismissed state. The whole point of the issue: timestamps come
 * from real on-chain `SuiEvent.timestampMs` (joined by object/event id), never
 * `Math.random()`. Sorted newest-first and capped to {@link MAX_ITEMS}.
 *
 * Sources, deduped by a stable id so re-deriving on every read is idempotent:
 *  - owned Ticket  → "purchase" (joined to TicketMinted by ticket_id for ts)
 *  - owned Poap    → "reminder" (joined to PoapClaimed by event_id for ts)
 *  - my EventCreated logs → "publish"
 *  - TicketMinted on my events (recipient ≠ me) → "purchase" (your event sold one)
 */
export function buildNotifications(input: DerivedInputs): AppNotification[] {
  const {
    address,
    ownedTickets,
    ownedPoaps,
    createdEvents,
    mintedTickets,
    claimedPoaps,
    dismissed,
    read,
  } = input;

  const items: AppNotification[] = [];

  // ts lookups from the logs (real on-chain timestamps).
  const mintTsByTicket = new Map<string, number>();
  const mintTsByEvent = new Map<string, number>();
  for (const ev of mintedTickets) {
    const p = ev.parsedJson as TicketMintedJson;
    const ts = tsOf(ev);
    if (!mintTsByTicket.has(String(p.ticket_id))) mintTsByTicket.set(String(p.ticket_id), ts);
    if (!mintTsByEvent.has(String(p.event_id))) mintTsByEvent.set(String(p.event_id), ts);
  }
  const claimTsByEvent = new Map<string, number>();
  for (const ev of claimedPoaps) {
    const p = ev.parsedJson as PoapClaimedJson;
    const ts = tsOf(ev);
    if (!claimTsByEvent.has(String(p.event_id))) claimTsByEvent.set(String(p.event_id), ts);
  }

  // Set of my event ids (from EventCreated logs where I'm the organizer).
  const myEventIds = new Set<string>();
  for (const ev of createdEvents) {
    const p = ev.parsedJson as EventCreatedJson;
    if (p.organizer === address) myEventIds.add(String(p.event_id));
  }

  // Owned tickets → "purchase" (a ticket sitting in my wallet).
  for (const t of ownedTickets) {
    items.push({
      id: `purch_${t.objectId}`,
      type: "purchase",
      title: "Ticket in your wallet",
      description: `Your ticket for ${t.name} is ready.`,
      timestamp: mintTsByTicket.get(t.objectId) ?? 0,
      read: false,
      eventId: t.eventId,
    });
  }

  // Owned POAPs → "reminder" (collectible earned).
  for (const p of ownedPoaps) {
    items.push({
      id: `poap_${p.objectId}`,
      type: "reminder",
      title: "POAP collected",
      description: `You earned a proof-of-attendance for ${p.name}.`,
      timestamp: claimTsByEvent.get(p.eventId) ?? 0,
      read: false,
      eventId: p.eventId,
    });
  }

  // My events → "publish".
  for (const ev of createdEvents) {
    const p = ev.parsedJson as EventCreatedJson;
    if (p.organizer !== address) continue;
    items.push({
      id: `pub_${p.event_id}`,
      type: "publish",
      title: "Event published",
      description: `${p.name} is live on HostIt.`,
      timestamp: tsOf(ev),
      read: false,
      eventId: String(p.event_id),
    });
  }

  // TicketMinted on my events to OTHER buyers → "purchase" (your event sold one).
  for (const ev of mintedTickets) {
    const p = ev.parsedJson as TicketMintedJson;
    if (!myEventIds.has(String(p.event_id))) continue;
    if (p.recipient === address) continue; // a ticket I minted to myself
    items.push({
      id: `sale_${p.ticket_id}`,
      type: "purchase",
      title: "Your event sold a ticket",
      description: `Ticket #${String(p.serial)} was claimed on your event.`,
      timestamp: tsOf(ev),
      read: false,
      eventId: String(p.event_id),
    });
  }

  // Filter dismissed, mark read, dedupe by id, sort desc, cap.
  const seen = new Set<string>();
  return items
    .filter((n) => !dismissed.has(n.id))
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
    .map((n) => ({ ...n, read: read.has(n.id) }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_ITEMS);
}

function parseOwned(
  resp: PaginatedObjectsResponse | undefined,
): OwnedRef[] {
  if (!resp) return [];
  return resp.data.flatMap((entry) => {
    const fields = getFields(entry);
    const objectId = entry.data?.objectId;
    if (!objectId || !fields) return [];
    return [
      {
        objectId,
        eventId: String(fields.event_id ?? ""),
        name: String(fields.name ?? "Event"),
      },
    ];
  });
}

export interface UseNotificationsResult {
  notifications: AppNotification[];
  unread: number;
  /** True when an account is connected (zkLogin/Enoki or wallet). */
  isSignedIn: boolean;
  isLoading: boolean;
  /** Persist & re-derive: mark a single item dismissed (hidden). */
  dismiss: (id: string) => void;
  /** Persist & re-derive: mark every current item read. */
  markAllRead: () => void;
  /** Persist & re-derive: dismiss every current item. */
  clear: () => void;
}

/**
 * Inbox feed derived from on-chain reads, gated on the connected account. Returns
 * an empty feed (and never issues queries) when signed out. Read/dismissed state
 * lives in localStorage (`hostit:notif-inbox`); mutating it bumps a query so the
 * feed re-derives. No notification server, no DB — client-derived only.
 */
export function useNotifications(): UseNotificationsResult {
  const account = useCurrentAccount();
  const address = account?.address ?? null;
  const enabled = Boolean(address);
  // Bumped after any localStorage write so the feed re-derives from the fresh
  // read/dismissed state without depending on a query-cache reference change.
  const [stateVersion, bumpState] = useReducer((n: number) => n + 1, 0);

  const ticketsQ = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: address ?? "",
      filter: { StructType: TICKET_TYPE },
      options: { showContent: true, showType: true },
    },
    { enabled, staleTime: 30_000 },
  );

  const poapsQ = useSuiQuery<"getOwnedObjects", GetOwnedObjectsParams, PaginatedObjectsResponse>(
    "getOwnedObjects",
    {
      owner: address ?? "",
      filter: { StructType: POAP_TYPE },
      options: { showContent: true },
    },
    { enabled, staleTime: 30_000 },
  );

  // Cursor-following enumerations shared with the rest of the app (lib/events.ts).
  const createdQ = useAllEvents(EV_EVENT_CREATED);
  const mintedQ = useAllEvents(EV_TICKET_MINTED);
  const claimedQ = useAllEvents(EV_POAP_CLAIMED);

  const inbox = readInbox();

  const notifications = useMemo(() => {
    if (!address) return [];
    return buildNotifications({
      address,
      ownedTickets: parseOwned(ticketsQ.data),
      ownedPoaps: parseOwned(poapsQ.data),
      createdEvents: createdQ.data?.data ?? [],
      mintedTickets: mintedQ.data?.data ?? [],
      claimedPoaps: claimedQ.data?.data ?? [],
      dismissed: new Set(inbox.dismissed),
      read: new Set(inbox.read),
    });
    // inbox is read from localStorage; re-derive when any source or the persisted
    // state changes. We snapshot the persisted arrays into the dep list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    address,
    ticketsQ.data,
    poapsQ.data,
    createdQ.data,
    mintedQ.data,
    claimedQ.data,
    stateVersion,
  ]);

  const unread = notifications.filter((n) => !n.read).length;

  const isLoading =
    enabled &&
    (ticketsQ.isLoading ||
      poapsQ.isLoading ||
      createdQ.isLoading ||
      mintedQ.isLoading ||
      claimedQ.isLoading);

  function persist(next: InboxState) {
    writeInbox(next);
    // Re-derive: bump forces a re-render, and the memo re-reads localStorage.
    bumpState();
  }

  function dismiss(id: string) {
    const cur = readInbox();
    if (cur.dismissed.includes(id)) return;
    persist({ ...cur, dismissed: [...cur.dismissed, id] });
  }

  function markAllRead() {
    const cur = readInbox();
    const ids = notifications.map((n) => n.id);
    const merged = Array.from(new Set([...cur.read, ...ids]));
    persist({ ...cur, read: merged });
  }

  function clear() {
    const cur = readInbox();
    const ids = notifications.map((n) => n.id);
    const merged = Array.from(new Set([...cur.dismissed, ...ids]));
    persist({ ...cur, dismissed: merged });
  }

  return { notifications, unread, isSignedIn: enabled, isLoading, dismiss, markAllRead, clear };
}
