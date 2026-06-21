"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useDAppKit, useWallets } from "@mysten/dapp-kit-react";
import { useCurrentAccount } from "@/lib/hooks";
import { useGoogleSignIn, useIsGoogleSession, useSignOut } from "@/lib/auth";
import { ENOKI_ENABLED } from "@/lib/config";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
 * - Signed out → a "Login" dropdown (Connect Wallet + Sign in with Google),
 *   or the wallet ConnectButton when Enoki is off.
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

  if (ENOKI_ENABLED) return <LoginMenu />;

  return <ConnectButton />;
}

/**
 * Signed-out + Enoki-enabled control: a compact "Login" button that opens a
 * dropdown with two ways in — connect a wallet or sign in with Google (Enoki
 * zkLogin, a full-page redirect).
 *
 * Wallet connect is wired in pure React via dapp-kit's `useWallets()` +
 * `connectWallet({ wallet })` (no web-component modal to keep in sync). With a
 * single detected wallet we surface one "Connect Wallet" row that connects it
 * directly; with several we list them; with none, a disabled hint. The Google
 * row triggers the same zkLogin redirect as `GoogleSignInButton`.
 */
function LoginMenu() {
  const signIn = useGoogleSignIn();
  const dAppKit = useDAppKit();
  const wallets = useWallets();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          Login
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {wallets.length === 0 ? (
          <DropdownMenuItem disabled>
            <Icon icon="solar:wallet-bold" size={18} />
            No wallet detected
          </DropdownMenuItem>
        ) : wallets.length === 1 ? (
          <DropdownMenuItem
            onSelect={() => {
              // Swallow user-cancel (closed wallet popup) so it isn't an unhandled rejection.
              dAppKit.connectWallet({ wallet: wallets[0] }).catch(() => {});
            }}
          >
            <Icon icon="solar:wallet-bold" size={18} />
            Connect Wallet
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuLabel>Connect Wallet</DropdownMenuLabel>
            {wallets.map((wallet) => (
              <DropdownMenuItem
                key={wallet.name}
                onSelect={() => {
                  dAppKit.connectWallet({ wallet }).catch(() => {});
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={wallet.icon} alt="" width={18} height={18} className="rounded" />
                {wallet.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void signIn();
          }}
        >
          <Icon icon="logos:google-icon" size={16} />
          Sign in with Google
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
