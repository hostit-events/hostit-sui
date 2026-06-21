"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ENOKI_ENABLED, EMAIL_ENABLED, COINS, coinInfo, toUnits, EVENT_TYPE, ORGANIZER_CAP_TYPE } from "@/lib/config";
import { createEventTx, createEventWithPriceTx } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import { putEventMetadata, type EventMetadata, type Tier } from "@/lib/metadata";
import { storeFile } from "@/lib/walrus";
import { useProfile } from "@/lib/profile";
import { useIsGoogleSession } from "@/lib/auth";
import { EmailCaptureDialog } from "@/components/EmailCaptureDialog";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
} from "@/lib/hooks";
import { createSessionKey } from "@/lib/seal";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import {
  saveDraft,
  loadDraft,
  deleteDraft,
  type EventDraft,
  type EventDraftForm,
} from "@/lib/drafts";
import { CATEGORIES, catPalette } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { AnimateIcon } from "@/components/animate-ui/icons/icon";
import { ArrowRight } from "@/components/animate-ui/icons/arrow-right";
import { DateTimePicker } from "@/components/DateTimePicker";
import { TicketStub } from "@/components/TicketStub";
import { TxLink } from "@/components/TxLink";
import { useOrganizerMemory, suggestEvent } from "@/lib/memoryClient";
import { coerceSuggestion, type EventSuggestion } from "@/lib/suggest";
import {
  CREATE_MEMORY_QUERY,
  buildCreateSummary,
  mergeCreatePrefs,
  hasAnyPref,
  type CreatePrefs,
} from "@/lib/createMemory";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── inline helpers ──────────────────────────────────────────────────────────
// datetime-local needs a "YYYY-MM-DDTHH:mm" string in the user's local zone.
/**
 * Build the create-event tx: a PAID event (isFree=false with a positive base
 * price) uses the ATOMIC `create_event_with_price` (#68) so it can never be left
 * priced-less/un-buyable; everything else uses plain `create_event`. `price` is
 * the base price in `coinType` smallest units.
 */
function buildCreateEventTx(
  args: {
    name: string;
    symbol: string;
    uri: string;
    startMs: bigint;
    endMs: bigint;
    purchaseStartMs: bigint;
    maxTickets: bigint;
    maxPerUser: bigint;
    isFree: boolean;
    isRefundable: boolean;
    coinType: string;
    price: bigint;
  },
  sender: string,
): ReturnType<typeof createEventTx> {
  if (!args.isFree) {
    // A paid event MUST be priced in the same tx (#68). A non-positive price here
    // means validation let a sub-unit price through (toUnits → null → 0n); fail
    // loudly rather than silently fall through to a priced-less, un-buyable event.
    if (args.price <= 0n)
      throw new Error("A paid event needs a price greater than zero (too small for this coin's precision).");
    return createEventWithPriceTx(
      {
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        startMs: args.startMs,
        endMs: args.endMs,
        purchaseStartMs: args.purchaseStartMs,
        maxTickets: args.maxTickets,
        maxPerUser: args.maxPerUser,
        isRefundable: args.isRefundable,
        coinType: args.coinType,
        price: args.price,
      },
      sender,
    );
  }
  return createEventTx(
    {
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      startMs: args.startMs,
      endMs: args.endMs,
      purchaseStartMs: args.purchaseStartMs,
      maxTickets: args.maxTickets,
      maxPerUser: args.maxPerUser,
      isFree: args.isFree,
      isRefundable: args.isRefundable,
    },
    sender,
  );
}

function isoFromMs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}
function isoLocal(addMinutes = 0): string {
  return isoFromMs(Date.now() + addMinutes * 60_000);
}

// CATEGORIES[0] is the "all" filter — not a real event category.
const PICKABLE = CATEGORIES.filter((c) => c.id !== "all");

// Sane upper bound for ticket counts — guards against fat-finger / overflow.
const MAX_TICKET_LIMIT = 10_000_000;

/**
 * Resolve the new Event (shared) + OrganizerCap (owned) object ids from a
 * create-event tx by reading its on-chain object changes. Uses
 * `waitForTransaction` so it works even if the create result carried no effects
 * (e.g. the sponsored path, which returns only a digest). Shared by both the
 * Quick and Advanced flows so pricing is never silently dropped.
 */
async function resolveCreatedIds(
  client: unknown,
  txDigest: string,
): Promise<{ eventId: string | null; capId: string | null }> {
  const rpc = client as {
    waitForTransaction: (input: {
      digest: string;
      options?: { showObjectChanges?: boolean };
      timeout?: number;
      pollInterval?: number;
    }) => Promise<{
      objectChanges?:
        | Array<{ type?: string; objectType?: string; objectId?: string }>
        | null;
    }>;
  };
  const res = await rpc.waitForTransaction({
    digest: txDigest,
    options: { showObjectChanges: true },
    timeout: 30_000,
  });
  const changes = res.objectChanges ?? [];
  const created = changes.filter((c) => c.type === "created");
  const eventId = created.find((c) => c.objectType === EVENT_TYPE)?.objectId ?? null;
  const capId = created.find((c) => c.objectType === ORGANIZER_CAP_TYPE)?.objectId ?? null;
  return { eventId, capId };
}

interface ExtraTier {
  name: string;
  price: string;
  note: string;
}

const STEPS = [
  { id: 0, label: "Details", icon: "ph:note-pencil-fill" },
  { id: 1, label: "Tickets", icon: "ion:ticket" },
  { id: 2, label: "Promote", icon: "mdi:rocket-launch" },
  { id: 3, label: "Publish", icon: "ph:paper-plane-tilt-fill" },
] as const;

/**
 * Top-level create screen — a single full-featured flow (`AdvancedCreate`): a
 * 4-step wizard (Details → Tickets → Promote → Publish) with a live ticket-stub
 * preview. (The old Quick/Advanced split was removed.)
 */
export function CreateEventScreen() {
  // useSearchParams (resume-from-draft) must sit inside a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <CreateEventInner />
    </Suspense>
  );
}

function CreateEventInner() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const searchParams = useSearchParams();
  const resumeId = searchParams.get("draft");

  // Bumping the key remounts the form so its useState initializers read a resumed
  // draft's `initial`. (Quick/Advanced modes were removed — this is the only flow.)
  const [createKey, setCreateKey] = useState(0);

  // ── Resume from a saved draft (?draft=<id>, GH#46) ──────────────────────────
  // One-time: decrypt the Seal+Walrus draft and rehydrate the form via `initial`
  // + a fresh mount key. Quick-era drafts resume here too (their fields are a
  // subset of the full form). On error we toast and fall through to an empty form.
  const [loadingDraft, setLoadingDraft] = useState<boolean>(Boolean(resumeId));
  const [draftInitial, setDraftInitial] = useState<Partial<EventDraftForm> | null>(null);
  const [resumedId, setResumedId] = useState<string | null>(null);
  const resumeRanRef = useRef(false);

  useEffect(() => {
    if (!resumeId) return;
    // Need a connected wallet (for the Seal session key) before we can decrypt.
    // If it's not ready (initial load) or the wallet disconnects, clear the
    // one-shot guard so a (re)connect re-triggers the resume.
    if (!addr) {
      resumeRanRef.current = false;
      return;
    }
    if (resumeRanRef.current) return;
    resumeRanRef.current = true;
    setLoadingDraft(true);
    let alive = true;
    (async () => {
      try {
        const signer = new CurrentAccountSigner(dAppKit);
        const sessionKey = await createSessionKey(client, addr, async (message: Uint8Array) => {
          const { signature } = await signer.signPersonalMessage(message);
          return { signature };
        });
        const draft = await loadDraft(client, addr, resumeId, sessionKey);
        if (!alive) return;
        setDraftInitial(draft.form);
        setResumedId(resumeId);
        setCreateKey((k) => k + 1);
        toast.success("Draft loaded");
      } catch (e: unknown) {
        if (!alive) return;
        toast.error(humanizeError(e));
      } finally {
        if (alive) setLoadingDraft(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [resumeId, addr, client, dAppKit]);

  return (
    <div className="space-y-6">
      {loadingDraft && (
        <div className="mono flex justify-center" style={{ color: "var(--hi-blue)" }}>
          <Icon icon="svg-spinners:3-dots-fade" size={16} /> Loading draft…
        </div>
      )}
      <AdvancedCreate
        key={createKey}
        initial={draftInitial ?? undefined}
        draftId={resumedId ?? undefined}
      />
    </div>
  );
}

function AdvancedCreate({
  onDirtyChange,
  initial,
  draftId: initialDraftId,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  // Rehydration source when resuming a saved draft (GH#46). useState initializers
  // read `initial?.x ?? <default>`; a fresh mount key makes those run on resume.
  initial?: Partial<EventDraftForm>;
  draftId?: string;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const client = useCurrentClient();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const txPending = regular.isPending || sponsored.isPending;

  // Email gate (GH#96): an organizer should be reachable, so publishing requires
  // a bound email — APP-LAYER only (the on-chain create_event stays permissionless).
  const profile = useProfile(addr);
  const emailBound = Boolean(profile.data?.emailBlobId);
  const isGoogle = useIsGoogleSession();
  const [bindOpen, setBindOpen] = useState(false);

  // Id of the draft this form represents. Set when resuming, and overwritten with
  // the entry id returned by each "Save as draft" so re-saves REPLACE (no dupes).
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const [savingDraft, setSavingDraft] = useState(false);

  const [step, setStep] = useState(0);

  // ── Step 1: Details ──
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? PICKABLE[0].id);
  const [tag, setTag] = useState(initial?.tag ?? "");
  const [start, setStart] = useState(() => initial?.start ?? isoLocal(60)); // now + 1h
  const [end, setEnd] = useState(() => initial?.end ?? isoLocal(60 + 3 * 60)); // start + 3h
  // End auto-tracks start + 3h until the user edits End themselves (#78).
  const endTouched = useRef(initial?.end != null);
  const [venue, setVenue] = useState(initial?.venue ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  // Object-URL preview, revoked on change/unmount (no leak — the old useMemo never
  // revoked). Drives both the upload thumbnail and the live ticket stub.
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!coverFile) {
      setCoverPreview(null);
      return;
    }
    const url = URL.createObjectURL(coverFile);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [coverFile]);
  // Validate + accept a picked/dropped cover (image, <= 8 MB).
  function pickCover(file: File | null) {
    if (!file) {
      setCoverFile(null);
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("Pick an image file (PNG, JPG, GIF or WebP).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("That cover is too large — keep it under 8 MB.");
      return;
    }
    setCoverFile(file);
  }

  // ── Step 2: Tickets ──
  const [basePrice, setBasePrice] = useState(initial?.basePrice ?? "");
  const [coinType, setCoinType] = useState(initial?.coinType ?? COINS[0].type);
  const [maxTickets, setMaxTickets] = useState(initial?.maxTickets ?? "100");
  const [maxPerUser, setMaxPerUser] = useState(initial?.maxPerUser ?? "1");
  const [tiers, setTiers] = useState<ExtraTier[]>(
    () => (initial?.tiers as ExtraTier[] | undefined) ?? [],
  );

  // ── Step 3: Promote ──
  const [poap, setPoap] = useState(initial?.poap ?? true);
  const [refundable, setRefundable] = useState(initial?.refundable ?? false);
  const [isFree, setIsFree] = useState(initial?.isFree ?? false);
  const [web3, setWeb3] = useState(initial?.web3 ?? category === "web3");

  // ── Step 4: Publish ──
  const [agreed, setAgreed] = useState(false);

  // ── flow state ──
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  // Set on success once we resolve the new Event id from the create tx — used for
  // the post-create "Manage event" link.
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  // true once a PAID event is created (price is set atomically in the same tx,
  // #68); null for a free event. Drives the success card.
  const [priceSet, setPriceSet] = useState<boolean | null>(null);
  // Walrus upload caches — on a retry (e.g. the create tx failed after upload)
  // we skip re-uploading blobs whose inputs haven't changed. Keyed on the cover
  // File identity and a stringified snapshot of the metadata inputs.
  const [coverCache, setCoverCache] = useState<{ file: File; blobId: string } | null>(null);
  const [metaCache, setMetaCache] = useState<{ key: string; blobId: string } | null>(null);

  // ── AI-assisted creation: organizer memory (MemWal, GH#19) ──
  // `enabled` is true only when a wallet is connected AND the server memory layer
  // is configured, so everything below cleanly no-ops (and never prompts for a
  // signature) when memory is off / no wallet.
  const { enabled: memoryEnabled, recall, remember, draft } = useOrganizerMemory();
  // AI "Draft with AI" state: true while a draft request is in flight; when a
  // draft would overwrite existing text we stash the ctx here and open a confirm.
  const [drafting, setDrafting] = useState(false);
  const [confirmDraft, setConfirmDraft] = useState(false);
  // "Suggest" — AI-fill the whole form with a funny event concept (#93).
  const [suggesting, setSuggesting] = useState(false);
  const [confirmSuggest, setConfirmSuggest] = useState(false);
  const [suggestedOnce, setSuggestedOnce] = useState(false);
  // Read-only suggestions derived from past events; null until recall resolves.
  const [suggested, setSuggested] = useState<CreatePrefs | null>(null);
  const [suggestDismissed, setSuggestDismissed] = useState(false);
  // EXPLICIT opt-in: remember these details on a successful publish. Default OFF
  // (privacy-conservative) — we never write to memory unless the user ticks this.
  const [rememberOnPublish, setRememberOnPublish] = useState(false);

  // Recall the organizer's past creation preferences once on open. Best-effort:
  // a failure (incl. a declined wallet signature) just leaves suggestions empty
  // and the wizard behaves exactly as before. The once-guard mirrors CopilotPanel.
  const recallRanRef = useRef(false);
  useEffect(() => {
    if (!memoryEnabled || recallRanRef.current) return;
    recallRanRef.current = true;
    let alive = true;
    (async () => {
      const hits = await recall(CREATE_MEMORY_QUERY, 5);
      if (!alive || !hits || !hits.length) return;
      const prefs = mergeCreatePrefs(hits.map((h) => h.text));
      if (hasAnyPref(prefs)) setSuggested(prefs);
    })();
    return () => {
      alive = false;
    };
  }, [memoryEnabled, recall]);

  const [p1, p2] = catPalette(category);
  const ci = coinInfo(coinType);

  // Report dirtiness to the parent so switching modes can confirm before
  // discarding input. "Dirty" = the user typed/picked something beyond defaults.
  const advancedDirty =
    Boolean(digest) ||
    name.trim() !== "" ||
    description.trim() !== "" ||
    venue.trim() !== "" ||
    city.trim() !== "" ||
    tag.trim() !== "" ||
    basePrice.trim() !== "" ||
    coverFile !== null ||
    tiers.length > 0 ||
    maxTickets !== "100" ||
    maxPerUser !== "1";
  useEffect(() => {
    onDirtyChange?.(advancedDirty);
  }, [advancedDirty, onDirtyChange]);

  // A tier row only persists if it has a name; a named row with a non-numeric /
  // negative price is invalid and would be dropped (price coerces to 0).
  function tierState(t: ExtraTier): "ok" | "drop" | "badprice" {
    if (!t.name.trim()) return "drop";
    const p = Number(t.price);
    if (t.price.trim() !== "" && (!Number.isFinite(p) || p < 0)) return "badprice";
    return "ok";
  }

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  // Sale opens at the earliest of now / start; clamped so the on-chain
  // purchase_start_ms <= start_ms holds even when start is ~now.
  const purchaseStartMs = Math.min(Date.now(), startMs);

  // Time rules match the relaxed Move contract: start_ms >= now, end_ms >
  // start_ms, purchase_start_ms <= start_ms. No minimum lead or duration
  // (kept consistent with Quick create).
  function validateTimes(): string | null {
    if (![startMs, endMs].every(Number.isFinite)) return "Dates must be valid.";
    if (startMs < Date.now() - 60_000) return "Start can't be in the past.";
    if (endMs <= startMs) return "End must be after start.";
    return null;
  }

  function stepError(s: number): string | null {
    if (s === 0) {
      if (!name.trim()) return "Event name is required.";
      const t = validateTimes();
      if (t) return t;
    }
    if (s === 1) {
      const maxT = Number(maxTickets);
      const maxU = Number(maxPerUser);
      if (!Number.isInteger(maxT) || maxT <= 0)
        return "Max tickets must be a whole number greater than 0.";
      if (maxT > MAX_TICKET_LIMIT)
        return `Max tickets can't exceed ${MAX_TICKET_LIMIT.toLocaleString()}.`;
      if (!Number.isInteger(maxU) || maxU <= 0)
        return "Max per attendee must be a whole number greater than 0.";
      if (maxU > maxT) return "Max per attendee can't exceed max tickets.";
      if (!isFree) {
        if (!basePrice.trim()) return "Set a base price, or mark the event as free.";
        const price = Number(basePrice);
        if (!Number.isFinite(price) || price <= 0)
          return "Base price must be a number greater than 0.";
      }
    }
    return null;
  }

  // Live Step-1 date validation, surfaced inline beneath the date pickers.
  const dateError = validateTimes();
  // Live Step-2 validation (capacity + base price), surfaced inline as the user
  // types — same rule set the Next/Publish guard enforces.
  const ticketError = stepError(1);

  // Smart time UX (#78): End follows Start by +3h until the user edits End.
  function onStartChange(v: string) {
    setStart(v);
    if (!endTouched.current) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) setEnd(isoFromMs(ms + 3 * 3_600_000));
    }
  }
  function onEndChange(v: string) {
    endTouched.current = true;
    setEnd(v);
  }

  function next() {
    const e = stepError(step);
    if (e) return setErr(e);
    setErr(null);
    setStep((s) => Math.min(3, s + 1));
  }
  function back() {
    setErr(null);
    setStep((s) => Math.max(0, s - 1));
  }

  function addTier() {
    setTiers((t) => [...t, { name: "", price: "", note: "" }]);
  }
  function updateTier(i: number, patch: Partial<ExtraTier>) {
    setTiers((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  }
  function removeTier(i: number) {
    setTiers((t) => t.filter((_, j) => j !== i));
  }

  // ── Suggestion appliers (NO-CLOBBER) ──────────────────────────────────────
  // Each "Use" fills its field ONLY when the field is still empty/untouched.
  // A field the user has already typed into is never overwritten. Category maps
  // to a real, pickable category id (case-insensitive) or is ignored.
  function useSuggestedCategory(value: string) {
    const match = PICKABLE.find(
      (c) => c.id.toLowerCase() === value.toLowerCase() || c.label.toLowerCase() === value.toLowerCase(),
    );
    if (!match) return;
    // Only fill if the user is still on the default (first) category, untouched.
    if (category === PICKABLE[0].id) {
      setCategory(match.id);
      if (match.id === "web3") setWeb3(true);
    }
  }
  function useSuggestedCity(value: string) {
    if (!city.trim()) setCity(value);
  }
  function useSuggestedVenue(value: string) {
    if (!venue.trim()) setVenue(value);
  }
  function useSuggestedCapacity(value: string) {
    // maxTickets defaults to "100"; only apply a suggestion if it's still that
    // default (i.e. the user hasn't set their own capacity) and the value parses.
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && maxTickets === "100") {
      setMaxTickets(String(n));
    }
  }
  function useSuggestedPrice(value: string) {
    // Stored as a label like "25 SUI" or "Free". Conservatively fill ONLY the
    // numeric base price, and only when the event isn't free and the field is
    // still empty. Coin type is left untouched (the symbol isn't applied).
    if (isFree || basePrice.trim()) return;
    const num = value.match(/[\d.]+/)?.[0];
    const n = num ? Number(num) : NaN;
    if (Number.isFinite(n) && n > 0) setBasePrice(num as string);
  }

  // ── AI draft (GH#19) ───────────────────────────────────────────────────────
  // Gather the form context and ask /api/create-assist (via the memory hook) for
  // a description. When memory is on this signs the same envelope recall uses so
  // the route may ground the draft in past events; when off it sends ctx only.
  // The route never blocks — it always returns a draft (groq or fallback).
  async function runDraft() {
    if (!name.trim()) return; // guarded by the disabled button, belt-and-braces
    setDrafting(true);
    try {
      const { description: drafted, sourced } = await draft({
        name: name.trim(),
        category,
        venue: venue.trim() || undefined,
        city: city.trim() || undefined,
        date: start,
        tag: tag.trim() || undefined,
      });
      setDescription(drafted);
      toast.success(
        sourced === "groq" ? "Drafted with AI" : "Draft ready",
        sourced === "fallback"
          ? { description: "AI was unavailable — here's a starter draft you can edit." }
          : undefined,
      );
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setDrafting(false);
    }
  }

  // Click handler for the "Draft with AI" / "Regenerate" button. Confirms before
  // overwriting a non-empty description; otherwise drafts immediately.
  function onDraftClick() {
    if (!name.trim() || drafting) return;
    if (description.trim()) {
      setConfirmDraft(true);
      return;
    }
    void runDraft();
  }

  // ── Suggest: AI-fill the form with a funny event concept (#93) ──────────────
  // Apply a (already-coerced) suggestion to the form. Keeps the smart time
  // defaults and the generated cover art; the organizer edits anything before
  // publishing.
  function applySuggestion(s: EventSuggestion) {
    setName(s.name);
    setCategory(s.category);
    if (s.category === "web3") setWeb3(true);
    setTag(s.tag ?? "");
    setVenue(s.venue ?? "");
    setCity(s.city ?? "");
    setDescription(s.description);
    setIsFree(s.free);
    if (!s.free) {
      setBasePrice(s.price != null ? String(s.price) : "");
      setCoinType(COINS.find((c) => c.symbol === s.coin)?.type ?? COINS[0].type);
    }
    if (s.capacity != null) setMaxTickets(String(s.capacity));
    if (s.maxPerUser != null) setMaxPerUser(String(s.maxPerUser));
    setSuggestDismissed(true); // hide the past-events suggestion banner if shown
  }

  async function runSuggest() {
    if (suggesting) return;
    setSuggesting(true);
    try {
      const { suggestion, sourced } = await suggestEvent();
      const safe = coerceSuggestion(suggestion); // defense — server already coerces
      if (!safe) throw new Error("The suggestion came back malformed. Try again.");
      applySuggestion(safe);
      setSuggestedOnce(true);
      toast.success(
        sourced === "groq" ? "Conjured a fresh event ✨" : "Here's a starter event",
        sourced === "fallback"
          ? { description: "AI was busy — here's a fun one to riff on. Edit anything." }
          : { description: "Tweak anything, then publish." },
      );
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setSuggesting(false);
    }
  }

  // Confirm before overwriting a form the user has already started.
  function onSuggestClick() {
    if (suggesting) return;
    if (name.trim() || description.trim()) {
      setConfirmSuggest(true);
      return;
    }
    void runSuggest();
  }

  async function publish() {
    if (!addr) return setErr("Connect a wallet to publish.");
    if (EMAIL_ENABLED && !emailBound) {
      setBindOpen(true);
      return setErr("Add an email to your account before publishing — attendees need a way to reach you.");
    }
    // re-validate everything up to publish
    for (const s of [0, 1]) {
      const e = stepError(s);
      if (e) {
        setStep(s);
        return setErr(e);
      }
    }
    if (!agreed) return setErr("Please accept the terms to publish.");

    setErr(null);
    setDigest(null);
    setCreatedEventId(null);
    setPriceSet(null);
    try {
      // 1) Cover image → Walrus (optional). Reuse a cached upload on retry when
      // the selected file is unchanged.
      let coverBlobId: string | undefined;
      if (coverFile) {
        if (coverCache && coverCache.file === coverFile) {
          coverBlobId = coverCache.blobId;
        } else {
          setBusy("Uploading cover to Walrus…");
          coverBlobId = await storeFile(coverFile);
          setCoverCache({ file: coverFile, blobId: coverBlobId });
        }
      }

      // 2) Build + store rich metadata JSON → Walrus → blobId (goes on-chain as uri)
      const metaTiers: Tier[] = [];
      if (!isFree && basePrice.trim() !== "") {
        metaTiers.push({ name: "General Admission", price: Number(basePrice) || 0 });
      }
      for (const t of tiers) {
        if (!t.name.trim()) continue;
        metaTiers.push({
          name: t.name.trim(),
          price: Number(t.price) || 0,
          ...(t.note.trim() ? { note: t.note.trim() } : {}),
        });
      }
      const metadata: EventMetadata = {
        v: 1,
        description: description.trim(),
        category,
        ...(tag.trim() ? { tag: tag.trim() } : {}),
        ...(venue.trim() ? { venue: venue.trim() } : {}),
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(coverBlobId ? { coverBlobId } : {}),
        ...(metaTiers.length ? { tiers: metaTiers } : {}),
        poap,
        web3,
        refundable,
      };
      // Reuse the cached metadata blob on retry when the JSON is byte-identical.
      const metaKey = JSON.stringify(metadata);
      let blobId: string;
      if (metaCache && metaCache.key === metaKey) {
        blobId = metaCache.blobId;
      } else {
        setBusy("Storing event metadata on Walrus…");
        blobId = await putEventMetadata(metadata);
        setMetaCache({ key: metaKey, blobId });
      }

      // 3) Create the event on-chain (uri = metadata blobId). Paid events use the
      // ATOMIC create_event_with_price (#68) — create + price in ONE tx, so a
      // paid event can never be left priced-less. Free events use create_event.
      const wantsPrice = !isFree && basePrice.trim() !== "" && Number(basePrice) > 0;
      const priceUnits = wantsPrice ? toUnits(basePrice, coinInfo(coinType).decimals) : 0n;
      // A paid event must resolve to a positive on-chain price; reject sub-unit
      // precision (toUnits → null) HERE so we never build a priced-less event (#68).
      if (wantsPrice && (priceUnits === null || priceUnits <= 0n)) {
        setBusy(null);
        toast.error("That price is too small for this coin's precision — use a larger amount.");
        return;
      }
      setBusy("Creating event on Sui…");
      const tx = buildCreateEventTx(
        {
          name: name.trim(),
          symbol: category.slice(0, 4).toUpperCase(),
          uri: blobId,
          startMs: BigInt(startMs),
          endMs: BigInt(endMs),
          purchaseStartMs: BigInt(purchaseStartMs),
          maxTickets: BigInt(Math.trunc(Number(maxTickets))),
          maxPerUser: BigInt(Math.trunc(Number(maxPerUser))),
          isFree,
          isRefundable: refundable,
          coinType,
          price: priceUnits ?? 0n,
        },
        addr,
      );
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      toast.success("Your event is live", {
        description: <TxLink digest={out.digest} chars={10} />,
      });

      // The draft is now a real event — drop it from the index (GH#46).
      if (draftId && addr) {
        deleteDraft(addr, draftId);
        setDraftId(null);
      }

      // Resolve the new Event id for navigation. Price is set atomically for paid
      // events now, so there's no follow-up set_price to recover from.
      const ids = await resolveCreatedIds(client, out.digest).catch(() => null);
      if (ids?.eventId) setCreatedEventId(ids.eventId);
      setPriceSet(wantsPrice ? true : null);

      // 5) EXPLICIT opt-in memory write (GH#19). Only when the user ticked the
      // "Remember these details" box AND memory is on. Best-effort and strictly
      // non-blocking: the event is already live, so any memory failure is
      // swallowed/logged and never surfaced as a publish error.
      if (rememberOnPublish && memoryEnabled) {
        const summary = buildCreateSummary({
          category,
          city,
          venue,
          isFree,
          basePrice,
          coinSymbol: ci.symbol,
          maxTickets,
        });
        if (summary) {
          try {
            await remember(summary);
          } catch (memErr) {
            // Never block or fail the publish on a memory error.
            console.warn("[create] remember() failed (non-fatal):", memErr);
          }
        }
      }
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  // ── Save as draft (GH#46) ───────────────────────────────────────────────────
  // Encrypts the current form (Seal) and stores it as a Walrus blob via
  // lib/drafts; the returned entry id is stashed so a re-save REPLACES (no dupes).
  // A cover image is uploaded to Walrus FIRST (reusing the publish coverCache) so
  // the draft only carries a coverBlobId, never the raw File.
  async function saveAsDraft() {
    if (!addr) return; // guarded by the disabled button — needs addr for Seal + index
    setSavingDraft(true);
    try {
      let coverBlobId: string | undefined;
      if (coverFile) {
        if (coverCache && coverCache.file === coverFile) {
          coverBlobId = coverCache.blobId;
        } else {
          coverBlobId = await storeFile(coverFile);
          setCoverCache({ file: coverFile, blobId: coverBlobId });
        }
      }
      const form: EventDraftForm = {
        name,
        category,
        tag,
        start,
        end,
        venue,
        city,
        description,
        basePrice,
        coinType,
        maxTickets,
        maxPerUser,
        isFree,
        tiers,
        poap,
        refundable,
        web3,
        ...(coverBlobId ? { coverBlobId } : {}),
      };
      const draft: EventDraft = {
        v: 1,
        mode: "advanced",
        title: name.trim() || "Untitled draft",
        savedAt: Date.now(),
        form,
      };
      const entry = await saveDraft(client, addr, draft, draftId ?? undefined);
      setDraftId(entry.id);
      toast.success("Draft saved");
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setSavingDraft(false);
    }
  }


  const dateLabel = Number.isFinite(startMs)
    ? new Date(startMs).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Date TBA";
  const venueLabel =
    [venue.trim(), city.trim()].filter(Boolean).join(" · ") || "Venue TBA";

  // ── success ──
  if (digest) {
    return (
      <div className="space-y-6 screen-in" style={{ maxWidth: 560, margin: "0 auto" }}>
        <Card className="text-center" style={{ padding: 36 }}>
          <div
            className="poster"
            style={
              {
                width: 92,
                height: 92,
                margin: "0 auto 18px",
                borderRadius: "50%",
                display: "grid",
                placeItems: "center",
                ["--p1" as string]: p1,
                ["--p2" as string]: p2,
              } as React.CSSProperties
            }
          >
            <Icon icon="mdi:rocket-launch" size={40} style={{ color: "#fff", position: "relative" }} />
          </div>
          <h1 className="page-title" style={{ fontSize: 26 }}>
            Your event is live
          </h1>
          <p className="page-sub">
            <strong style={{ color: "var(--fg1)" }}>{name.trim() || "Your event"}</strong> is now on
            Sui, with metadata{coverFile ? " and cover" : ""} stored on Walrus.
          </p>
          <div style={{ marginTop: 10 }}>
            <TxLink digest={digest} chars={12} className="mono" />
          </div>
          {!isFree && priceSet === true && (
            <Card
              style={{
                marginTop: 18,
                textAlign: "left",
                padding: 16,
                background: "rgba(0,200,120,.08)",
                borderColor: "var(--color-success)",
              }}
            >
              <div className="flex items-center gap-2" style={{ color: "var(--color-success)" }}>
                <Icon icon="ph:check-circle-fill" size={16} />
                <span className="text-sm font-semibold">Ticket price set</span>
              </div>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
                Your price{basePrice.trim() ? ` (${basePrice} ${ci.symbol})` : ""} is live on-chain.
                You can adjust pricing and add more coins any time from your{" "}
                <Link href="/dashboard" style={{ color: "var(--hi-blue)", fontWeight: 600 }}>
                  dashboard
                </Link>
                .
              </p>
            </Card>
          )}
          <div className="flex gap-2 justify-center" style={{ marginTop: 22, flexWrap: "wrap" }}>
            <Button asChild size="lg">
              <Link href={createdEventId ? `/manage/${createdEventId}` : "/dashboard"}>
                <Icon icon="ph:pencil-simple-fill" size={18} />{" "}
                {createdEventId ? "Manage event" : "Go to dashboard"}
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDigest(null);
                setCreatedEventId(null);
                setPriceSet(null);
                setStep(0);
                setName("");
                setAgreed(false);
              }}
            >
              Create another
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-7 screen-in">
      <header className="relative">
        <div
          className="glow"
          style={{ width: 360, height: 360, background: p1, top: -150, right: -40, opacity: 0.16 }}
        />
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 32 }}>
          Forge an event
        </h1>
        <p className="page-sub">
          Fill the stub on the right — it becomes the ticket attendees hold and scan. Permissionless:
          the wallet that signs is the organizer; media &amp; metadata live on Walrus.
          {ENOKI_ENABLED && <span style={{ color: "var(--color-success)" }}> Gas is sponsored.</span>}
        </p>
      </header>

      {/* AI-assisted creation: read-only suggestions from past events (GH#19).
          Renders nothing when memory is off / no wallet / no usable memories, or
          once dismissed. Suggestions never overwrite a field the user has typed. */}
      {memoryEnabled && suggested && !suggestDismissed && (
        <SuggestionBanner
          prefs={suggested}
          currentCategory={category}
          defaultCategoryId={PICKABLE[0].id}
          city={city}
          venue={venue}
          basePrice={basePrice}
          maxTickets={maxTickets}
          isFree={isFree}
          onUseCategory={useSuggestedCategory}
          onUseCity={useSuggestedCity}
          onUseVenue={useSuggestedVenue}
          onUsePrice={useSuggestedPrice}
          onUseCapacity={useSuggestedCapacity}
          onDismiss={() => setSuggestDismissed(true)}
        />
      )}

      {/* step rail */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {STEPS.map((s) => (
          <Button
            key={s.id}
            variant={step === s.id ? "default" : "outline"}
            size="sm"
            onClick={() => {
              if (s.id <= step) return setStep(s.id);
              const e = stepError(step);
              if (e) return setErr(e);
              setErr(null);
              setStep(s.id);
            }}
          >
            <Icon icon={step > s.id ? "ph:check-bold" : s.icon} size={14} /> {s.id + 1}. {s.label}
          </Button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* ── form column ── */}
        <Card className="space-y-5" style={{ padding: 20 }}>
          {step === 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2">
                <span className="section-label">Step 1 — Details</span>
                {/* Suggest (#93): top-right of the Details card — fills the form with a funny AI event. */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onSuggestClick}
                      disabled={suggesting}
                      aria-label="Suggest a fun event"
                    >
                      {suggesting ? (
                        <>
                          <Icon icon="svg-spinners:3-dots-fade" size={14} /> Conjuring…
                        </>
                      ) : (
                        <>
                          <Icon icon="ph:magic-wand-fill" size={14} />{" "}
                          {suggestedOnce ? "Suggest another" : "Suggest"}
                        </>
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Fill the form with a fun AI-generated event — edit anything before you publish.
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ce-event-name">Event name</Label>
                <Input
                  id="ce-event-name"
                  placeholder="e.g. Sui Builders Night"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div role="group" aria-label="Category" className="space-y-1.5">
                <div className="text-sm font-medium" aria-hidden="true">Category</div>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={category}
                  onValueChange={(v) => {
                    if (!v) return;
                    setCategory(v);
                    if (v === "web3") setWeb3(true);
                  }}
                  className="flex-wrap"
                >
                  {PICKABLE.map((c) => (
                    <ToggleGroupItem key={c.id} value={c.id}>
                      <Icon icon={c.icon} size={14} /> {c.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ce-start">Event starts</Label>
                  <DateTimePicker id="ce-start" value={start} min={isoLocal()} onChange={onStartChange} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ce-end">Event ends</Label>
                  <DateTimePicker id="ce-end" value={end} min={start} onChange={onEndChange} />
                </div>
              </div>
              {dateError && (
                <p className="text-xs" style={{ color: "var(--color-danger)" }}>
                  <Icon icon="ph:warning-circle-fill" size={12} /> {dateError}
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ce-venue">Venue</Label>
                  <Input
                    id="ce-venue"
                    placeholder="e.g. The Glasshouse"
                    value={venue}
                    onChange={(e) => setVenue(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ce-city">City</Label>
                  <Input
                    id="ce-city"
                    placeholder="e.g. Lisbon"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ce-tag">Tag (optional)</Label>
                <Input
                  id="ce-tag"
                  placeholder="e.g. Conference, Festival, Meetup"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="ce-description">Description</Label>
                  {/* Draft with AI (GH#19). Disabled until the event has a name
                      (so the draft has something to work with) and while a draft
                      is in flight. Reads "Regenerate" once the field has text. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* span wrapper so the tooltip still fires when disabled */}
                      <span tabIndex={!name.trim() ? 0 : -1}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onDraftClick}
                          disabled={!name.trim() || drafting}
                          title={!name.trim() ? "Add an event name first" : undefined}
                        >
                          {drafting ? (
                            <>
                              <Icon icon="svg-spinners:3-dots-fade" size={13} /> Drafting…
                            </>
                          ) : (
                            <>
                              <Icon icon="ph:sparkle-fill" size={13} />{" "}
                              {description.trim() ? "Regenerate" : "Draft with AI"}
                            </>
                          )}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {!name.trim()
                        ? "Add an event name first"
                        : description.trim()
                          ? "Replace the description with a fresh AI draft"
                          : "Draft a description from your event details"}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Textarea
                  id="ce-description"
                  placeholder="What is this event about? Who is it for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ce-cover">Cover image</Label>
                <CoverPicker
                  previewUrl={coverPreview}
                  onPick={pickCover}
                  onClear={() => setCoverFile(null)}
                />
                <p className="text-xs" style={{ color: "var(--fg3)" }}>
                  Optional — skip it and we&apos;ll seed unique art from your title &amp; category.
                  Stored on Walrus on publish.
                </p>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <span className="section-label">Step 2 — Tickets</span>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Free event</div>
                  <div className="text-xs" style={{ color: "var(--fg3)" }}>
                    Attendees claim for free — no on-chain price.
                  </div>
                </div>
                <Switch
                  aria-label="Free event"
                  checked={isFree}
                  onCheckedChange={(v) => setIsFree(Boolean(v))}
                />
              </div>

              {!isFree && (
                <div className="grid sm:grid-cols-[1fr_140px] gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="ce-base-price">Base price</Label>
                    <Input
                      id="ce-base-price"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="0.00"
                      value={basePrice}
                      onChange={(e) => setBasePrice(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ce-coin">Coin</Label>
                    <Select value={coinType} onValueChange={(v) => setCoinType(v)}>
                      <SelectTrigger id="ce-coin" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COINS.map((c) => (
                          <SelectItem key={c.type} value={c.type}>
                            {c.symbol}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              {!isFree && (
                <p className="text-xs" style={{ color: "var(--fg3)" }}>
                  A 3% platform fee is added on top at checkout. Pricing is set from your dashboard
                  after creation (the Event is shared on-chain).
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ce-max-tickets">Max tickets</Label>
                  <Input
                    id="ce-max-tickets"
                    type="number"
                    min={1}
                    step="1"
                    value={maxTickets}
                    onChange={(e) => setMaxTickets(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ce-max-per-user">Max per attendee</Label>
                  <Input
                    id="ce-max-per-user"
                    type="number"
                    min={1}
                    step="1"
                    value={maxPerUser}
                    onChange={(e) => setMaxPerUser(e.target.value)}
                  />
                </div>
              </div>
              {ticketError && (
                <p className="text-xs" style={{ color: "var(--color-danger)" }}>
                  <Icon icon="ph:warning-circle-fill" size={12} /> {ticketError}
                </p>
              )}

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">
                    Additional tiers (optional)
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={addTier}>
                    <Icon icon="ph:plus-bold" size={13} /> Add tier
                  </Button>
                </div>
                <p className="text-xs" style={{ color: "var(--fg3)" }}>
                  Extra tiers are saved in event metadata (Walrus) for display. Set their on-chain
                  prices later.
                </p>
                {tiers.map((t, i) => {
                  const st = tierState(t);
                  return (
                    <div key={i} className="space-y-1">
                      <div className="grid sm:grid-cols-[1fr_120px_1fr_auto] gap-2 items-start">
                        <Input
                          id={`ce-tier-name-${i}`}
                          aria-label="Tier name"
                          placeholder="Tier name (e.g. VIP)"
                          value={t.name}
                          onChange={(e) => updateTier(i, { name: e.target.value })}
                        />
                        <Input
                          id={`ce-tier-price-${i}`}
                          aria-label="Tier price"
                          type="number"
                          min={0}
                          step="any"
                          placeholder="Price"
                          value={t.price}
                          onChange={(e) => updateTier(i, { price: e.target.value })}
                        />
                        <Input
                          id={`ce-tier-note-${i}`}
                          aria-label="Tier note"
                          placeholder="Note (optional)"
                          value={t.note}
                          onChange={(e) => updateTier(i, { note: e.target.value })}
                        />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="destructive"
                              size="icon-sm"
                              onClick={() => removeTier(i)}
                              aria-label="Remove tier"
                            >
                              <Icon icon="ph:trash-fill" size={14} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Remove tier</TooltipContent>
                        </Tooltip>
                      </div>
                      {st === "drop" && (
                        <p className="text-xs" style={{ color: "var(--hi-amber)" }}>
                          <Icon icon="ph:warning-fill" size={12} /> Add a name or this tier won&apos;t
                          be saved.
                        </p>
                      )}
                      {st === "badprice" && (
                        <p className="text-xs" style={{ color: "var(--hi-amber)" }}>
                          <Icon icon="ph:warning-fill" size={12} /> Price isn&apos;t a valid number —
                          it will be saved as 0.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <span className="section-label">Step 3 — Promote</span>
              <Toggle
                on={poap}
                set={setPoap}
                icon="ph:seal-check-fill"
                title="Proof-of-Attendance (POAP)"
                desc="Attendees can claim a commemorative POAP NFT after check-in."
              />
              <Toggle
                on={refundable}
                set={setRefundable}
                icon="ph:arrow-u-up-left-bold"
                title="Refundable"
                desc="Holders can refund within 3 days after the event ends."
              />
              <Toggle
                on={web3}
                set={setWeb3}
                icon="ph:cube-transparent-fill"
                title="Web3 / on-chain native"
                desc="Flag this as a web3-native event in discovery."
              />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <span className="section-label">Step 4 — Review &amp; publish</span>
              <div className="grid sm:grid-cols-2 gap-3">
                <Review label="Name" value={name.trim() || "—"} />
                <Review label="Category" value={category} />
                <Review label="Starts" value={dateLabel} />
                <Review label="Venue" value={venueLabel} />
                <Review label="Capacity" value={`${maxTickets} (max ${maxPerUser}/attendee)`} />
                <Review
                  label="Price"
                  value={
                    isFree ? "Free" : basePrice.trim() ? `${basePrice} ${ci.symbol} + 3%` : "Set later"
                  }
                />
                <Review label="Symbol" value={category.slice(0, 4).toUpperCase()} />
                <Review
                  label="Perks"
                  value={
                    [poap && "POAP", refundable && "Refundable", web3 && "Web3"]
                      .filter(Boolean)
                      .join(" · ") || "None"
                  }
                />
              </div>

              <Card
                style={{ padding: 16, background: "rgba(0,124,250,.06)", borderColor: "rgba(0,124,250,.4)" }}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Icon icon="ph:database-fill" size={16} style={{ color: "var(--hi-blue)" }} />
                  Stored on Walrus
                </div>
                <p className="text-xs" style={{ color: "var(--fg2)", marginTop: 6 }}>
                  On publish we upload your {coverFile ? "cover image and " : ""}event metadata
                  (description, category, venue, tiers) to Walrus, then write the resulting blob id
                  on-chain as the event URI.
                </p>
              </Card>

              <label className="flex items-start gap-3" style={{ cursor: "pointer" }}>
                <Checkbox
                  checked={agreed}
                  onCheckedChange={(v) => setAgreed(Boolean(v))}
                  style={{ marginTop: 3 }}
                />
                <span className="text-sm" style={{ color: "var(--fg2)" }}>
                  I confirm the details are accurate and accept that I become the organizer of this
                  event on Sui.
                </span>
              </label>

              {/* EXPLICIT opt-in memory write (GH#19). Default UNCHECKED. Only
                  shown when memory is on (wallet connected + server layer live). */}
              {memoryEnabled && (
                <Card style={{ padding: 0, background: "rgba(0,124,250,.04)" }}>
                  <label
                    className="flex items-start gap-3"
                    style={{ cursor: "pointer", padding: 14 }}
                  >
                    <Checkbox
                      checked={rememberOnPublish}
                      onCheckedChange={(v) => setRememberOnPublish(Boolean(v))}
                      style={{ marginTop: 3 }}
                    />
                    <span className="text-sm" style={{ color: "var(--fg2)" }}>
                      <span className="font-semibold" style={{ color: "var(--fg1)" }}>
                        <Icon icon="ph:sparkle-fill" size={13} style={{ color: "var(--hi-blue)" }} />{" "}
                        Remember these details to speed up my next event
                      </span>
                      <span style={{ display: "block", marginTop: 3, color: "var(--fg3)" }}>
                        Saves your category, city, venue, price and capacity to your private organizer
                        memory (not the event name). Off by default — you&apos;ll sign to confirm.
                      </span>
                    </span>
                  </label>
                </Card>
              )}
            </div>
          )}

          {err && (
            <div className="text-sm break-words" style={{ color: "var(--color-danger)" }}>
              <Icon icon="ph:warning-circle-fill" size={14} /> {err}
            </div>
          )}
          {busy && (
            <div className="mono" style={{ color: "var(--hi-blue)" }}>
              <Icon icon="svg-spinners:3-dots-fade" size={16} /> {busy}
            </div>
          )}

          {/* nav */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button variant="outline" onClick={back} disabled={step === 0 || !!busy}>
              <Icon icon="ph:arrow-left-bold" size={14} /> Back
            </Button>
            <div className="flex items-center gap-2">
              {/* Save as draft (GH#46) — encrypts the form to Walrus via Seal.
                  Needs a connected wallet for the Seal policy + index key. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={!addr ? 0 : -1}>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={saveAsDraft}
                      disabled={!addr || savingDraft || !!busy || txPending}
                    >
                      {savingDraft ? (
                        <>
                          <Icon icon="svg-spinners:3-dots-fade" size={14} /> Saving…
                        </>
                      ) : (
                        <>
                          <Icon icon="ph:floppy-disk-fill" size={14} /> Save as draft
                        </>
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {!addr
                    ? "Connect a wallet to save an encrypted draft"
                    : "Encrypt and save this draft to Walrus"}
                </TooltipContent>
              </Tooltip>
              {step < 3 ? (
                <AnimateIcon asChild animateOnHover>
                  <Button onClick={next}>
                    Next <ArrowRight size={14} />
                  </Button>
                </AnimateIcon>
              ) : !addr ? (
                <Badge variant="outline">Connect a wallet to publish</Badge>
              ) : EMAIL_ENABLED && !emailBound ? (
                <Button size="lg" onClick={() => setBindOpen(true)}>
                  <Icon icon="ic:round-mail" size={18} /> Add email to publish
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={publish}
                  disabled={!agreed || !!busy || txPending}
                >
                  <Icon icon="mdi:rocket-launch" size={18} />
                  {busy || txPending ? "Publishing…" : "Publish event"}
                </Button>
              )}
            </div>
          </div>
        </Card>

        {bindOpen && addr && (
          <EmailCaptureDialog
            address={addr}
            mode={isGoogle ? "google" : "wallet"}
            baseProfile={profile.data ?? null}
            onClose={() => setBindOpen(false)}
            onBound={() => {
              setBindOpen(false);
              profile.refetch();
            }}
          />
        )}

        {/* ── live ticket stub: the product, mid-fabrication ── */}
        <aside className="space-y-2.5" style={{ position: "sticky", top: 20 }}>
          <TicketStub
            name={name}
            category={category}
            startMs={startMs}
            endMs={endMs}
            venue={venue}
            city={city}
            isFree={isFree}
            price={basePrice}
            coinSymbol={ci.symbol}
            capacity={maxTickets}
            organizer={addr}
            gasSponsored={ENOKI_ENABLED}
            coverUrl={coverPreview ?? undefined}
          />
          <p
            className="mono"
            style={{ textAlign: "center", color: "var(--fg3)", fontSize: 11, letterSpacing: ".04em" }}
          >
            <Icon icon="ph:eye-fill" size={12} /> Live preview · this is the ticket
          </p>
        </aside>
      </div>

      {/* Confirm before an AI draft overwrites an existing description (GH#19).
          Mirrors the mode-switch discard dialog's shadcn pattern. */}
      <Dialog open={confirmDraft} onOpenChange={(o) => !o && setConfirmDraft(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace your description?</DialogTitle>
            <DialogDescription>
              Drafting with AI will replace what you&apos;ve already written in the description
              field. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDraft(false)}>
              Keep what I have
            </Button>
            <Button
              onClick={() => {
                setConfirmDraft(false);
                void runDraft();
              }}
            >
              <Icon icon="ph:sparkle-fill" size={14} /> Replace with AI draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm before a Suggest overwrites a form the user has started (#93). */}
      <Dialog open={confirmSuggest} onOpenChange={(o) => !o && setConfirmSuggest(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace your draft with a suggestion?</DialogTitle>
            <DialogDescription>
              This fills the form with a fresh AI-generated event, replacing what you&apos;ve
              entered. You can edit everything before publishing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSuggest(false)}>
              Keep what I have
            </Button>
            <Button
              onClick={() => {
                setConfirmSuggest(false);
                void runSuggest();
              }}
            >
              <Icon icon="ph:magic-wand-fill" size={14} /> Surprise me
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Toggle({
  on,
  set,
  icon,
  title,
  desc,
}: {
  on: boolean;
  set: (v: boolean) => void;
  icon: string;
  title: string;
  desc: string;
}) {
  return (
    <Card className="flex flex-row items-center justify-between gap-3" style={{ padding: 16 }}>
      <div className="flex items-start gap-3">
        <Icon icon={icon} size={20} style={{ color: on ? "var(--hi-blue)" : "var(--fg3)" }} />
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs" style={{ color: "var(--fg3)" }}>
            {desc}
          </div>
        </div>
      </div>
      <Switch
        aria-label={title}
        checked={on}
        onCheckedChange={(v) => set(Boolean(v))}
      />
    </Card>
  );
}

// Cover upload affordance: a click/drop dashed tile when empty, a thumbnail with
// hover Replace/Remove when set. Validation (type/size) lives in the caller's
// onPick; the object-URL preview is owned + revoked by the caller.
function CoverPicker({
  previewUrl,
  onPick,
  onClear,
}: {
  previewUrl: string | null;
  onPick: (f: File | null) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        aria-label="Cover image"
        onChange={(e) => {
          onPick(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      {previewUrl ? (
        <div className="cover-pick has">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt="Cover preview" className="cover-pick-img" />
          <div className="cover-pick-actions">
            <Button type="button" size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
              <Icon icon="ph:arrow-clockwise-bold" size={13} /> Replace
            </Button>
            <Button type="button" size="sm" variant="destructive" onClick={onClear}>
              <Icon icon="ph:trash-fill" size={13} /> Remove
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`cover-pick empty${drag ? " drag" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onPick(e.dataTransfer.files?.[0] ?? null);
          }}
        >
          <Icon icon="ph:image-square-fill" size={26} />
          <span className="cover-pick-title">Add a cover image</span>
          <span className="cover-pick-hint">Click or drop · PNG, JPG, WebP · up to 8 MB</span>
        </button>
      )}
    </div>
  );
}

function Review({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile" style={{ padding: "12px 14px" }}>
      <div className="stat-label">{label}</div>
      <div className="text-sm font-semibold" style={{ marginTop: 3, wordBreak: "break-word" }}>
        {value}
      </div>
    </div>
  );
}

// A single read-only suggestion + a "Use" button. The button fills the matching
// field ONLY when that field is still empty/default (no-clobber) — when the user
// has already filled it, the button shows "In use elsewhere" and is disabled.
function SuggestionRow({
  label,
  value,
  fillable,
  onUse,
}: {
  label: string;
  value: string;
  fillable: boolean;
  onUse: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between gap-2"
      style={{
        padding: "6px 10px",
        borderRadius: 9,
        border: "1px solid var(--hair)",
        background: "var(--raise)",
      }}
    >
      <div className="text-sm" style={{ minWidth: 0 }}>
        <span className="mono" style={{ color: "var(--fg3)" }}>
          {label}
        </span>{" "}
        <span className="font-semibold" style={{ color: "var(--fg1)", wordBreak: "break-word" }}>
          {value}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onUse}
            disabled={!fillable}
            style={{ flexShrink: 0 }}
          >
            {fillable ? (
              <>
                <Icon icon="ph:arrow-down-left-bold" size={12} /> Use
              </>
            ) : (
              "Set"
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {fillable ? `Use this ${label.toLowerCase()}` : "You've already set this field"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// Non-intrusive, dismissible banner surfacing READ-ONLY suggestions derived from
// the organizer's past events. Each per-field "Use" fills an EMPTY field only —
// it never overwrites something the user has already typed.
function SuggestionBanner({
  prefs,
  currentCategory,
  defaultCategoryId,
  city,
  venue,
  basePrice,
  maxTickets,
  isFree,
  onUseCategory,
  onUseCity,
  onUseVenue,
  onUsePrice,
  onUseCapacity,
  onDismiss,
}: {
  prefs: CreatePrefs;
  currentCategory: string;
  defaultCategoryId: string;
  city: string;
  venue: string;
  basePrice: string;
  maxTickets: string;
  isFree: boolean;
  onUseCategory: (v: string) => void;
  onUseCity: (v: string) => void;
  onUseVenue: (v: string) => void;
  onUsePrice: (v: string) => void;
  onUseCapacity: (v: string) => void;
  onDismiss: () => void;
}) {
  // Fillability mirrors the no-clobber rules in the appliers above.
  const categoryFillable = currentCategory === defaultCategoryId;
  const cityFillable = !city.trim();
  const venueFillable = !venue.trim();
  const priceFillable = !isFree && !basePrice.trim();
  const capacityFillable = maxTickets === "100";

  return (
    <Card
      className="screen-in"
      style={{
        padding: 16,
        background: "rgba(0,124,250,.06)",
        borderColor: "rgba(0,124,250,.4)",
      }}
    >
      <div className="flex items-start gap-2">
        <Icon icon="ph:sparkle-fill" size={18} style={{ color: "var(--hi-blue)", flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="text-sm font-semibold" style={{ color: "var(--fg1)" }}>
            From your past events
          </div>
          <p className="text-xs" style={{ color: "var(--fg2)", marginTop: 3 }}>
            Suggestions from your private organizer memory. Tap{" "}
            <span className="font-semibold">Use</span> to fill an empty field — we never overwrite
            anything you&apos;ve already typed.
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onDismiss}
              aria-label="Dismiss suggestions"
              style={{ flexShrink: 0 }}
            >
              <Icon icon="ph:x-bold" size={13} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Dismiss</TooltipContent>
        </Tooltip>
      </div>

      <div className="space-y-2" style={{ marginTop: 12 }}>
        {prefs.category && (
          <SuggestionRow
            label="Category"
            value={prefs.category}
            fillable={categoryFillable}
            onUse={() => onUseCategory(prefs.category as string)}
          />
        )}
        {prefs.city && (
          <SuggestionRow
            label="City"
            value={prefs.city}
            fillable={cityFillable}
            onUse={() => onUseCity(prefs.city as string)}
          />
        )}
        {prefs.venue && (
          <SuggestionRow
            label="Venue"
            value={prefs.venue}
            fillable={venueFillable}
            onUse={() => onUseVenue(prefs.venue as string)}
          />
        )}
        {prefs.price && (
          <SuggestionRow
            label="Price"
            value={prefs.price}
            fillable={priceFillable}
            onUse={() => onUsePrice(prefs.price as string)}
          />
        )}
        {prefs.capacity && (
          <SuggestionRow
            label="Capacity"
            value={prefs.capacity}
            fillable={capacityFillable}
            onUse={() => onUseCapacity(prefs.capacity as string)}
          />
        )}
      </div>
    </Card>
  );
}
