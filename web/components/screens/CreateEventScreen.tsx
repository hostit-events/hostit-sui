"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
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

  const [p1, p2] = catPalette(category);
  const ci = coinInfo(coinType);

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
      if (!Number.isFinite(maxT) || maxT <= 0) return "Max tickets must be positive.";
      if (!Number.isFinite(maxU) || maxU <= 0) return "Max per attendee must be positive.";
      if (!isFree && basePrice.trim() && !(Number(basePrice) >= 0))
        return "Base price must be a number.";
    }
    return null;
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
      // 1) Cover image → Walrus (optional)
      let coverBlobId: string | undefined;
      if (coverFile) {
        setBusy("Uploading cover to Walrus…");
        coverBlobId = await storeFile(coverFile);
      }

      // 2) Build + store rich metadata JSON → Walrus → blobId (goes on-chain as uri)
      setBusy("Storing event metadata on Walrus…");
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
      const blobId = await putEventMetadata(metadata);

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
                You can adjust pricing and add more coins any time in{" "}
                <strong style={{ color: "var(--fg1)" }}>My Events</strong>.
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
                <label className="label">Event name</label>
                <input
                  className="input"
                  placeholder="e.g. Sui Builders Night"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <label className="label">Category</label>
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
                  <label className="label">Event starts</label>
                  <input
                    className="input"
                    type="datetime-local"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Event ends</label>
                  <input
                    className="input"
                    type="datetime-local"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Venue</label>
                  <input
                    className="input"
                    placeholder="e.g. The Glasshouse"
                    value={venue}
                    onChange={(e) => setVenue(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">City</label>
                  <input
                    className="input"
                    placeholder="e.g. Lisbon"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="label">Tag (optional)</label>
                <input
                  className="input"
                  placeholder="e.g. Conference, Festival, Meetup"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                />
              </div>

              <div>
                <label className="label">Description</label>
                <textarea
                  className="textarea"
                  placeholder="What is this event about? Who is it for?"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="label">Cover image (stored on Walrus on publish)</label>
                <input
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
                    <label className="label">Base price</label>
                    <input
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
                    <label className="label">Coin</label>
                    <select
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
                  A 3% platform fee is added on top at checkout. Pricing is set in My Events after
                  creation (the Event is shared on-chain).
                </p>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Max tickets</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={maxTickets}
                    onChange={(e) => setMaxTickets(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Max per attendee</label>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={maxPerUser}
                    onChange={(e) => setMaxPerUser(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="label" style={{ margin: 0 }}>
                    Additional tiers (optional)
                  </label>
                  <button type="button" className="btn btn-sm" onClick={addTier}>
                    <Icon icon="ph:plus-bold" size={13} /> Add tier
                  </button>
                </div>
                <p className="text-xs" style={{ color: "var(--fg3)" }}>
                  Extra tiers are saved in event metadata (Walrus) for display. Set their on-chain
                  prices later.
                </p>
                {tiers.map((t, i) => (
                  <div key={i} className="grid sm:grid-cols-[1fr_120px_1fr_auto] gap-2 items-start">
                    <input
                      className="input"
                      placeholder="Tier name (e.g. VIP)"
                      value={t.name}
                      onChange={(e) => updateTier(i, { name: e.target.value })}
                    />
                    <input
                      className="input"
                      type="number"
                      min={0}
                      step="any"
                      placeholder="Price"
                      value={t.price}
                      onChange={(e) => updateTier(i, { price: e.target.value })}
                    />
                    <input
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
                    >
                      <Icon icon="ph:trash-fill" size={14} />
                    </button>
                  </div>
                ))}
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
              <Toggle
                on={isFree}
                set={setIsFree}
                icon="ph:gift-fill"
                title="Free event"
                desc="No payment — attendees claim a free ticket."
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
