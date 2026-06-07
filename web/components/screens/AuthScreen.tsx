"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useCurrentAccount } from "@/lib/hooks";
import { ENOKI_ENABLED } from "@/lib/config";
import { CATEGORIES } from "@/lib/data";
import { Icon } from "@/components/Icon";
import { AddressDisplay } from "@/components/AddressDisplay";

type Role = "attend" | "host" | "both";

const ROLES: { id: Role; label: string; sub: string; icon: string }[] = [
  { id: "attend", label: "Attend", sub: "Find events & collect tickets", icon: "ion:ticket" },
  { id: "host", label: "Host", sub: "Create events & sell tickets", icon: "ic:round-add" },
  { id: "both", label: "Both", sub: "Discover and host", icon: "ic:round-explore" },
];

// Interest chips — exclude the synthetic "all" category.
const INTERESTS = CATEGORIES.filter((c) => c.id !== "all");

export function AuthScreen() {
  const account = useCurrentAccount();
  const router = useRouter();

  const [role, setRole] = useState<Role | null>(null);
  const [interests, setInterests] = useState<string[]>([]);

  const toggleInterest = (id: string) =>
    setInterests((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const canFinish = Boolean(role) && interests.length >= 1;

  function finish() {
    if (!role || interests.length < 1) return;
    // Persist onboarding choices locally (no on-chain backing for prefs).
    try {
      localStorage.setItem("hostit:role", role);
      localStorage.setItem("hostit:interests", JSON.stringify(interests));
      localStorage.setItem("hostit:onboarded", "1");
    } catch {
      // localStorage may be unavailable (private mode / SSR) — proceed anyway.
    }
    router.push(role === "host" ? "/dashboard" : "/discover");
  }

  return (
    <div className="screen-in" style={{ position: "relative", minHeight: "70vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {/* glowy dark hero backdrop */}
      <div className="glow" style={{ width: 460, height: 460, background: "rgba(0,124,250,.45)", top: -120, left: "50%", transform: "translateX(-50%)", opacity: 0.28 }} />
      <div className="glow" style={{ width: 340, height: 340, background: "rgba(250,0,212,.35)", bottom: -140, right: -40, opacity: 0.2 }} />

      <div className="card" style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 480, padding: 32 }}>
        {!account ? (
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
        ) : (
          <div className="space-y-7">
            <div style={{ textAlign: "center" }}>
              <span className="eyebrow"><Icon icon="ic:round-check-circle" size={14} /> Connected</span>
              <h1 className="page-title" style={{ marginTop: 14, fontSize: 26 }}>Set up your profile</h1>
              <p className="page-sub" style={{ marginTop: 6, display: "inline-flex", gap: 6, alignItems: "center", justifyContent: "center" }}>
                Signed in as <AddressDisplay address={account.address} suffix={4} />
              </p>
            </div>

            {/* Role chooser */}
            <div className="space-y-3">
              <div className="section-label">How will you use HostIt?</div>
              <div style={{ display: "grid", gap: 10 }}>
                {ROLES.map((r) => {
                  const on = role === r.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRole(r.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        textAlign: "left",
                        width: "100%",
                        padding: "14px 16px",
                        borderRadius: "var(--r-md)",
                        cursor: "pointer",
                        border: `1.5px solid ${on ? "var(--hi-blue)" : "var(--hair-2)"}`,
                        background: on ? "rgba(0,124,250,.08)" : "rgba(255,255,255,.02)",
                        color: "var(--fg1)",
                      }}
                    >
                      <span style={{ color: on ? "var(--hi-blue)" : "var(--fg3)", flex: "none" }}>
                        <Icon icon={r.icon} size={22} />
                      </span>
                      <span style={{ flex: 1 }}>
                        <span style={{ display: "block", fontWeight: 600 }}>{r.label}</span>
                        <span className="text-sm" style={{ color: "var(--fg3)" }}>{r.sub}</span>
                      </span>
                      {on && (
                        <span style={{ color: "var(--hi-blue)", flex: "none" }}>
                          <Icon icon="ic:round-check-circle" size={20} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Interests multi-select */}
            <div className="space-y-3">
              <div className="section-label">Pick your interests · choose at least 1</div>
              <div className="flex gap-2 flex-wrap">
                {INTERESTS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip ${interests.includes(c.id) ? "on" : ""}`}
                    onClick={() => toggleInterest(c.id)}
                  >
                    <Icon icon={c.icon} size={14} /> {c.label}
                  </button>
                ))}
              </div>
            </div>

            <button type="button" className="btn btn-primary btn-block btn-lg" disabled={!canFinish} onClick={finish}>
              Finish
              <Icon icon="ic:round-arrow-forward" size={18} />
            </button>
            {!canFinish && (
              <p className="mono" style={{ textAlign: "center", marginTop: -8 }}>
                {!role ? "Choose a role to continue." : "Select at least one interest."}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
