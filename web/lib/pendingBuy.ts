import { useSyncExternalStore } from "react";
import type { BuyPayload } from "@/components/BuyTicketDialog";

// Persist a buy intent across the Google sign-in full-page redirect. The
// BuyTicketDialog's React state is destroyed by the navigation to Google and
// back, so we stash just enough to rebuild the same BuyPayload and re-open the
// dialog on return (see <ResumeBuy/>). sessionStorage survives the same-tab
// round-trip and is per-tab, so it can't leak the intent to other tabs.

const KEY = "hostit:pendingBuy";
// Bound staleness: a real sign-in round-trip is seconds, so keep this tight — a
// cancelled sign-in (abandoned via browser-back, never consumed at /auth) must
// not pop the buy dialog when an account later appears for an unrelated reason.
const TTL_MS = 3 * 60 * 1000;

// BuyPayload carries bigint fields (priceUnits/remaining/maxPerUser) that JSON
// can't serialize, so they're stored as decimal strings and revived by name —
// no magic markers, so a user-controlled string (eventName) can never be
// mistaken for a number.
interface Serialized {
  kind: "free" | "paid";
  eventId: string;
  eventName: string;
  coinType?: string;
  priceUnits?: string;
  remaining?: string;
  maxPerUser?: string;
  ts: number;
}

/** Stash a buy intent right before redirecting to Google. */
export function stashPendingBuy(p: BuyPayload): void {
  const s: Serialized = {
    kind: p.kind,
    eventId: p.eventId,
    eventName: p.eventName,
    remaining: p.remaining?.toString(),
    maxPerUser: p.maxPerUser?.toString(),
    coinType: p.kind === "paid" ? p.coinType : undefined,
    priceUnits: p.kind === "paid" ? p.priceUnits.toString() : undefined,
    ts: Date.now(),
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* sessionStorage unavailable (SSR/private mode) — resume just won't fire */
  }
}

/** Read + CLEAR the stashed buy intent (one-shot). Null if absent/expired/invalid. */
export function takePendingBuy(): BuyPayload | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    if (raw) sessionStorage.removeItem(KEY); // one-shot, even on a parse failure
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Serialized;
    if (!s?.eventId || !s?.eventName) return null;
    if (typeof s.ts !== "number" || Date.now() - s.ts > TTL_MS) return null;
    const remaining = s.remaining != null ? BigInt(s.remaining) : undefined;
    const maxPerUser = s.maxPerUser != null ? BigInt(s.maxPerUser) : undefined;
    if (s.kind === "paid") {
      if (!s.coinType || s.priceUnits == null) return null;
      return {
        kind: "paid",
        eventId: s.eventId,
        eventName: s.eventName,
        coinType: s.coinType,
        priceUnits: BigInt(s.priceUnits),
        remaining,
        maxPerUser,
      };
    }
    return { kind: "free", eventId: s.eventId, eventName: s.eventName, remaining, maxPerUser };
  } catch {
    return null;
  }
}

// --- "A purchase is resuming" signal ----------------------------------------
// Both <ResumeBuy/> and <ProfileGate/> live in the (app) layout. After a Google
// sign-in mid-purchase, both want to open a modal — the resumed buy must win, so
// ProfileGate yields while this is set (and prompts once the buy closes). A
// module singleton + useSyncExternalStore so the two siblings stay in sync with
// no provider/context plumbing.
let resuming = false;
const resumeListeners = new Set<() => void>();

/** Mark whether a resumed purchase is currently on screen. */
export function setBuyResuming(v: boolean): void {
  if (resuming === v) return;
  resuming = v;
  resumeListeners.forEach((l) => l());
}

/** Reactive read of the resume signal (false during SSR). */
export function useBuyResuming(): boolean {
  return useSyncExternalStore(
    (cb) => {
      resumeListeners.add(cb);
      return () => resumeListeners.delete(cb);
    },
    () => resuming,
    () => false,
  );
}
