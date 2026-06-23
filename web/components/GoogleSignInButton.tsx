"use client";

import { useState } from "react";
import { useGoogleSignIn } from "@/lib/auth";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";

/**
 * "Continue with Google" — triggers Enoki zkLogin as a full-page redirect.
 * The whole tab navigates to Google and back to /auth, so there's no popup to
 * be blocked. Shows a brief redirecting state.
 */
export function GoogleSignInButton({
  className,
  label = "Continue with Google",
  style,
  returnTo,
  onBeforeRedirect,
}: {
  className?: string;
  label?: string;
  style?: React.CSSProperties;
  /** Where `/auth` should bounce after the session lands (e.g. the current event URL). */
  returnTo?: string;
  /** Fired synchronously right before the redirect — stash any state to resume
   *  after the round-trip (e.g. the in-progress purchase). */
  onBeforeRedirect?: () => void;
}) {
  const signIn = useGoogleSignIn();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      type="button"
      className={className}
      style={style}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          onBeforeRedirect?.();
          await signIn(returnTo);
        } catch {
          setBusy(false);
        }
      }}
    >
      <Icon icon="logos:google-icon" size={16} />
      {busy ? "Redirecting…" : label}
    </Button>
  );
}
