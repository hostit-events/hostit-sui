"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useCurrentAccount } from "@/lib/hooks";
import { ENOKI_ENABLED } from "@/lib/config";
import { Icon } from "@/components/Icon";

/**
 * Login gateway. Not connected → welcome + connect. Once a wallet is connected,
 * we bounce straight into the app — connecting *is* the onboarding. There is no
 * "set up your profile" step (it was redundant: interests live in Settings and
 * nothing else read the role), so it no longer reappears on every visit.
 */
export function AuthScreen() {
  const account = useCurrentAccount();
  const router = useRouter();

  useEffect(() => {
    if (account) router.replace("/discover");
  }, [account, router]);

  if (account) {
    return (
      <div
        className="screen-in"
        style={{ minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <div className="mono" style={{ color: "var(--fg3)" }}>Signed in — taking you to HostIt…</div>
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
              Tickets, events and proof-of-attendance — fully on-chain on Sui. Connect a wallet
              to get started. No passwords, ever.
            </p>
          </div>

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
                  Prefer no wallet install? Sign in with <strong style={{ color: "var(--fg1)" }}>Google</strong>{" "}
                  via zkLogin — your account is derived with passkey-grade security and gas is
                  sponsored on us. Pick it from the connect dialog above.
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
