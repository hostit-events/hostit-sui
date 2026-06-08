"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useAuthCallback } from "@mysten/enoki/react";
import { useCurrentAccount } from "@/lib/hooks";
import { ENOKI_ENABLED } from "@/lib/config";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import { Icon } from "@/components/Icon";

// Web-component button → load client-only so its window-touching polyfill
// isn't evaluated during SSR.
const ConnectButton = dynamic(
  () => import("@mysten/dapp-kit-react/ui").then((m) => m.ConnectButton),
  { ssr: false },
);

/**
 * Login gateway. Google sign-in uses a full-page redirect (Enoki zkLogin):
 * clicking "Continue with Google" navigates the tab to Google and back here
 * with the token in the URL hash, which `useAuthCallback` completes. Once any
 * account (Google or wallet) is connected, we bounce into the app.
 */
export function AuthScreen() {
  const account = useCurrentAccount();
  const router = useRouter();
  // Completes the Google redirect by reading the id_token from the URL hash.
  useAuthCallback();
  // Are we mid-callback (returned from Google) so we should show a spinner
  // rather than the sign-in card?
  const [returningFromGoogle] = useState(
    () => typeof window !== "undefined" && /id_token=/.test(window.location.hash),
  );
  const [callbackError, setCallbackError] = useState(false);

  useEffect(() => {
    if (account) router.replace("/discover");
  }, [account, router]);

  // If we came back from Google but no session materializes, surface an error
  // instead of spinning forever.
  useEffect(() => {
    if (!returningFromGoogle || account) return;
    const t = setTimeout(() => setCallbackError(true), 10000);
    return () => clearTimeout(t);
  }, [returningFromGoogle, account]);

  if (account || (returningFromGoogle && !callbackError)) {
    return (
      <div
        className="screen-in"
        style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div className="mono" style={{ color: "var(--fg3)" }}>Signing you in…</div>
      </div>
    );
  }

  return (
    <div className="screen-in" style={{ position: "relative", minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {/* glowy dark hero backdrop */}
      <div className="glow" style={{ width: 460, height: 460, background: "rgba(0,124,250,.45)", top: -120, left: "50%", transform: "translateX(-50%)", opacity: 0.28 }} />
      <div className="glow" style={{ width: 340, height: 340, background: "rgba(250,0,212,.35)", bottom: -140, right: -40, opacity: 0.2 }} />

      <div className="card" style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 480, padding: 32 }}>
        <div className="space-y-6">
          <div style={{ textAlign: "center" }}>
            <span className="eyebrow"><Icon icon="ion:ticket" size={14} /> HostIt</span>
            <h1 className="page-title" style={{ marginTop: 16, fontSize: 30 }}>Welcome to HostIt</h1>
            <p className="page-sub" style={{ marginTop: 8 }}>
              Tickets, events and proof-of-attendance — fully on-chain on Sui. Sign in
              to get started. No passwords, ever.
            </p>
          </div>

          {callbackError && (
            <div
              role="alert"
              style={{
                padding: "10px 14px",
                border: "1px solid var(--hair-2)",
                borderRadius: "var(--r-md)",
                background: "rgba(250,0,84,.08)",
                color: "var(--fg1)",
                fontSize: 14,
              }}
            >
              Google sign-in didn’t complete. Please try again.
            </div>
          )}

          {ENOKI_ENABLED && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <GoogleSignInButton style={{ width: "100%", justifyContent: "center", minHeight: 46 }} />
              <div className="mono" style={{ textAlign: "center", color: "var(--fg3)", fontSize: 12 }}>or connect a wallet</div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "center" }}>
            <ConnectButton />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 14px",
              border: "1px solid var(--hair-2)",
              borderRadius: "var(--r-md)",
              background: "rgba(255,255,255,.02)",
            }}
          >
            <span style={{ color: "var(--hi-blue)", flex: "none", marginTop: 1 }}>
              <Icon icon="ic:round-fingerprint" size={18} />
            </span>
            <p className="text-sm" style={{ color: "var(--fg2)", margin: 0 }}>
              {ENOKI_ENABLED ? (
                <>
                  Sign in with <strong style={{ color: "var(--fg1)" }}>Google</strong> via zkLogin —
                  your account is derived with passkey-grade security and gas is sponsored on us. No
                  popup; you’re briefly redirected to Google and back.
                </>
              ) : (
                <>
                  Connect any Sui browser wallet. Auth is passwordless and passkey-style — you
                  approve actions by signing, never by typing a secret.
                </>
              )}
            </p>
          </div>

          <p className="mono" style={{ textAlign: "center" }}>
            By continuing you agree there are no custodians — your keys, your tickets.
          </p>
        </div>
      </div>
    </div>
  );
}
