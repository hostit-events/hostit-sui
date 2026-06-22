"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCurrentWallet, useDAppKit, useWallets } from "@mysten/dapp-kit-react";
import { useCurrentAccount } from "@/lib/hooks";
import { useGoogleSignIn, useIsGoogleSession, useSignOut } from "@/lib/auth";
import { useDisplayName } from "@/lib/profile";
import { ENOKI_ENABLED, NETWORK } from "@/lib/config";
import { Icon } from "./Icon";
import { UserAvatar } from "./UserAvatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
 * - Google (Enoki) session and Wallet session both render the SAME `AccountChip`
 *   (avatar + display name + dropdown) so identity looks identical everywhere and
 *   the profile a user sets in Settings (username/avatar/suiNS) actually shows in
 *   the header — previously the chip showed only raw hex + a divergent gradient.
 * - Signed out → a "Login" dropdown (Connect Wallet + Sign in with Google), or the
 *   wallet ConnectButton when Enoki is off.
 */
export function AuthControl() {
  const account = useCurrentAccount();
  const isGoogle = useIsGoogleSession();

  if (account && isGoogle) return <GoogleAccount address={account.address} />;
  if (account) return <WalletAccount address={account.address} />;
  if (ENOKI_ENABLED) return <LoginMenu />;
  return <ConnectButton />;
}

/**
 * The one account chip for every session type. Avatar = the shared `UserAvatar`
 * (uploaded profile avatar → single seeded-color fallback). Name = `useDisplayName`
 * (profile username → suiNS → short hex). Dropdown: copy / explorer / my tickets /
 * settings / sign-out. `sublabel` + `signOutLabel` + `onSignOut` are the only bits
 * that differ between Google and wallet sessions.
 */
function AccountChip({
  address,
  sublabel,
  signOutLabel,
  onSignOut,
}: {
  address: string;
  sublabel: string;
  signOutLabel: string;
  onSignOut: () => void;
}) {
  const { data: name } = useDisplayName(address);
  const [copied, setCopied] = useState(false);
  const explorerUrl = `https://${NETWORK === "mainnet" ? "" : `${NETWORK}.`}suivision.xyz/account/${address}`;

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-2" title={address}>
          <UserAvatar address={address} size="sm" />
          <span className="max-w-[14ch] truncate text-[13px] font-medium">
            {name ? `@${name}` : short(address)}
          </span>
          <Icon icon="ic:round-keyboard-arrow-down" size={14} className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
          {sublabel}
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault(); // keep the menu open to show the "Copied" state
            void copyAddress();
          }}
        >
          <Icon icon={copied ? "ic:round-check" : "ic:round-content-copy"} size={16} />
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={explorerUrl} target="_blank" rel="noreferrer">
            <Icon icon="ph:arrow-square-out" size={16} />
            View on explorer
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/wallet">
            <Icon icon="ion:ticket" size={16} />
            My tickets
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Icon icon="ic:round-settings" size={16} />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSignOut}>
          <Icon icon="ic:round-logout" size={16} />
          {signOutLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Google/zkLogin session chip. Sign-out stays on the current route. */
function GoogleAccount({ address }: { address: string }) {
  const signOut = useSignOut();
  const router = useRouter();
  return (
    <AccountChip
      address={address}
      sublabel="Signed in with Google"
      signOutLabel="Sign out"
      onSignOut={async () => {
        await signOut();
        // Stay in the app on the current route — screens render their own
        // signed-out / connect state; refresh re-renders without navigating away.
        router.refresh();
      }}
    />
  );
}

/** Connected-wallet chip. Disconnect stays on the current route. */
function WalletAccount({ address }: { address: string }) {
  const dAppKit = useDAppKit();
  const wallet = useCurrentWallet();
  const router = useRouter();
  return (
    <AccountChip
      address={address}
      sublabel={`Connected${wallet?.name ? ` · ${wallet.name}` : ""}`}
      signOutLabel="Disconnect"
      onSignOut={() => {
        dAppKit.disconnectWallet().catch(() => {});
        router.refresh();
      }}
    />
  );
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
