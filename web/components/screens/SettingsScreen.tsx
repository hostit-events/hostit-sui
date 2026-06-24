"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCurrentAccount, useCurrentClient, useSignAndExecute, useSponsorAndExecute } from "@/lib/hooks";
import { useSuiNSNames } from "@/lib/verification";
import { storeFile, storeJson } from "@/lib/walrus";
import { CATEGORIES } from "@/lib/data";
import { EMAIL_ENABLED, ENOKI_ENABLED } from "@/lib/config";
import { useProfile } from "@/lib/profile";
import { useIsGoogleSession } from "@/lib/auth";
import {
  useSignPersonalMessage,
  decryptOwnEmail,
  eraseEmail,
  writeProfilePointer,
  type SubmitTx,
} from "@/lib/emailBinding";
import { EmailCaptureDialog } from "@/components/EmailCaptureDialog";
import { Icon } from "@/components/Icon";
import { AddressDisplay } from "@/components/AddressDisplay";
import { AuthControl } from "@/components/AuthControl";
import { PageHeader } from "@/components/PageHeader";
import { UserAvatar } from "@/components/UserAvatar";
import { ErrorState } from "@/components/States";
import { TxLink } from "@/components/TxLink";
import { humanizeError } from "@/lib/moveErrors";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fromHex } from "@mysten/sui/utils";

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
  { id: "interests", label: "Interests", icon: "ic:round-favorite" },
  { id: "notifications", label: "Notifications", icon: "ic:round-notifications" },
  { id: "security", label: "Security", icon: "ic:round-shield" },
] as const;

type Tab = (typeof NAV)[number]["id"];

export function SettingsScreen() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const suiClient = useCurrentClient();
  const names = useSuiNSNames(useMemo(() => (addr ? [addr] : []), [addr]));
  const suiNS = addr ? names.get(addr) ?? null : null;

  const [tab, setTab] = useState<Tab>("account");

  // ── Interests ──
  const [interests, setInterests] = useState<string[]>([]);

  // ── Notifications ──
  const [notifs, setNotifs] = useState<Notifs>({ events: true, forum: true, poap: true, marketing: false });

  // ── Account email + public profile (GH#96) ──
  const isGoogle = useIsGoogleSession();
  const sign = useSignPersonalMessage();
  const sponsored = useSponsorAndExecute();
  const regular = useSignAndExecute();
  const prof = useProfile(addr);
  const submitTx: SubmitTx = (tx) =>
    ENOKI_ENABLED
      ? sponsored.mutateAsync({ transaction: tx, sender: addr ?? "" })
      : regular.mutateAsync({ transaction: tx });
  const [emailPlain, setEmailPlain] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const emailBound = Boolean(prof.data?.emailBlobId);

  useEffect(() => {
    if (prof.data?.username) setUsername(prof.data.username);
  }, [prof.data?.username]);

  // Save the on-chain (Walrus) public profile: username + optional avatar upload.
  async function savePublicProfile() {
    if (!addr) {
      toast.error("Connect a wallet first.");
      return;
    }
    setProfileBusy(true);
    const tid = toast.loading("Saving profile…");
    try {
      let avatarBlobId = prof.data?.avatarBlobId;
      if (avatarFile) {
        toast.loading("Uploading avatar to Walrus…", { id: tid });
        avatarBlobId = await storeFile(avatarFile);
      }
      const next = { ...(prof.data ?? {}), v: 1 as const, username: username.trim() || undefined, avatarBlobId };
      const blobId = await storeJson(next);
      await writeProfilePointer(addr, blobId, sign);
      setAvatarFile(null);
      prof.refetch();
      toast.success("Public profile saved", { id: tid });
    } catch (e) {
      toast.error(`Couldn't save: ${humanizeError(e)}`, { id: tid });
    } finally {
      setProfileBusy(false);
    }
  }

  async function revealEmail() {
    if (!addr || !prof.data?.emailBlobId) return;
    setEmailBusy(true);
    const tid = toast.loading("Approve the signature to decrypt…");
    try {
      const email = await decryptOwnEmail(suiClient, addr, prof.data.emailBlobId, sign);
      setEmailPlain(email);
      toast.success("Decrypted — visible only in this session.", { id: tid });
    } catch (e) {
      toast.error(`Couldn't decrypt: ${humanizeError(e)}`, { id: tid });
    } finally {
      setEmailBusy(false);
    }
  }

  async function doEraseEmail() {
    if (!addr || !prof.data?.emailHash) {
      toast.error("Nothing to remove.");
      return;
    }
    setEmailBusy(true);
    const tid = toast.loading("Removing your email…");
    try {
      const digest = await eraseEmail({
        address: addr,
        hashBytes: Array.from(fromHex(prof.data.emailHash)),
        sign,
        submitTx,
        baseProfile: prof.data,
      });
      // For Google: stop the gate from silently re-binding the same email next login.
      if (typeof localStorage !== "undefined") localStorage.setItem(`hostit:emailErased:${addr}`, "1");
      setEmailPlain(null);
      prof.refetch();
      toast.success("Email removed", {
        id: tid,
        description: (
          <span>
            On-chain record cleared (<TxLink digest={digest} />). The encrypted blob expires with its
            Walrus TTL.
          </span>
        ),
      });
    } catch (e) {
      toast.error(`Couldn't remove: ${humanizeError(e)}`, { id: tid });
    } finally {
      setEmailBusy(false);
    }
  }

  // hydrate from localStorage on mount
  useEffect(() => {
    setInterests(lsRead<string[]>("hostit:interests", []));
    setNotifs(lsRead<Notifs>("hostit:notifs", { events: true, forum: true, poap: true, marketing: false }));
    // Purge stale data from the removed local-profile + verification sections (#111).
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("hostit:profile");
      window.localStorage.removeItem("hostit:kyc");
    }
  }, []);

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

  return (
    <div className="space-y-8 screen-in">
      <PageHeader title="Settings" sub="Profile, email, interests and notifications." />

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
            {!addr ? (
              <Card className="px-4 py-8 text-center text-sm text-muted-foreground">
                Connect a wallet to manage your profile.
              </Card>
            ) : prof.isLoading ? (
              <Card className="space-y-3 px-4">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </Card>
            ) : prof.isError ? (
              <ErrorState
                title="Couldn't load your profile"
                body="We couldn't read your on-chain profile just now — this is usually transient."
                onRetry={() => prof.refetch()}
              />
            ) : (
              <div className="space-y-6">
                {/* Public profile (on-chain): username + avatar used across HostIt. */}
                <Card className="space-y-5 px-4">
                  <div>
                    <div className="section-label">Public profile</div>
                    <p className="page-sub text-[13px]">
                      Username + avatar shown across HostIt (stored on Walrus, keyed to your address). A
                      suiNS name, if set, takes precedence as your verified handle.
                    </p>
                  </div>
                  {/* Live identity preview — how you appear to others across HostIt. */}
                  <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
                    <UserAvatar address={addr} size="lg" />
                    <div className="min-w-0 text-sm">
                      <AddressDisplay address={addr} className="font-medium" />
                      <div className="text-[12px] text-muted-foreground">How you appear across HostIt.</div>
                    </div>
                  </div>
                  <div className="field">
                    <Label htmlFor="settings-username">Username</Label>
                    <Input
                      id="settings-username"
                      placeholder="alice"
                      maxLength={40}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      disabled={profileBusy}
                    />
                  </div>
                  <div className="field">
                    <Label htmlFor="settings-avatar">Avatar</Label>
                    <Input
                      id="settings-avatar"
                      type="file"
                      accept="image/*"
                      onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
                      disabled={profileBusy}
                    />
                    <p className="text-[12px] text-muted-foreground">
                      {avatarFile
                        ? avatarFile.name
                        : prof.data?.avatarBlobId
                          ? "An avatar is set — choose a file to replace."
                          : "Optional."}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button className="min-h-11 sm:min-h-0" onClick={savePublicProfile} disabled={profileBusy}>
                      <Icon icon="ic:round-save" size={16} /> {profileBusy ? "Saving…" : "Save public profile"}
                    </Button>
                  </div>
                </Card>

                {/* Email (GH#96): Seal-encrypted; an organizer sees it only on opt-in. */}
                <Card className="space-y-5 px-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="section-label">Email</div>
                      <p className="page-sub text-[13px]">
                        Encrypted with Seal — an organizer sees it only if you opt in when buying a ticket.
                      </p>
                    </div>
                    {emailBound && (
                      <Badge variant="secondary">
                        <Icon icon="ph:lock-key-fill" size={13} />{" "}
                        {prof.data?.emailSource === "google" ? "Google" : "Wallet"}
                      </Badge>
                    )}
                  </div>

                  {!EMAIL_ENABLED ? (
                    <div className="mono">Email isn&apos;t enabled on this deployment.</div>
                  ) : !emailBound ? (
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground">No email linked yet.</p>
                      <Button className="min-h-11 sm:min-h-0" onClick={() => setBindOpen(true)}>
                        <Icon icon="ic:round-mail" size={16} /> Add email
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-muted-foreground">
                          {emailPlain ?? "•••••••• (encrypted)"}
                        </span>
                        {!emailPlain && (
                          <Button variant="outline" size="sm" disabled={emailBusy} onClick={revealEmail}>
                            <Icon icon="ph:eye" size={14} /> Reveal
                          </Button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap border-t pt-3.5">
                        {prof.data?.emailSource === "google" ? (
                          <>
                            <span className="text-[12px] text-muted-foreground">
                              <Icon icon="ph:lock-fill" size={13} /> Verified via Google — managed by your
                              Google account.
                            </span>
                            <Button variant="destructive" size="sm" disabled={emailBusy} onClick={doEraseEmail}>
                              Delete my email data
                            </Button>
                          </>
                        ) : (
                          <Button variant="outline" size="sm" disabled={emailBusy} onClick={doEraseEmail}>
                            Disconnect email
                          </Button>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Removing clears the on-chain record + revokes shares. The encrypted blob expires
                        with its Walrus TTL; an organizer you already shared with keeps what they decrypted.
                      </p>
                    </div>
                  )}
                </Card>
              </div>
            )}
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

      {bindOpen && addr && (
        <EmailCaptureDialog
          address={addr}
          mode={isGoogle ? "google" : "wallet"}
          baseProfile={prof.data ?? null}
          onClose={() => setBindOpen(false)}
          onBound={() => {
            setBindOpen(false);
            prof.refetch();
          }}
        />
      )}
    </div>
  );
}
