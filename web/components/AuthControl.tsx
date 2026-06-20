"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCurrentAccount } from "@/lib/hooks";
import { useIsGoogleSession, useSignOut } from "@/lib/auth";
import { ENOKI_ENABLED } from "@/lib/config";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
      <div className="acct flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="mono text-[13px]">{short(account.address)}</span>
          </TooltipTrigger>
          <TooltipContent>{account.address}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Sign out"
              onClick={async () => {
                await signOut();
                router.replace("/");
              }}
            >
              <Icon icon="ic:round-logout" size={18} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Sign out</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (account) return <ConnectButton />;

  if (ENOKI_ENABLED) {
    return (
      <Button asChild size="sm">
        <Link href="/auth">Sign in</Link>
      </Button>
    );
  }
  return <ConnectButton />;
}
