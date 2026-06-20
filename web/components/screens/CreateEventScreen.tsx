"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ENOKI_ENABLED, COINS, coinInfo, toUnits, EVENT_TYPE, ORGANIZER_CAP_TYPE } from "@/lib/config";
import { createEventTx, setPriceTx } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import { minimalEventMetadata, putEventMetadata, type EventMetadata, type Tier } from "@/lib/metadata";
import { storeFile } from "@/lib/walrus";
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
import { CATEGORIES, catPalette, catGlyph } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { AnimateIcon } from "@/components/animate-ui/icons/icon";
import { ArrowRight } from "@/components/animate-ui/icons/arrow-right";
import { DateTimePicker } from "@/components/DateTimePicker";
import { TxLink } from "@/components/TxLink";
import { useOrganizerMemory } from "@/lib/memoryClient";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
function isoLocal(addMinutes = 0): string {
  const d = new Date(Date.now() + addMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
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

type CreateMode = "quick" | "advanced";

/**
 * Top-level create screen. Offers a Quick (default) and an Advanced mode.
 * - Quick   = a single compact form (instant create): name, category, times,
 *             capacity, Free-or-price. `max_per_user = 1`, no tiers, no cover.
 * - Advanced = the full 4-step wizard, preserved exactly (`AdvancedCreate`).
 * Switching modes while the active form is dirty asks for confirmation first so
 * input is never silently dropped.
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

  const [mode, setMode] = useState<CreateMode>("quick");
  // Per-mode dirtiness, reported up from each child form.
  const [quickDirty, setQuickDirty] = useState(false);
  const [advancedDirty, setAdvancedDirty] = useState(false);
  // When non-null, a confirm dialog is open offering to switch to this mode.
  const [pendingMode, setPendingMode] = useState<CreateMode | null>(null);
  // Bumping a form's key remounts it (a true reset) when the user confirms a
  // discard — so "Switch & discard" actually drops the in-progress input.
  const [quickKey, setQuickKey] = useState(0);
  const [advancedKey, setAdvancedKey] = useState(0);

  // ── Resume from a saved draft (?draft=<id>, GH#46) ──────────────────────────
  // One-time: decrypt the Seal+Walrus draft, switch to its mode, and rehydrate
  // the matching sub-component via `initial` + a fresh mount key. On error we
  // toast and fall through to an empty form (the URL param is otherwise ignored).
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
        setMode(draft.mode);
        setDraftInitial(draft.form);
        setResumedId(resumeId);
        // Remount the target form so its useState initializers read `initial`.
        if (draft.mode === "quick") setQuickKey((k) => k + 1);
        else setAdvancedKey((k) => k + 1);
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

  // Hand `initial` to a sub-component ONLY when its mode matches the loaded draft,
  // so switching modes after a resume starts the other form empty.
  const quickInitial = mode === "quick" && draftInitial ? draftInitial : undefined;
  const advancedInitial = mode === "advanced" && draftInitial ? draftInitial : undefined;
  const quickDraftId = mode === "quick" ? resumedId ?? undefined : undefined;
  const advancedDraftId = mode === "advanced" ? resumedId ?? undefined : undefined;

  const currentDirty = mode === "quick" ? quickDirty : advancedDirty;

  function requestMode(next: CreateMode) {
    if (next === mode) return;
    if (currentDirty) {
      setPendingMode(next);
      return;
    }
    setMode(next);
  }
  function confirmSwitch() {
    if (!pendingMode) return;
    // Reset the form we're leaving so the discard is real, then switch.
    if (mode === "quick") setQuickKey((k) => k + 1);
    else setAdvancedKey((k) => k + 1);
    setMode(pendingMode);
    setPendingMode(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Tabs value={mode} onValueChange={(v) => requestMode(v as CreateMode)}>
          <TabsList>
            <TabsTrigger value="quick">
              <Icon icon="ph:lightning-fill" size={14} /> Quick
            </TabsTrigger>
            <TabsTrigger value="advanced">
              <Icon icon="ph:sliders-horizontal-fill" size={14} /> Advanced
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {loadingDraft && (
        <div className="mono flex justify-center" style={{ color: "var(--hi-blue)" }}>
          <Icon icon="svg-spinners:3-dots-fade" size={16} /> Loading draft…
        </div>
      )}

      {/* Both forms are kept mounted (hidden, not unmounted) so a half-filled
          form survives a glance at the other mode once the user confirms. */}
      <div hidden={mode !== "quick"}>
        <QuickCreate
          key={quickKey}
          onDirtyChange={setQuickDirty}
          initial={quickInitial}
          draftId={quickDraftId}
        />
      </div>
      <div hidden={mode !== "advanced"}>
        <AdvancedCreate
          key={advancedKey}
          onDirtyChange={setAdvancedDirty}
          initial={advancedInitial}
          draftId={advancedDraftId}
        />
      </div>

      <Dialog open={pendingMode !== null} onOpenChange={(o) => !o && setPendingMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              You&apos;ve started filling out the{" "}
              <strong>{mode === "quick" ? "Quick" : "Advanced"}</strong> form. Switching to{" "}
              <strong>{pendingMode === "quick" ? "Quick" : "Advanced"}</strong> won&apos;t carry
              those details over.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingMode(null)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={confirmSwitch}>
              Switch &amp; discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

  // Id of the draft this form represents. Set when resuming, and overwritten with
  // the entry id returned by each "Save as draft" so re-saves REPLACE (no dupes).
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const [savingDraft, setSavingDraft] = useState(false);

  const [step, setStep] = useState(0);

  // ── Step 1: Details ──
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? PICKABLE[0].id);
  const [tag, setTag] = useState(initial?.tag ?? "");
  const [start, setStart] = useState(() => initial?.start ?? isoLocal(25 * 60)); // now + 25h
  const [end, setEnd] = useState(() => initial?.end ?? isoLocal(50 * 60)); // now + 50h
  const [venue, setVenue] = useState(initial?.venue ?? "");
  const [city, setCity] = useState(initial?.city ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const coverPreview = useMemo(
    () => (coverFile ? URL.createObjectURL(coverFile) : null),
    [coverFile],
  );

  // ── Step 2: Tickets ──
  const [basePrice, setBasePrice] = useState(initial?.basePrice ?? "");
  const [coinType, setCoinType] = useState(initial?.coinType ?? COINS[0].type);
  const [maxTickets, setMaxTickets] = useState(initial?.maxTickets ?? "100");
  const [maxPerUser, setMaxPerUser] = useState(initial?.maxPerUser ?? "5");
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
  // Set on success once we resolve the new Event id from the create tx — powers
  // the "Set your ticket price" deep-link so paid pricing is never silently lost.
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  // True once the follow-up set_price call landed automatically; null = not
  // attempted (free event / no price), false = attempted but couldn't complete.
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
    maxPerUser !== "5";
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

  async function publish() {
    if (!addr) return setErr("Connect a wallet to publish.");
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

      // 3) Create the event on-chain (uri = metadata blobId).
      setBusy("Creating event on Sui…");
      const tx = createEventTx(
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
        },
        addr,
      );
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      // Event is live regardless of what happens with pricing below.
      setDigest(out.digest);
      toast.success("Your event is live", {
        description: <TxLink digest={out.digest} chars={10} />,
      });

      // The draft is now a real event — drop it from the index (GH#46).
      if (draftId && addr) {
        deleteDraft(addr, draftId);
        setDraftId(null);
      }

      // 4) CREATE-PRICE-DROPPED fix: pricing is a separate cap-gated call (the
      // Event is shared on creation), so the Step-2 price must be applied with a
      // follow-up `set_price`. The sponsored path returns only { digest }, so we
      // resolve the new Event id + OrganizerCap id authoritatively from the chain
      // by reading the create tx's object changes (works for both paths).
      const wantsPrice = !isFree && basePrice.trim() !== "" && Number(basePrice) > 0;
      const ids = await resolveCreatedIds(client, out.digest).catch(() => null);
      if (ids?.eventId) setCreatedEventId(ids.eventId);

      if (wantsPrice) {
        const dec = coinInfo(coinType).decimals;
        const priceUnits = toUnits(basePrice, dec);
        if (ids?.eventId && ids?.capId && priceUnits && priceUnits > 0n) {
          try {
            setBusy("Setting price…");
            const priceTx = setPriceTx({
              capId: ids.capId,
              eventId: ids.eventId,
              coinType,
              price: priceUnits,
            });
            // set_price is on the sponsor allowlist (mirrors create_event).
            if (ENOKI_ENABLED) {
              await sponsored.mutateAsync({ transaction: priceTx, sender: addr });
            } else {
              await regular.mutateAsync({ transaction: priceTx });
            }
            setPriceSet(true);
          } catch {
            // Don't surface as a publish error — the event is already live.
            // The success screen's "Set your ticket price" CTA recovers it.
            setPriceSet(false);
          }
        } else {
          // Couldn't derive ids (or no resolvable price) — fall back to the CTA.
          setPriceSet(false);
        }
      }

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
          {!isFree && priceSet !== true && (
            <Card
              style={{
                marginTop: 18,
                textAlign: "left",
                padding: 16,
                background: "rgba(245,166,35,.08)",
                borderColor: "var(--hi-amber)",
              }}
            >
              <div className="flex items-center gap-2" style={{ color: "var(--hi-amber)" }}>
                <Icon icon="ph:warning-fill" size={16} />
                <span className="text-sm font-semibold">Set your ticket price</span>
              </div>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
                The Event is shared on creation, so pricing is a separate cap-gated call. Set your
                price{basePrice.trim() ? ` (${basePrice} ${ci.symbol})` : ""} before the sale opens —
                buyers can&apos;t purchase until a price is set.
              </p>
              <Button asChild style={{ marginTop: 10 }}>
                <Link href={createdEventId ? `/manage/${createdEventId}` : "/dashboard"}>
                  <Icon icon="ph:tag-fill" size={16} /> Set your ticket price
                </Link>
              </Button>
            </Card>
          )}
          <div className="flex gap-2 justify-center" style={{ marginTop: 22, flexWrap: "wrap" }}>
            <Button asChild size="lg">
              <Link href="/dashboard">
                <Icon icon="material-symbols-light:analytics-rounded" size={18} /> Go to dashboard
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
          style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -40, opacity: 0.2 }}
        />
        <span className="eyebrow">
          <Icon icon="mdi:rocket-launch" size={14} /> Host
        </span>
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 32 }}>
          Create an event
        </h1>
        <p className="page-sub">
          Permissionless — the wallet that signs becomes the organizer. Images and metadata are
          stored on Walrus.
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
              <span className="section-label">Step 1 — Details</span>
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
                  <DateTimePicker id="ce-start" value={start} min={isoLocal()} onChange={setStart} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ce-end">Event ends</Label>
                  <DateTimePicker id="ce-end" value={end} min={start} onChange={setEnd} />
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
                <Label htmlFor="ce-cover">Cover image (stored on Walrus on publish)</Label>
                <Input
                  id="ce-cover"
                  type="file"
                  accept="image/*"
                  onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
                />
                {coverFile && (
                  <div className="mono" style={{ marginTop: 6 }}>
                    <Icon icon="ph:image-fill" size={13} /> {coverFile.name}
                  </div>
                )}
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

        {/* ── live preview column ── */}
        <aside className="space-y-3" style={{ position: "sticky", top: 20 }}>
          <span className="section-label">Live preview</span>
          <div className="ev-card">
            <div
              className="poster"
              style={
                { height: 150, ["--p1" as string]: p1, ["--p2" as string]: p2 } as React.CSSProperties
              }
            >
              {coverPreview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={coverPreview}
                  alt={name || "cover"}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              )}
              <div className="poster-noise" />
              <span className="poster-glyph">
                <Icon icon={catGlyph(category)} size={64} />
              </span>
              <div className="absolute flex gap-1.5" style={{ top: 12, left: 12, flexWrap: "wrap" }}>
                {isFree && <Badge variant="secondary">Free</Badge>}
                {web3 && <Badge variant="secondary">Web3</Badge>}
                {tag.trim() && <Badge variant="secondary">{tag.trim()}</Badge>}
              </div>
            </div>
            <div className="ev-body">
              <div className="ev-title" style={{ color: "var(--fg1)" }}>
                {name.trim() || "Your event name"}
              </div>
              <div
                className="flex items-center gap-1.5 text-[13px]"
                style={{ color: "var(--fg3)" }}
              >
                <Icon icon="carbon:location" size={14} /> <span>{venueLabel}</span>
              </div>
              <div
                className="flex items-center gap-1.5 text-[13px]"
                style={{ color: "var(--fg3)" }}
              >
                <Icon icon="proicons:calendar" size={14} /> <span>{dateLabel}</span>
              </div>
              <div className="ev-foot" style={{ flexWrap: "wrap" }}>
                {isFree ? (
                  <Badge variant="secondary">Claim free</Badge>
                ) : basePrice.trim() ? (
                  <Badge variant="secondary">
                    {basePrice} {ci.symbol}
                  </Badge>
                ) : (
                  <Badge variant="outline">Price not set</Badge>
                )}
                {poap && (
                  <Badge variant="secondary">
                    <Icon icon="ph:seal-check-fill" size={11} /> POAP
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs" style={{ color: "var(--fg3)" }}>
            This is roughly how your event appears in Discover.
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
    </div>
  );
}

// ── Quick (instant) create ────────────────────────────────────────────────────
// A single compact form. Hardcodes max_per_user = 1, no tiers, no cover. Stores a
// minimal sentinel metadata blob ({ v:1, category }) on Walrus, creates the event
// (uri = blobId), then — if paid — applies the price via the same cap-gated
// two-tx flow as the wizard (CREATE-PRICE-DROPPED safe). Rich metadata (cover,
// description, tiers) is added later from the manage screen.
const QUICK_DEFAULT_DURATION_MIN = 3 * 60; // default end = start + 3h

function QuickCreate({
  onDirtyChange,
  initial,
  draftId: initialDraftId,
}: {
  onDirtyChange?: (dirty: boolean) => void;
  // Rehydration source when resuming a saved draft (GH#46).
  initial?: Partial<EventDraftForm>;
  draftId?: string;
}) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const client = useCurrentClient();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const txPending = regular.isPending || sponsored.isPending;

  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? PICKABLE[0].id);
  const [start, setStart] = useState(() => initial?.start ?? isoLocal()); // now
  const [end, setEnd] = useState(
    () => initial?.end ?? isoLocal(QUICK_DEFAULT_DURATION_MIN),
  ); // now + 3h
  const [maxTickets, setMaxTickets] = useState(initial?.maxTickets ?? "100");
  const [isFree, setIsFree] = useState(initial?.isFree ?? false);
  const [basePrice, setBasePrice] = useState(initial?.basePrice ?? "");
  const [coinType, setCoinType] = useState(initial?.coinType ?? COINS[0].type);

  // Draft id for save/replace (GH#46): set on resume, refreshed on each save.
  const [draftId, setDraftId] = useState<string | null>(initialDraftId ?? null);
  const [savingDraft, setSavingDraft] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [digest, setDigest] = useState<string | null>(null);
  const [createdEventId, setCreatedEventId] = useState<string | null>(null);
  const [priceSet, setPriceSet] = useState<boolean | null>(null);
  // Walrus upload cache so a create retry doesn't re-upload an identical blob.
  const [metaCache, setMetaCache] = useState<{ key: string; blobId: string } | null>(null);

  const [p1, p2] = catPalette(category);
  const ci = coinInfo(coinType);

  const quickDirty =
    Boolean(digest) ||
    name.trim() !== "" ||
    basePrice.trim() !== "" ||
    maxTickets !== "100" ||
    category !== PICKABLE[0].id ||
    isFree !== false ||
    coinType !== COINS[0].type;
  useEffect(() => {
    onDirtyChange?.(quickDirty);
  }, [quickDirty, onDirtyChange]);

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);

  // Time validation matching the NEW Move contract:
  //   start_ms >= now, end_ms > start_ms, purchase_start_ms = now (sales open now).
  function validateTimes(): string | null {
    if (![startMs, endMs].every(Number.isFinite)) return "Dates must be valid.";
    // Small slack so "now" set a moment ago isn't rejected as past by the time
    // the tx lands (the contract checks start_ms >= now at execution).
    if (startMs < Date.now() - 60_000) return "Start can't be in the past.";
    if (endMs <= startMs) return "End must be after start.";
    return null;
  }

  function validate(): string | null {
    if (!name.trim()) return "Event name is required.";
    const t = validateTimes();
    if (t) return t;
    const maxT = Number(maxTickets);
    if (!Number.isInteger(maxT) || maxT <= 0)
      return "Capacity must be a whole number greater than 0.";
    if (maxT > MAX_TICKET_LIMIT)
      return `Capacity can't exceed ${MAX_TICKET_LIMIT.toLocaleString()}.`;
    if (!isFree) {
      if (!basePrice.trim()) return "Set a price, or mark the event as free.";
      const price = Number(basePrice);
      if (!Number.isFinite(price) || price <= 0)
        return "Price must be a number greater than 0.";
    }
    return null;
  }

  const dateError = validateTimes();
  const formError = validate();

  async function publish() {
    if (!addr) return setErr("Connect a wallet to publish.");
    const e = validate();
    if (e) return setErr(e);

    setErr(null);
    setDigest(null);
    setCreatedEventId(null);
    setPriceSet(null);
    // Sales open immediately; clamp to start so on-chain purchase_start_ms <= start_ms.
    const purchaseStartMs = Math.min(Date.now(), startMs);
    try {
      // 1) Minimal sentinel metadata → Walrus (tiny, fast). Reuse on retry.
      const metadata = minimalEventMetadata(category);
      const metaKey = JSON.stringify(metadata);
      let blobId: string;
      if (metaCache && metaCache.key === metaKey) {
        blobId = metaCache.blobId;
      } else {
        setBusy("Storing event metadata on Walrus…");
        blobId = await putEventMetadata(metadata);
        setMetaCache({ key: metaKey, blobId });
      }

      // 2) Create the event on-chain (uri = metadata blobId, max_per_user = 1).
      setBusy("Creating event on Sui…");
      const tx = createEventTx(
        {
          name: name.trim(),
          symbol: category.slice(0, 4).toUpperCase(),
          uri: blobId,
          startMs: BigInt(startMs),
          endMs: BigInt(endMs),
          purchaseStartMs: BigInt(purchaseStartMs),
          maxTickets: BigInt(Math.trunc(Number(maxTickets))),
          maxPerUser: 1n,
          isFree,
          isRefundable: false,
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

      // 3) CREATE-PRICE-DROPPED: pricing is a separate cap-gated call. Resolve the
      // new Event + OrganizerCap ids from the create tx, then apply set_price.
      const wantsPrice = !isFree && basePrice.trim() !== "" && Number(basePrice) > 0;
      const ids = await resolveCreatedIds(client, out.digest).catch(() => null);
      if (ids?.eventId) setCreatedEventId(ids.eventId);

      if (wantsPrice) {
        const dec = coinInfo(coinType).decimals;
        const priceUnits = toUnits(basePrice, dec);
        if (ids?.eventId && ids?.capId && priceUnits && priceUnits > 0n) {
          try {
            setBusy("Setting price…");
            const priceTx = setPriceTx({
              capId: ids.capId,
              eventId: ids.eventId,
              coinType,
              price: priceUnits,
            });
            if (ENOKI_ENABLED) {
              await sponsored.mutateAsync({ transaction: priceTx, sender: addr });
            } else {
              await regular.mutateAsync({ transaction: priceTx });
            }
            setPriceSet(true);
          } catch {
            setPriceSet(false);
          }
        } else {
          setPriceSet(false);
        }
      }
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  // ── Save as draft (GH#46) ───────────────────────────────────────────────────
  // Encrypts the Quick form (Seal) and stores it on Walrus via lib/drafts. Quick
  // has no cover, so no upload step; max_per_user is fixed at 1 here as well.
  async function saveAsDraft() {
    if (!addr) return; // guarded by the disabled button — needs addr for Seal + index
    setSavingDraft(true);
    try {
      const form: EventDraftForm = {
        name,
        category,
        start,
        end,
        maxTickets,
        maxPerUser: "1",
        isFree,
        basePrice,
        coinType,
      };
      const draft: EventDraft = {
        v: 1,
        mode: "quick",
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
            <Icon icon="ph:lightning-fill" size={40} style={{ color: "#fff", position: "relative" }} />
          </div>
          <h1 className="page-title" style={{ fontSize: 26 }}>
            Your event is live
          </h1>
          <p className="page-sub">
            <strong style={{ color: "var(--fg1)" }}>{name.trim() || "Your event"}</strong> is now on
            Sui. Add a cover, description and ticket tiers any time from your event&apos;s manage
            page.
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
                Adjust pricing and add more coins from your{" "}
                <Link href="/dashboard" style={{ color: "var(--hi-blue)", fontWeight: 600 }}>
                  dashboard
                </Link>
                .
              </p>
            </Card>
          )}
          {!isFree && priceSet !== true && (
            <Card
              style={{
                marginTop: 18,
                textAlign: "left",
                padding: 16,
                background: "rgba(245,166,35,.08)",
                borderColor: "var(--hi-amber)",
              }}
            >
              <div className="flex items-center gap-2" style={{ color: "var(--hi-amber)" }}>
                <Icon icon="ph:warning-fill" size={16} />
                <span className="text-sm font-semibold">Set your ticket price</span>
              </div>
              <p className="text-sm" style={{ color: "var(--fg2)", marginTop: 6 }}>
                The Event is shared on creation, so pricing is a separate cap-gated call. Set your
                price{basePrice.trim() ? ` (${basePrice} ${ci.symbol})` : ""} before the sale opens —
                buyers can&apos;t purchase until a price is set.
              </p>
              <Button asChild style={{ marginTop: 10 }}>
                <Link href={createdEventId ? `/manage/${createdEventId}` : "/dashboard"}>
                  <Icon icon="ph:tag-fill" size={16} /> Set your ticket price
                </Link>
              </Button>
            </Card>
          )}
          <div className="flex gap-2 justify-center" style={{ marginTop: 22, flexWrap: "wrap" }}>
            <Button asChild size="lg">
              <Link href={createdEventId ? `/manage/${createdEventId}` : "/dashboard"}>
                <Icon icon="ph:pencil-simple-fill" size={18} /> Add details
              </Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDigest(null);
                setCreatedEventId(null);
                setPriceSet(null);
                setName("");
                setBasePrice("");
                setCategory(PICKABLE[0].id);
                setStart(isoLocal());
                setEnd(isoLocal(QUICK_DEFAULT_DURATION_MIN));
                setMaxTickets("100");
                setIsFree(false);
                setCoinType(COINS[0].type);
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
          style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -40, opacity: 0.2 }}
        />
        <span className="eyebrow">
          <Icon icon="ph:lightning-fill" size={14} /> Quick host
        </span>
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 32 }}>
          Create an event
        </h1>
        <p className="page-sub">
          Publish in seconds — sales open immediately. Add a cover, description and tiers later from
          the manage page.
          {ENOKI_ENABLED && <span style={{ color: "var(--color-success)" }}> Gas is sponsored.</span>}
        </p>
      </header>

      <Card className="space-y-5" style={{ padding: 20, maxWidth: 620 }}>
        <div className="space-y-1.5">
          <Label htmlFor="qc-event-name">Event name</Label>
          <Input
            id="qc-event-name"
            placeholder="e.g. Sui Builders Night"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="qc-category">Category</Label>
          <Select value={category} onValueChange={(v) => setCategory(v)}>
            <SelectTrigger id="qc-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PICKABLE.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="qc-start">Event starts</Label>
            <DateTimePicker id="qc-start" value={start} min={isoLocal()} onChange={setStart} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="qc-end">Event ends</Label>
            <DateTimePicker id="qc-end" value={end} min={start} onChange={setEnd} />
          </div>
        </div>
        {dateError && (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
            <Icon icon="ph:warning-circle-fill" size={12} /> {dateError}
          </p>
        )}

        <div className="space-y-1.5" style={{ maxWidth: 220 }}>
          <Label htmlFor="qc-capacity">Capacity</Label>
          <Input
            id="qc-capacity"
            type="number"
            min={1}
            step="1"
            value={maxTickets}
            onChange={(e) => setMaxTickets(e.target.value)}
          />
          <p className="text-xs" style={{ color: "var(--fg3)" }}>
            One ticket per attendee.
          </p>
        </div>

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
              <Label htmlFor="qc-price">Price</Label>
              <Input
                id="qc-price"
                type="number"
                min={0}
                step="any"
                placeholder="0.00"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qc-coin">Coin</Label>
              <Select value={coinType} onValueChange={(v) => setCoinType(v)}>
                <SelectTrigger id="qc-coin" className="w-full">
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
            A 3% platform fee is added on top at checkout. Pricing is applied as a follow-up call
            after creation (the Event is shared on-chain).
          </p>
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

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs" style={{ color: "var(--fg3)" }}>
            {dateLabel}
          </span>
          <div className="flex items-center gap-2">
            {/* Save as draft (GH#46) — needs a wallet for the Seal policy + index. */}
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
            {!addr ? (
              <Badge variant="outline">Connect a wallet to publish</Badge>
            ) : (
              <Button
                size="lg"
                onClick={publish}
                disabled={!!busy || txPending || !!formError}
              >
                <Icon icon="ph:lightning-fill" size={18} />
                {busy || txPending ? "Publishing…" : "Publish event"}
              </Button>
            )}
          </div>
        </div>
      </Card>
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
