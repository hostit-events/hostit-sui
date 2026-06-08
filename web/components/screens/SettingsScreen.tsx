"use client";

import { useEffect, useMemo, useState } from "react";
import { useCurrentAccount, useCurrentClient } from "@/lib/hooks";
import { useSuiNSNames } from "@/lib/verification";
import { sealEncrypt, sealDecrypt, createSessionKey, approveSelf } from "@/lib/seal";
import { storeBlob, readBlob } from "@/lib/walrus";
import { CATEGORIES } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { AddressDisplay } from "@/components/AddressDisplay";
import { toBase64, fromBase64 } from "@mysten/sui/utils";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";

// ── localStorage keys ──────────────────────────────────────────────
const PROFILE_KEY = "hostit:profile";
const KYC_KEY = "hostit:kyc";

// Inline helper: safe JSON read from localStorage (SSR-safe, never throws).
function lsRead<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function lsWrite(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — fail silently */
  }
}

// Seal envelope persisted on Walrus: { id, ct } where ct = base64(ciphertext).
interface KycEnvelope {
  id: string;
  ct: string;
}

interface Profile {
  name: string;
  location: string;
}
interface Notifs {
  events: boolean;
  forum: boolean;
  poap: boolean;
  marketing: boolean;
}

const NOTIF_ROWS: { id: keyof Notifs; label: string; sub: string; icon: string }[] = [
  { id: "events", label: "Event reminders", sub: "Upcoming events you hold tickets for", icon: "ion:ticket" },
  { id: "forum", label: "Forum activity", sub: "Replies and mentions in event chats", icon: "ic:round-forum" },
  { id: "poap", label: "POAP drops", sub: "When proof-of-attendance is claimable", icon: "ph:seal-check-fill" },
  { id: "marketing", label: "Product updates", sub: "New HostIt features and announcements", icon: "ic:round-campaign" },
];

const NAV = [
  { id: "account", label: "Account", icon: "ic:round-person" },
  { id: "kyc", label: "Verification", icon: "ph:identification-card-fill" },
  { id: "interests", label: "Interests", icon: "ic:round-favorite" },
  { id: "notifications", label: "Notifications", icon: "ic:round-notifications" },
  { id: "security", label: "Security", icon: "ic:round-shield" },
] as const;

type Tab = (typeof NAV)[number]["id"];

export function SettingsScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const dAppKit = useDAppKit();
  const suiClient = useCurrentClient();
  const names = useSuiNSNames(useMemo(() => (addr ? [addr] : []), [addr]));
  const suiNS = addr ? names.get(addr) ?? null : null;

  const [tab, setTab] = useState<Tab>("account");

  // ── Account ──
  const [profile, setProfile] = useState<Profile>({ name: "", location: "" });
  const [profileSaved, setProfileSaved] = useState(false);

  // ── Interests ──
  const [interests, setInterests] = useState<string[]>([]);

  // ── Notifications ──
  const [notifs, setNotifs] = useState<Notifs>({ events: true, forum: true, poap: true, marketing: false });

  // ── KYC / Seal ──
  const [legalName, setLegalName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [kycBlobId, setKycBlobId] = useState<string | null>(null);
  const [kycBusy, setKycBusy] = useState(false);
  const [kycMsg, setKycMsg] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [kycDecrypted, setKycDecrypted] = useState<{ legalName?: string; idNumber?: string } | null>(null);

  // hydrate from localStorage on mount
  useEffect(() => {
    setProfile(lsRead<Profile>(PROFILE_KEY, { name: "", location: "" }));
    setInterests(lsRead<string[]>("hostit:interests", []));
    setNotifs(lsRead<Notifs>("hostit:notifs", { events: true, forum: true, poap: true, marketing: false }));
    setKycBlobId(lsRead<string | null>(KYC_KEY, null));
  }, []);

  function saveProfile() {
    lsWrite(PROFILE_KEY, profile);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 1800);
  }

  function toggleInterest(id: string) {
    setInterests((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      lsWrite("hostit:interests", next);
      return next;
    });
  }

  function toggleNotif(id: keyof Notifs) {
    setNotifs((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      lsWrite("hostit:notifs", next);
      return next;
    });
  }

  // Encrypt KYC PII with Seal → wrap as envelope → store on Walrus → save blobId.
  async function saveKyc() {
    if (!addr) {
      setKycMsg({ tone: "err", text: "Connect a wallet first." });
      return;
    }
    if (!legalName.trim() && !idNumber.trim()) {
      setKycMsg({ tone: "err", text: "Enter your legal name or ID number." });
      return;
    }
    setKycBusy(true);
    setKycMsg({ tone: "info", text: "Encrypting with Seal…" });
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({ legalName: legalName.trim(), idNumber: idNumber.trim() }),
      );
      const { id, ciphertext } = await sealEncrypt(suiClient, addr, payload);
      const envelope: KycEnvelope = { id, ct: toBase64(ciphertext) };
      setKycMsg({ tone: "info", text: "Storing encrypted blob on Walrus…" });
      const blobId = await storeBlob(new TextEncoder().encode(JSON.stringify(envelope)));
      lsWrite(KYC_KEY, blobId);
      setKycBlobId(blobId);
      setKycDecrypted(null);
      setLegalName("");
      setIdNumber("");
      setKycMsg({ tone: "ok", text: "Saved. Your details are encrypted end-to-end — only you can decrypt them." });
    } catch (e) {
      setKycMsg({
        tone: "err",
        text: `Could not save: ${e instanceof Error ? e.message : "Seal/Walrus error"}. Please try again.`,
      });
    } finally {
      setKycBusy(false);
    }
  }

  // Read envelope from Walrus → SessionKey (wallet personal-message sign) → Seal decrypt.
  async function decryptKyc() {
    if (!addr) {
      setKycMsg({ tone: "err", text: "Connect a wallet first." });
      return;
    }
    if (!kycBlobId) {
      setKycMsg({ tone: "err", text: "Nothing encrypted yet." });
      return;
    }
    setKycBusy(true);
    setKycMsg({ tone: "info", text: "Fetching encrypted blob…" });
    try {
      const raw = await readBlob(kycBlobId);
      const env = JSON.parse(new TextDecoder().decode(raw)) as KycEnvelope;
      setKycMsg({ tone: "info", text: "Approve the signature request to unlock…" });
      const signer = new CurrentAccountSigner(dAppKit);
      const sessionKey = await createSessionKey(suiClient, addr, async (message: Uint8Array) => {
        const { signature } = await signer.signPersonalMessage(message);
        return { signature };
      });
      const plaintext = await sealDecrypt(suiClient, sessionKey, fromBase64(env.ct), (tx) =>
        approveSelf(tx, env.id),
      );
      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as {
        legalName?: string;
        idNumber?: string;
      };
      setKycDecrypted(parsed);
      setKycMsg({ tone: "ok", text: "Decrypted — visible only in this session." });
    } catch (e) {
      setKycMsg({
        tone: "err",
        text: `Could not decrypt: ${e instanceof Error ? e.message : "Seal session/policy error"}.`,
      });
    } finally {
      setKycBusy(false);
    }
  }

  const msgColor =
    kycMsg?.tone === "ok"
      ? "var(--color-success)"
      : kycMsg?.tone === "err"
        ? "var(--color-danger)"
        : "var(--fg2)";

  return (
    <div className="space-y-8 screen-in">
      <header className="relative">
        <div
          className="glow"
          style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -40, opacity: 0.2 }}
        />
        <span className="eyebrow">
          <Icon icon="ic:round-settings" size={14} /> Settings
        </span>
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 34 }}>
          Your account
        </h1>
        <p className="page-sub">Profile, interests, notifications and encrypted verification.</p>
      </header>

      <div className="grid gap-6 grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)]">
        {/* left nav */}
        <aside className="flex flex-col gap-1.5" style={{ alignSelf: "start" }}>
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              className={`topnav-item ${tab === n.id ? "active" : ""}`}
              style={{
                justifyContent: "flex-start",
                gap: 10,
                width: "100%",
                padding: "10px 14px",
                borderRadius: "var(--r-md)",
                textAlign: "left",
              }}
            >
              <Icon icon={n.icon} size={16} /> {n.label}
            </button>
          ))}
        </aside>

        {/* panel */}
        <section className="space-y-6" style={{ minWidth: 0 }}>
          {tab === "account" && (
            <div className="card space-y-5">
              <div>
                <div className="section-label">Profile</div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Saved locally on this device.
                </p>
              </div>
              <div className="field">
                <label className="label" htmlFor="settings-profile-name">
                  Display name
                </label>
                <input
                  id="settings-profile-name"
                  className="input"
                  placeholder="Satoshi"
                  value={profile.name}
                  onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="settings-profile-location">
                  Location
                </label>
                <input
                  id="settings-profile-location"
                  className="input"
                  placeholder="Lisbon, PT"
                  value={profile.location}
                  onChange={(e) => setProfile((p) => ({ ...p, location: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-3">
                <button className="btn btn-primary" onClick={saveProfile}>
                  <Icon icon="ic:round-save" size={16} /> Save
                </button>
                {profileSaved && (
                  <span className="text-sm" style={{ color: "var(--color-success)" }}>
                    Saved ✓
                  </span>
                )}
              </div>
            </div>
          )}

          {tab === "kyc" && (
            <div className="card space-y-5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="section-label">Identity verification</div>
                  <p className="page-sub" style={{ fontSize: 13 }}>
                    Optional. Encrypted on your device, stored on Walrus — never readable by HostIt.
                  </p>
                </div>
                <span className="badge badge-soft" title="Threshold-encrypted with Mysten Seal">
                  <Icon icon="ph:lock-key-fill" size={13} /> Encrypted with Seal
                </span>
              </div>

              {!addr ? (
                <div className="mono">Connect a wallet to manage verification.</div>
              ) : (
                <>
                  <div className="field">
                    <label className="label" htmlFor="settings-kyc-legal-name">
                      Full legal name
                    </label>
                    <input
                      id="settings-kyc-legal-name"
                      className="input"
                      placeholder="As shown on your government ID"
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                      disabled={kycBusy}
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="settings-kyc-id-number">
                      ID number
                    </label>
                    <input
                      id="settings-kyc-id-number"
                      className="input"
                      placeholder="Passport / national ID number"
                      value={idNumber}
                      onChange={(e) => setIdNumber(e.target.value)}
                      disabled={kycBusy}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button className="btn btn-primary" onClick={saveKyc} disabled={kycBusy}>
                      <Icon icon="ph:lock-key-fill" size={16} /> Save encrypted
                    </button>
                    <button className="btn" onClick={decryptKyc} disabled={kycBusy || !kycBlobId}>
                      <Icon icon="ph:lock-key-open-fill" size={16} /> Decrypt &amp; view
                    </button>
                  </div>

                  {kycBlobId && (
                    <div className="panel" style={{ padding: "12px 14px" }}>
                      <div className="flex items-center gap-2 text-sm" style={{ color: "var(--fg2)" }}>
                        <Icon icon="ph:cloud-check-fill" size={15} style={{ color: "var(--hi-teal)" }} />
                        Encrypted record on Walrus
                      </div>
                      <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
                        {kycBlobId}
                      </div>
                    </div>
                  )}

                  {kycDecrypted && (
                    <div
                      className="panel space-y-2"
                      style={{ padding: "14px 16px", borderColor: "var(--color-verified)" }}
                    >
                      <div className="eyebrow">
                        <Icon icon="ph:lock-key-open-fill" size={13} /> Decrypted (this session)
                      </div>
                      <div className="text-sm">
                        <span style={{ color: "var(--fg3)" }}>Legal name: </span>
                        <span style={{ color: "var(--fg1)" }}>{kycDecrypted.legalName || "—"}</span>
                      </div>
                      <div className="text-sm">
                        <span style={{ color: "var(--fg3)" }}>ID number: </span>
                        <span className="mono" style={{ color: "var(--fg1)" }}>
                          {kycDecrypted.idNumber || "—"}
                        </span>
                      </div>
                    </div>
                  )}

                  {kycMsg && (
                    <div className="text-sm flex items-center gap-2" style={{ color: msgColor }}>
                      {kycBusy && kycMsg.tone === "info" && (
                        <Icon icon="svg-spinners:ring-resize" size={14} />
                      )}
                      {kycMsg.text}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "interests" && (
            <div className="card space-y-5">
              <div>
                <div className="section-label" id="settings-interests-label">
                  Interests
                </div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Pick categories to personalise Discover. Saved on this device.
                </p>
              </div>
              <div
                className="flex gap-2 flex-wrap"
                role="group"
                aria-labelledby="settings-interests-label"
              >
                {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="checkbox"
                    aria-checked={interests.includes(c.id)}
                    aria-label={c.label}
                    className={`chip ${interests.includes(c.id) ? "on" : ""}`}
                    onClick={() => toggleInterest(c.id)}
                  >
                    <Icon icon={c.icon} size={14} /> {c.label}
                  </button>
                ))}
              </div>
              <div className="mono">
                {interests.length} selected{interests.length > 0 ? ` · ${interests.join(", ")}` : ""}
              </div>
            </div>
          )}

          {tab === "notifications" && (
            <div className="card space-y-1">
              <div style={{ marginBottom: 12 }}>
                <div className="section-label">Notifications</div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Preferences saved on this device.
                </p>
              </div>
              {NOTIF_ROWS.map((row, i) => (
                <div
                  key={row.id}
                  className="flex items-center justify-between gap-4"
                  style={{
                    padding: "14px 0",
                    borderTop: i === 0 ? "none" : "1px solid var(--hair)",
                  }}
                >
                  <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
                    <span style={{ color: "var(--fg3)" }}>
                      <Icon icon={row.icon} size={18} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="font-medium" style={{ color: "var(--fg1)" }}>
                        {row.label}
                      </div>
                      <div className="text-sm" style={{ color: "var(--fg3)" }}>
                        {row.sub}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={notifs[row.id]}
                    aria-label={row.label}
                    className={`switch ${notifs[row.id] ? "on" : ""}`}
                    onClick={() => toggleNotif(row.id)}
                  />
                </div>
              ))}
            </div>
          )}

          {tab === "security" && (
            <div className="card space-y-5">
              <div>
                <div className="section-label">Security</div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Your connected wallet and on-chain identity.
                </p>
              </div>
              {!addr ? (
                <div className="mono">No wallet connected.</div>
              ) : (
                <>
                  <div className="panel" style={{ padding: "14px 16px" }}>
                    <div className="eyebrow">
                      <Icon icon="ic:round-account-balance-wallet" size={13} /> Connected wallet
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <AddressDisplay address={addr} suffix={4} />
                    </div>
                  </div>
                  <div className="panel" style={{ padding: "14px 16px" }}>
                    <div className="eyebrow">
                      <Icon icon="ph:globe-simple-fill" size={13} /> suiNS name
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {suiNS ? (
                        <span className="badge badge-green">
                          <Icon icon="ph:seal-check-fill" size={13} /> @{suiNS}
                        </span>
                      ) : (
                        <span className="text-sm" style={{ color: "var(--fg2)" }}>
                          No suiNS name found.{" "}
                          <a
                            href="https://suins.io"
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: "var(--hi-blue)" }}
                          >
                            Claim one
                          </a>{" "}
                          to boost trust as an organizer.
                        </span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
