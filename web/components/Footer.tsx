import Link from "next/link";
import { NETWORK, PACKAGE_ID, ENOKI_ENABLED, TURNSTILE_ENABLED } from "@/lib/config";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

export function Footer() {
  return (
    <footer className="mt-auto hidden border-t bg-background/60 backdrop-blur md:block">
      <div className="mx-auto max-w-[1180px] px-5 py-8 sm:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand + blurb */}
          <div className="space-y-3">
            <Link href="/" className="flex items-center gap-2" aria-label="HostIt home">
              <Logo size={20} className="opacity-90" />
            </Link>
            <p className="text-xs text-muted-foreground">
              Events made easy. Mint tickets, check in, and claim
              proof-of-attendance NFTs on the Sui blockchain.
            </p>
          </div>

          {/* Platform */}
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Platform
            </h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  href="/discover"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  Discover events
                </Link>
              </li>
              <li>
                <Link
                  href="/wallet"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  My tickets
                </Link>
              </li>
              <li>
                <Link
                  href="/dashboard"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  Dashboard
                </Link>
              </li>
              <li>
                <Link
                  href="/create"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  Create event
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Resources
            </h3>
            <ul className="space-y-2 text-sm">
              <li>
                <Link
                  href="/docs"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="ph:book-open-text-fill" size={12} />
                  Docs
                </Link>
              </li>
              <li>
                <Link
                  href="/support"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="ic:round-mail" size={12} />
                  Support
                </Link>
              </li>
              <li>
                <a
                  href="/pitch"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="ph:projector-screen-fill" size={12} />
                  Pitch deck
                </a>
              </li>
              <li>
                <a
                  href="https://docs.sui.io"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="ph:globe-simple-fill" size={12} />
                  Sui docs
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/hostit-events/hostit-sui"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="mdi:github" size={12} />
                  Open source
                </a>
              </li>
              <li>
                <a
                  href="https://docs.enoki.mystenlabs.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Icon icon="mdi:rocket-launch" size={12} />
                  Gasless onboarding
                </a>
              </li>
            </ul>
          </div>

          {/* Network — fed from real lib/config values, never hardcoded */}
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Network
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-card/40 px-2.5 py-1.5">
                <span className="text-muted-foreground">Network</span>
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {NETWORK}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-card/40 px-2.5 py-1.5">
                <span className="text-muted-foreground">Package</span>
                <span className="font-mono text-xs font-medium">
                  {PACKAGE_ID.slice(0, 10)}…{PACKAGE_ID.slice(-4)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-card/40 px-2.5 py-1.5">
                <span className="text-muted-foreground">Gas</span>
                <span className="text-xs font-medium">
                  {ENOKI_ENABLED ? "sponsored gas on" : "browser wallets"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} HostIt. Built on Sui.</p>
          <p className="text-muted-foreground">Permissionless ticketing — anyone can host.</p>
        </div>

        {/* Bot-check disclosure (#81). Only shown when Turnstile is configured;
            it guards the gasless-sponsor + AI helpers, collects no personal data,
            and is never linked to a wallet. */}
        {TURNSTILE_ENABLED && (
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            Gasless actions and AI helpers are protected by a Cloudflare bot-check
            — no personal data, never linked to your wallet.
          </p>
        )}
      </div>
    </footer>
  );
}
