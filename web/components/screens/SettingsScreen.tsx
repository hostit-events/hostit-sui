"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCurrentAccount, useCurrentClient } from "@/lib/hooks";
import { useSuiNSNames } from "@/lib/verification";
import { sealEncrypt, sealDecrypt, createSessionKey, approveSelf } from "@/lib/seal";
import { storeBlob, readBlob } from "@/lib/walrus";
import { CATEGORIES } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { AddressDisplay } from "@/components/AddressDisplay";
import { AuthControl } from "@/components/AuthControl";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

  // ── Interests ──
  const [interests, setInterests] = useState<string[]>([]);

  // ── Notifications ──
  const [notifs, setNotifs] = useState<Notifs>({ events: true, forum: true, poap: true, marketing: false });

  // ── KYC / Seal ──
  const [legalName, setLegalName] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [kycBlobId, setKycBlobId] = useState<string | null>(null);
  const [kycBusy, setKycBusy] = useState(false);
  const [kycDecrypted, setKycDecrypted] = useState<{ legalName?: string; idNumber?: string } | null>(null);

  // hydrate from localStorage on mount
  useEffect(() => {
    setProfile(lsRead<Profile>(PROFILE_KEY, { name: "", location: "" }));
    setInterests(lsRead<string[]>("hostit:interests", []));
    setNotifs(lsRead<Notifs>("hostit:notifs", { events: true, forum: true, poap: true, marketing: false }));
    setKycBlobId(lsRead<string | null>(KYC_KEY, null));
  }, []);

  function saveProfile() {
    const trimmed: Profile = { name: profile.name.trim(), location: profile.location.trim() };
    setProfile(trimmed);
    lsWrite(PROFILE_KEY, trimmed);
    if (!trimmed.name && !trimmed.location) return;
    toast.success("Profile saved");
  }

  function toggleInterest(next: string[]) {
    lsWrite("hostit:interests", next);
    setInterests(next);
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
      toast.error("Connect a wallet first.");
      return;
    }
    if (!legalName.trim() && !idNumber.trim()) {
      toast.error("Enter your legal name or ID number.");
      return;
    }
    setKycBusy(true);
    const tid = toast.loading("Encrypting with Seal…");
    try {
      const payload = new TextEncoder().encode(
        JSON.stringify({ legalName: legalName.trim(), idNumber: idNumber.trim() }),
      );
      const { id, ciphertext } = await sealEncrypt(suiClient, addr, payload);
      const envelope: KycEnvelope = { id, ct: toBase64(ciphertext) };
      toast.loading("Storing encrypted blob on Walrus…", { id: tid });
      const blobId = await storeBlob(new TextEncoder().encode(JSON.stringify(envelope)));
      lsWrite(KYC_KEY, blobId);
      setKycBlobId(blobId);
      setKycDecrypted(null);
      setLegalName("");
      setIdNumber("");
      toast.success("Saved", {
        id: tid,
        description: "Your details are encrypted end-to-end — only you can decrypt them.",
      });
    } catch (e) {
      toast.error(
        `Could not save: ${e instanceof Error ? e.message : "Seal/Walrus error"}. Please try again.`,
        { id: tid },
      );
    } finally {
      setKycBusy(false);
    }
  }

  // Read envelope from Walrus → SessionKey (wallet personal-message sign) → Seal decrypt.
  async function decryptKyc() {
    if (!addr) {
      toast.error("Connect a wallet first.");
      return;
    }
    if (!kycBlobId) {
      toast.error("Nothing encrypted yet.");
      return;
    }
    setKycBusy(true);
    const tid = toast.loading("Fetching encrypted blob…");
    try {
      const raw = await readBlob(kycBlobId);
      const env = JSON.parse(new TextDecoder().decode(raw)) as KycEnvelope;
      toast.loading("Approve the signature request to unlock…", { id: tid });
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
      toast.success("Decrypted — visible only in this session.", { id: tid });
    } catch (e) {
      toast.error(
        `Could not decrypt: ${e instanceof Error ? e.message : "Seal session/policy error"}.`,
        { id: tid },
      );
    } finally {
      setKycBusy(false);
    }
  }

  return (
    <div className="space-y-8 screen-in">
      <header className="relative">
        <div
          className="glow"
          style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -40, opacity: 0.2 }}
        />
        <h1 className="page-title" style={{ marginTop: 12, fontSize: 34 }}>
          Your account
        </h1>
        <p className="page-sub">Profile, interests, notifications and encrypted verification.</p>
      </header>

      {/* Mobile: the header is hidden, so the account sign-in/out lives here
          (this is the "Account" bottom-tab destination). */}
      <Card className="md:hidden flex flex-row items-center justify-between gap-3 px-3.5 py-3.5">
        <span className="section-label" style={{ margin: 0 }}>Wallet</span>
        <AuthControl />
      </Card>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        orientation="vertical"
        className="grid gap-6 grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] md:flex-row"
      >
        {/* left nav */}
        <TabsList variant="line" className="flex h-fit w-full flex-col items-stretch gap-1.5 self-start bg-transparent p-0">
          {NAV.map((n) => (
            <TabsTrigger key={n.id} value={n.id} className="justify-start gap-2.5 px-3.5 py-2.5">
              <Icon icon={n.icon} size={16} /> {n.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* panel */}
        <div className="space-y-6" style={{ minWidth: 0 }}>
          <TabsContent value="account">
            <Card className="space-y-5 px-4">
              <div>
                <div className="section-label">Profile</div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Saved locally on this device.
                </p>
              </div>
              <div className="field">
                <Label htmlFor="settings-profile-name">Display name</Label>
                <Input
                  id="settings-profile-name"
                  placeholder="Satoshi"
                  maxLength={80}
                  value={profile.name}
                  onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <Label htmlFor="settings-profile-location">Location</Label>
                <Input
                  id="settings-profile-location"
                  placeholder="Lisbon, PT"
                  maxLength={80}
                  value={profile.location}
                  onChange={(e) => setProfile((p) => ({ ...p, location: e.target.value }))}
                />
              </div>
              <div className="flex items-center gap-3">
                <Button onClick={saveProfile}>
                  <Icon icon="ic:round-save" size={16} /> Save
                </Button>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="kyc">
            <Card className="space-y-5 px-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="section-label">Identity verification</div>
                  <p className="page-sub" style={{ fontSize: 13 }}>
                    Optional. Encrypted on your device, stored on Walrus — never readable by HostIt.
                  </p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary">
                      <Icon icon="ph:lock-key-fill" size={13} /> Encrypted with Seal
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>Threshold-encrypted with Mysten Seal</TooltipContent>
                </Tooltip>
              </div>

              {!addr ? (
                <div className="mono">Connect a wallet to manage verification.</div>
              ) : (
                <>
                  <div className="field">
                    <Label htmlFor="settings-kyc-legal-name">Full legal name</Label>
                    <Input
                      id="settings-kyc-legal-name"
                      placeholder="As shown on your government ID"
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                      disabled={kycBusy}
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="settings-kyc-id-number">ID number</Label>
                    <Input
                      id="settings-kyc-id-number"
                      placeholder="Passport / national ID number"
                      value={idNumber}
                      onChange={(e) => setIdNumber(e.target.value)}
                      disabled={kycBusy}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={saveKyc} disabled={kycBusy}>
                      <Icon icon="ph:lock-key-fill" size={16} /> Save encrypted
                    </Button>
                    <Button variant="outline" onClick={decryptKyc} disabled={kycBusy || !kycBlobId}>
                      <Icon icon="ph:lock-key-open-fill" size={16} /> Decrypt &amp; view
                    </Button>
                  </div>

                  {kycBlobId && (
                    <Card className="px-3.5 py-3">
                      <div className="flex items-center gap-2 text-sm" style={{ color: "var(--fg2)" }}>
                        <Icon icon="ph:cloud-check-fill" size={15} style={{ color: "var(--hi-teal)" }} />
                        Encrypted record on Walrus
                      </div>
                      <div className="mono" style={{ marginTop: 6, wordBreak: "break-all" }}>
                        {kycBlobId}
                      </div>
                    </Card>
                  )}

                  {kycDecrypted && (
                    <Card className="space-y-2 px-4 py-3.5" style={{ borderColor: "var(--color-verified)" }}>
                      <div className="section-label">
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
                    </Card>
                  )}
                </>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="interests">
            <Card className="space-y-5 px-4">
              <div>
                <div className="section-label" id="settings-interests-label">
                  Interests
                </div>
                <p className="page-sub" style={{ fontSize: 13 }}>
                  Pick categories to personalise Discover. Saved on this device.
                </p>
              </div>
              <ToggleGroup
                type="multiple"
                variant="outline"
                value={interests}
                onValueChange={toggleInterest}
                className="flex w-full flex-wrap"
                aria-labelledby="settings-interests-label"
              >
                {CATEGORIES.filter((c) => c.id !== "all").map((c) => (
                  <ToggleGroupItem key={c.id} value={c.id} aria-label={c.label} className="gap-1.5">
                    <Icon icon={c.icon} size={14} /> {c.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <div className="mono">
                {interests.length} selected{interests.length > 0 ? ` · ${interests.join(", ")}` : ""}
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="notifications">
            <Card className="space-y-1 px-4">
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
                  <Switch
                    checked={notifs[row.id]}
                    onCheckedChange={() => toggleNotif(row.id)}
                    aria-label={row.label}
                  />
                </div>
              ))}
            </Card>
          </TabsContent>

          <TabsContent value="security">
            <Card className="space-y-5 px-4">
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
                  <Card className="px-4 py-3.5">
                    <div className="section-label">
                      <Icon icon="ic:round-account-balance-wallet" size={13} /> Connected wallet
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <AddressDisplay address={addr} suffix={4} />
                    </div>
                  </Card>
                  <Card className="px-4 py-3.5">
                    <div className="section-label">
                      <Icon icon="ph:globe-simple-fill" size={13} /> suiNS name
                    </div>
                    <div style={{ marginTop: 8 }}>
                      {suiNS ? (
                        <Badge variant="secondary">
                          <Icon icon="ph:seal-check-fill" size={13} /> @{suiNS}
                        </Badge>
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
                  </Card>
                </>
              )}
            </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
