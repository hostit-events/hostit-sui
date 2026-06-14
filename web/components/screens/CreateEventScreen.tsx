"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { DAY_MS, ENOKI_ENABLED, COINS, coinInfo, EVENT_TYPE, ORGANIZER_CAP_TYPE } from "@/lib/config";
import { createEventTx, setPriceTx } from "@/lib/ticketing";
import { humanizeError } from "@/lib/moveErrors";
import { putEventMetadata, type EventMetadata, type Tier } from "@/lib/metadata";
import { storeFile } from "@/lib/walrus";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
} from "@/lib/hooks";
import { CATEGORIES, catPalette, catGlyph } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { useOrganizerMemory } from "@/lib/memoryClient";
import {
  CREATE_MEMORY_QUERY,
  buildCreateSummary,
  mergeCreatePrefs,
  hasAnyPref,
  type CreatePrefs,
} from "@/lib/createMemory";

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

export function CreateEventScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const client = useCurrentClient();
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const txPending = regular.isPending || sponsored.isPending;

  const [step, setStep] = useState(0);

  // ── Step 1: Details ──
  const [name, setName] = useState("");
  const [category, setCategory] = useState(PICKABLE[0].id);
  const [tag, setTag] = useState("");
  const [start, setStart] = useState(() => isoLocal(25 * 60)); // now + 25h
  const [end, setEnd] = useState(() => isoLocal(50 * 60)); // now + 50h
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [description, setDescription] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const coverPreview = useMemo(
    () => (coverFile ? URL.createObjectURL(coverFile) : null),
    [coverFile],
  );

  // ── Step 2: Tickets ──
  const [basePrice, setBasePrice] = useState("");
  const [coinType, setCoinType] = useState(COINS[0].type);
  const [maxTickets, setMaxTickets] = useState("100");
  const [maxPerUser, setMaxPerUser] = useState("5");
  const [tiers, setTiers] = useState<ExtraTier[]>([]);

  // ── Step 3: Promote ──
  const [poap, setPoap] = useState(true);
  const [refundable, setRefundable] = useState(false);
  const [isFree, setIsFree] = useState(false);
  const [web3, setWeb3] = useState(category === "web3");

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
  const { enabled: memoryEnabled, recall, remember } = useOrganizerMemory();
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
  // Default sale opens now; on-chain `purchase_start_ms`.
  const purchaseStartMs = Date.now();

  function validateTimes(): string | null {
    if (![startMs, endMs].every(Number.isFinite)) return "Dates must be valid.";
    if (startMs <= Date.now()) return "Start must be in the future.";
    if (endMs < startMs + DAY_MS) return "End must be at least 1 day after start.";
    if (purchaseStartMs + DAY_MS > startMs)
      return "Sale must open at least 1 day before the event starts.";
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

      // 4) CREATE-PRICE-DROPPED fix: pricing is a separate cap-gated call (the
      // Event is shared on creation), so the Step-2 price must be applied with a
      // follow-up `set_price`. The sponsored path returns only { digest }, so we
      // resolve the new Event id + OrganizerCap id authoritatively from the chain
      // by reading the create tx's object changes (works for both paths).
      const wantsPrice = !isFree && basePrice.trim() !== "" && Number(basePrice) > 0;
      const ids = await resolveCreatedIds(out.digest).catch(() => null);
      if (ids?.eventId) setCreatedEventId(ids.eventId);

      if (wantsPrice) {
        const dec = coinInfo(coinType).decimals;
        const priceUnits = BigInt(Math.round(Number(basePrice) * 10 ** dec));
        if (ids?.eventId && ids?.capId && priceUnits > 0n) {
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
      setErr(humanizeError(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Resolve the new Event (shared) + OrganizerCap (owned) object ids from a
   * create-event tx by reading its on-chain object changes. Uses
   * `waitForTransaction` so it works even if the create result carried no
   * effects (e.g. the sponsored path, which returns only a digest).
   */
  async function resolveCreatedIds(
    txDigest: string,
  ): Promise<{ eventId: string | null; capId: string | null }> {
    const rpc = client as unknown as {
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
    const eventId =
      created.find((c) => c.objectType === EVENT_TYPE)?.objectId ?? null;
    const capId =
      created.find((c) => c.objectType === ORGANIZER_CAP_TYPE)?.objectId ?? null;
    return { eventId, capId };
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
        <div className="card text-center" style={{ padding: 36 }}>
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
            <div
              className="card"
              style={{
                marginTop: 18,
                textAlign: "left",
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
            </div>
          )}
          {!isFree && priceSet !== true && (
            <div
              className="card"
              style={{
                marginTop: 18,
                textAlign: "left",
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
              <Link
                href={createdEventId ? `/manage/${createdEventId}` : "/dashboard"}
                className="btn btn-primary"
                style={{ marginTop: 10 }}
              >
                <Icon icon="ph:tag-fill" size={16} /> Set your ticket price
              </Link>
            </div>
          )}
          <div className="flex gap-2 justify-center" style={{ marginTop: 22, flexWrap: "wrap" }}>
            <Link href="/dashboard" className="btn btn-primary btn-lg">
              <Icon icon="material-symbols-light:analytics-rounded" size={18} /> Go to dashboard
            </Link>
            <button
              className="btn"
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
            </button>
          </div>
        </div>
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
          <button
            key={s.id}
            className={`chip ${step === s.id ? "on" : ""}`}
            onClick={() => {
              if (s.id <= step) return setStep(s.id);
              const e = stepError(step);
              if (e) return setErr(e);
              setErr(null);
              setStep(s.id);
            }}
          >
            <Icon icon={step > s.id ? "ph:check-bold" : s.icon} size={14} /> {s.id + 1}. {s.label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* ── form column ── */}
        <div className="card space-y-5">
          {step === 0 && (
            <div className="space-y-4">
              <span className="section-label">Step 1 — Details</span>
              <div>
                <label className="label" htmlFor="ce-event-name">Event name</label>
                <input
                  id="ce-event-name"
                  className="input"
                  placeholder="e.g. Sui Builders Night"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div role="group" aria-label="Category">
                <div className="label" aria-hidden="true">Category</div>
                <div className="flex gap-2 flex-wrap">
                  {PICKABLE.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`chip ${category === c.id ? "on" : ""}`}
                      onClick={() => {
                        setCategory(c.id);
                        if (c.id === "web3") setWeb3(true);
                      }}
                    >
                      <Icon icon={c.icon} size={14} /> {c.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="ce-start">Event starts</label>
                  <input
                    id="ce-start"
                    className="input"
                    type="datetime-local"
                    min={isoLocal()}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ce-end">Event ends</label>
                  <input
                    id="ce-end"
                    className="input"
                    type="datetime-local"
                    min={start}
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </div>
              </div>
              {dateError && (
                <p className="text-xs" style={{ color: "var(--color-danger)" }}>
                  <Icon icon="ph:warning-circle-fill" size={12} /> {dateError}
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label" htmlFor="ce-venue">Venue</label>
                  <input
                    id="ce-venue"
                    className="input"
                    placeholder="e.g. The Glasshouse"
                    value={venue}
                    onChange={(e) => setVenue(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ce-city">City</label>
                  <input
                    id="ce-city"
                    className="input"
                    placeholder="e.g. Lisbon"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="label" htmlFor="ce-tag">Tag (optional)</label>
                <input
                  id="ce-tag"
                  className="input"
                  placeholder="e.g. Conference, Festival, Meetup"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                />
              </div>

              <div>
                <label className="label" htmlFor="ce-description">Description</label>
                <textarea
                  id="ce-description"
                  className="textarea"
                  placeholder="What is this event about? Who is it for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="label" htmlFor="ce-cover">Cover image (stored on Walrus on publish)</label>
                <input
                  id="ce-cover"
                  className="input"
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={isFree}
                  aria-label="Free event"
                  className={`switch ${isFree ? "on" : ""}`}
                  onClick={() => setIsFree((v) => !v)}
                />
              </div>

              {!isFree && (
                <div className="grid sm:grid-cols-[1fr_140px] gap-3">
                  <div>
                    <label className="label" htmlFor="ce-base-price">Base price</label>
                    <input
                      id="ce-base-price"
                      className="input"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="0.00"
                      value={basePrice}
                      onChange={(e) => setBasePrice(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label" htmlFor="ce-coin">Coin</label>
                    <select
                      id="ce-coin"
                      className="select"
                      value={coinType}
                      onChange={(e) => setCoinType(e.target.value)}
                    >
                      {COINS.map((c) => (
                        <option key={c.type} value={c.type}>
                          {c.symbol}
                        </option>
                      ))}
                    </select>
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
                <div>
                  <label className="label" htmlFor="ce-max-tickets">Max tickets</label>
                  <input
                    id="ce-max-tickets"
                    className="input"
                    type="number"
                    min={1}
                    step="1"
                    value={maxTickets}
                    onChange={(e) => setMaxTickets(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ce-max-per-user">Max per attendee</label>
                  <input
                    id="ce-max-per-user"
                    className="input"
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
                  <div className="label" style={{ margin: 0 }}>
                    Additional tiers (optional)
                  </div>
                  <button type="button" className="btn btn-sm" onClick={addTier}>
                    <Icon icon="ph:plus-bold" size={13} /> Add tier
                  </button>
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
                        <input
                          id={`ce-tier-name-${i}`}
                          aria-label="Tier name"
                          className="input"
                          placeholder="Tier name (e.g. VIP)"
                          value={t.name}
                          onChange={(e) => updateTier(i, { name: e.target.value })}
                        />
                        <input
                          id={`ce-tier-price-${i}`}
                          aria-label="Tier price"
                          className="input"
                          type="number"
                          min={0}
                          step="any"
                          placeholder="Price"
                          value={t.price}
                          onChange={(e) => updateTier(i, { price: e.target.value })}
                        />
                        <input
                          id={`ce-tier-note-${i}`}
                          aria-label="Tier note"
                          className="input"
                          placeholder="Note (optional)"
                          value={t.note}
                          onChange={(e) => updateTier(i, { note: e.target.value })}
                        />
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => removeTier(i)}
                          title="Remove tier"
                          aria-label="Remove tier"
                        >
                          <Icon icon="ph:trash-fill" size={14} />
                        </button>
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

              <div
                className="card"
                style={{ background: "rgba(0,124,250,.06)", borderColor: "rgba(0,124,250,.4)" }}
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
              </div>

              <label className="flex items-start gap-3" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  style={{ marginTop: 3, accentColor: "var(--hi-blue)", width: 16, height: 16 }}
                />
                <span className="text-sm" style={{ color: "var(--fg2)" }}>
                  I confirm the details are accurate and accept that I become the organizer of this
                  event on Sui.
                </span>
              </label>

              {/* EXPLICIT opt-in memory write (GH#19). Default UNCHECKED. Only
                  shown when memory is on (wallet connected + server layer live). */}
              {memoryEnabled && (
                <label
                  className="flex items-start gap-3 card"
                  style={{ cursor: "pointer", padding: 14, background: "rgba(0,124,250,.04)" }}
                >
                  <input
                    type="checkbox"
                    checked={rememberOnPublish}
                    onChange={(e) => setRememberOnPublish(e.target.checked)}
                    style={{ marginTop: 3, accentColor: "var(--hi-blue)", width: 16, height: 16 }}
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
            <button className="btn" onClick={back} disabled={step === 0 || !!busy}>
              <Icon icon="ph:arrow-left-bold" size={14} /> Back
            </button>
            {step < 3 ? (
              <button className="btn btn-primary" onClick={next}>
                Next <Icon icon="ph:arrow-right-bold" size={14} />
              </button>
            ) : !addr ? (
              <span className="badge badge-line">Connect a wallet to publish</span>
            ) : (
              <button
                className="btn btn-primary btn-lg"
                onClick={publish}
                disabled={!agreed || !!busy || txPending}
              >
                <Icon icon="mdi:rocket-launch" size={18} />
                {busy || txPending ? "Publishing…" : "Publish event"}
              </button>
            )}
          </div>
        </div>

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
                {isFree && <span className="badge badge-green">Free</span>}
                {web3 && (
                  <span className="badge" style={{ background: "rgba(0,0,0,.4)", color: "#fff" }}>
                    Web3
                  </span>
                )}
                {tag.trim() && (
                  <span className="badge" style={{ background: "rgba(0,0,0,.4)", color: "#fff" }}>
                    {tag.trim()}
                  </span>
                )}
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
                  <span className="badge badge-green">Claim free</span>
                ) : basePrice.trim() ? (
                  <span className="badge badge-blue">
                    {basePrice} {ci.symbol}
                  </span>
                ) : (
                  <span className="badge badge-line">Price not set</span>
                )}
                {poap && (
                  <span className="badge badge-magenta">
                    <Icon icon="ph:seal-check-fill" size={11} /> POAP
                  </span>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs" style={{ color: "var(--fg3)" }}>
            This is roughly how your event appears in Discover.
          </p>
        </aside>
      </div>
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
    <div className="flex items-center justify-between gap-3 card" style={{ padding: 16 }}>
      <div className="flex items-start gap-3">
        <Icon icon={icon} size={20} style={{ color: on ? "var(--hi-blue)" : "var(--fg3)" }} />
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-xs" style={{ color: "var(--fg3)" }}>
            {desc}
          </div>
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        className={`switch ${on ? "on" : ""}`}
        onClick={() => set(!on)}
      />
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
      <button
        type="button"
        className="btn btn-sm"
        onClick={onUse}
        disabled={!fillable}
        title={fillable ? `Use this ${label.toLowerCase()}` : "You've already set this field"}
        style={{ flexShrink: 0, opacity: fillable ? 1 : 0.5 }}
      >
        {fillable ? (
          <>
            <Icon icon="ph:arrow-down-left-bold" size={12} /> Use
          </>
        ) : (
          "Set"
        )}
      </button>
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
    <div
      className="card screen-in"
      style={{
        background: "rgba(0,124,250,.06)",
        borderColor: "rgba(0,124,250,.4)",
        padding: 16,
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
        <button
          type="button"
          className="btn btn-sm"
          onClick={onDismiss}
          aria-label="Dismiss suggestions"
          title="Dismiss"
          style={{ flexShrink: 0 }}
        >
          <Icon icon="ph:x-bold" size={13} />
        </button>
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
    </div>
  );
}
