"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCurrentAccount } from "@/lib/hooks";
import { useIsGoogleSession, useSignOut } from "@/lib/auth";
import { ENOKI_ENABLED } from "@/lib/config";
import { Icon } from "./Icon";

// dapp-kit's ConnectButton is a web component that pulls in
// @webcomponents/scoped-custom-element-registry, which touches `window` at
// module load — load it client-only so it's never evaluated during SSR.
const ConnectButton = dynamic(
  () => import("@mysten/dapp-kit-react/ui").then((m) => m.ConnectButton),
  { ssr: false },
);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Header auth control, unified across auth methods:
 * - Google (Enoki) session → our own account chip + sign out (dapp-kit's
 *   ConnectButton doesn't know about zkLogin sessions).
 * - Wallet session → dapp-kit's ConnectButton (its account dropdown).
 * - Signed out → a single "Sign in" entry to /auth (which offers Google +
 *   wallet), or the wallet ConnectButton when Enoki is off.
 */
export function AuthControl() {
  const account = useCurrentAccount();
  const isGoogle = useIsGoogleSession();
  const signOut = useSignOut();
  const router = useRouter();

  if (account && isGoogle) {
    return (
      <div className="acct" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="mono" title={account.address} style={{ fontSize: 13 }}>
          {short(account.address)}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          style={{ minHeight: 44 }}
          aria-label="Sign out"
          title="Sign out"
          onClick={async () => {
            await signOut();
            router.replace("/");
          }}
        >
          <Icon icon="ic:round-logout" size={18} />
        </button>
      </div>
    );
  }

  if (account) return <ConnectButton />;

  if (ENOKI_ENABLED) {
    return (
      <Link href="/auth" className="btn btn-primary btn-sm" style={{ minHeight: 44 }}>
        Sign in
      </Link>
    );
  }
  return <ConnectButton />;
}
