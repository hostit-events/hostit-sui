"use client";

import { useState } from "react";
import { useGoogleSignIn } from "@/lib/auth";
import { Icon } from "./Icon";

/**
 * "Continue with Google" — triggers Enoki zkLogin as a full-page redirect.
 * The whole tab navigates to Google and back to /auth, so there's no popup to
 * be blocked. Shows a brief redirecting state.
 */
export function GoogleSignInButton({
  className = "btn btn-primary",
  label = "Continue with Google",
  style,
}: {
  className?: string;
  label?: string;
  style?: React.CSSProperties;
}) {
  const signIn = useGoogleSignIn();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={className}
      style={style}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signIn();
        } catch {
          setBusy(false);
        }
      }}
    >
      <Icon icon="logos:google-icon" size={16} />
      {busy ? "Redirecting…" : label}
    </button>
  );
}
