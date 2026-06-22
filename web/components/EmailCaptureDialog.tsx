"use client";

// One-time email-binding prompt (GH#96). Google sessions auto-bind their verified
// email popup-free; wallet sessions get a 2-step OTP (email → code). Mounted
// app-wide via <ProfileGate/> in the (app) layout; opens once per address when
// EMAIL_ENABLED and no email is bound yet. Dismissible (re-openable from Settings).

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/Icon";
import { EMAIL_ENABLED, ENOKI_ENABLED } from "@/lib/config";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
} from "@/lib/hooks";
import { useIsGoogleSession } from "@/lib/auth";
import { useZkLoginSession } from "@mysten/enoki/react";
import { useProfile, type ProfileEnvelope } from "@/lib/profile";
import {
  useSignPersonalMessage,
  bindGoogleEmail,
  startWalletEmail,
  verifyWalletEmail,
  type SubmitTx,
} from "@/lib/emailBinding";
import { isValidEmail } from "@/lib/emailCanonical";
import { humanizeError } from "@/lib/moveErrors";

function promptedKey(addr: string) {
  return `hostit:emailPrompted:${addr}`;
}

/** App-wide gate: opens the dialog once per connected address that has no email. */
export function ProfileGate() {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const prof = useProfile(addr);
  const isGoogle = useIsGoogleSession();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!addr || typeof localStorage === "undefined") return;
    const skip =
      localStorage.getItem(promptedKey(addr)) === "1" ||
      localStorage.getItem(`hostit:emailErased:${addr}`) === "1";
    setDismissed(Boolean(skip));
  }, [addr]);

  // Don't auto-prompt while the profile is loading OR if the read failed — on a
  // transient error prof.data is undefined, and prompting would re-bind from an
  // empty baseProfile and overwrite the user's username/avatar/emailHash.
  if (!EMAIL_ENABLED || !addr || prof.isLoading || prof.isError) return null;
  if (Boolean(prof.data?.emailBlobId) || dismissed) return null;

  return (
    <EmailCaptureDialog
      address={addr}
      mode={isGoogle ? "google" : "wallet"}
      baseProfile={prof.data ?? null}
      onClose={() => {
        localStorage.setItem(promptedKey(addr), "1");
        setDismissed(true);
      }}
      onBound={() => {
        localStorage.setItem(promptedKey(addr), "1");
        setDismissed(true);
        prof.refetch();
      }}
    />
  );
}

export function EmailCaptureDialog({
  address,
  mode,
  baseProfile,
  onClose,
  onBound,
}: {
  address: string;
  mode: "google" | "wallet";
  baseProfile: ProfileEnvelope | null;
  onClose: () => void;
  onBound: () => void;
}) {
  const client = useCurrentClient();
  const sign = useSignPersonalMessage();
  const sponsored = useSponsorAndExecute();
  const regular = useSignAndExecute();
  const session = useZkLoginSession();
  const submitTx: SubmitTx = (tx) =>
    ENOKI_ENABLED
      ? sponsored.mutateAsync({ transaction: tx, sender: address })
      : regular.mutateAsync({ transaction: tx });

  const [step, setStep] = useState<"form" | "code" | "done">("form");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ranGoogle = useRef(false);

  function close() {
    if (busy) return;
    onClose();
  }

  async function runGoogle() {
    setBusy(true);
    setErr(null);
    try {
      const jwt = session?.jwt;
      if (!jwt) throw new Error("No Google session — sign in again to link your email.");
      await bindGoogleEmail({ suiClient: client, address, jwt, sign, submitTx, baseProfile });
      setStep("done");
      onBound();
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // Google: auto-bind on mount.
  useEffect(() => {
    if (mode !== "google" || ranGoogle.current) return;
    ranGoogle.current = true;
    void runGoogle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function sendCode() {
    if (!isValidEmail(email)) {
      setErr("Enter a valid email.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await startWalletEmail({ address, email, sign });
      setStep("code");
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    if (code.trim().length < 6) {
      setErr("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await verifyWalletEmail({ suiClient: client, address, email, code: code.trim(), sign, submitTx, baseProfile });
      setStep("done");
      onBound();
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (!o ? close() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add your email</DialogTitle>
          <DialogDescription>
            An account on HostIt should have an email so organizers can reach you about your tickets,
            reminders, and POAP claims. It&apos;s encrypted — shared with an organizer only if you opt in.
          </DialogDescription>
        </DialogHeader>

        {step === "done" ? (
          <div className="flex items-center gap-2 py-2 text-sm" style={{ color: "var(--hi-green, #34d399)" }}>
            <Icon icon="ic:round-check-circle" size={18} /> Email linked and encrypted.
          </div>
        ) : mode === "google" ? (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--fg2)" }}>
              {busy ? (
                <>
                  <Icon icon="svg-spinners:3-dots-fade" size={18} /> Linking your Google email…
                </>
              ) : err ? (
                <span style={{ color: "var(--color-danger)" }}>{err}</span>
              ) : null}
            </div>
          </div>
        ) : step === "form" ? (
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="bind-email">Email</Label>
              <Input
                id="bind-email"
                type="email"
                placeholder="you@example.com"
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {err && <p className="text-[13px]" style={{ color: "var(--color-danger)" }}>{err}</p>}
            <p className="text-[12px]" style={{ color: "var(--fg3)" }}>
              We&apos;ll email a 6-digit code, and you&apos;ll sign a message to prove this wallet.
            </p>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="bind-code">Enter the code sent to {email}</Label>
              <Input
                id="bind-code"
                inputMode="numeric"
                placeholder="123456"
                value={code}
                disabled={busy}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            {err && <p className="text-[13px]" style={{ color: "var(--color-danger)" }}>{err}</p>}
          </div>
        )}

        <DialogFooter>
          {step === "done" ? (
            <Button onClick={onBound}>Done</Button>
          ) : mode === "google" ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={close}>
                Skip
              </Button>
              {err && (
                <Button disabled={busy} onClick={runGoogle}>
                  Retry
                </Button>
              )}
            </>
          ) : step === "form" ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={close}>
                Skip for now
              </Button>
              <Button disabled={busy} onClick={sendCode}>
                {busy ? "Sending…" : "Send code"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setStep("form")}>
                Back
              </Button>
              <Button disabled={busy} onClick={confirmCode}>
                {busy ? "Verifying…" : "Verify & link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
