import Link from "next/link";
import type { Metadata } from "next";
import { Icon } from "@/components/Icon";

// Public, static docs page — outside the (app) route group, so it carries no
// wallet chrome / testnet banner and reads cleanly for judges + new users.
// NOTE: add "/docs" to the Cloudflare WAF Managed-Challenge exclusion so it's
// freely readable (like "/support"); otherwise the edge gates it.

export const metadata: Metadata = {
  title: "Docs — HostIt",
  description:
    "How HostIt works: gasless, wallet-optional event ticketing on Sui — zkLogin/Enoki, Walrus, Seal, native prediction markets, POAPs.",
};

const DEEPWIKI = "https://deepwiki.com/hostit-events/hostit-sui";
const GITHUB = "https://github.com/hostit-events/hostit-sui";

const STACK: { ic: string; title: string; body: string }[] = [
  {
    ic: "ic:round-bolt",
    title: "zkLogin + Enoki (gasless)",
    body: "Sign in with Google — zkLogin mints your Sui account, no wallet or seed phrase. Enoki sponsors gas, so claiming and buying tickets cost you $0 in gas.",
  },
  {
    ic: "ph:database-fill",
    title: "Walrus storage",
    body: "Event metadata and cover images live on Walrus decentralized blob storage, referenced from the on-chain event.",
  },
  {
    ic: "ph:lock-key-fill",
    title: "Seal encryption",
    body: "Threshold encryption (Seal) gates private event data so it's decryptable only by ticket holders or the organizer.",
  },
  {
    ic: "mdi:chart-line",
    title: "Native prediction markets",
    body: "Parimutuel markets — “will it sell out?” and final-tickets-sold buckets — that settle trustlessly on-chain by reading the event's minted count. No oracle, no fee.",
  },
  {
    ic: "ph:medal-fill",
    title: "POAPs",
    body: "Attendees claim a proof-of-attendance NFT after check-in — one per ticket, gated by the event's POAP toggle.",
  },
  {
    ic: "ph:cube-transparent-fill",
    title: "Move package",
    body: "One Move package — events, tickets, check-in, POAPs, a ticket-gated forum, markets, and protocol RBAC on OpenZeppelin access-control. A faithful port of HostIt's EVM platform.",
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Sign in",
    body: "Click Login → Continue with Google. zkLogin creates your Sui account behind the scenes — no wallet, no seed phrase. Prefer self-custody? Connect any Sui wallet instead.",
  },
  {
    title: "Discover events",
    body: "Browse the Discover feed, filter by category, or hit ⌘K to search events and jump anywhere fast.",
  },
  {
    title: "Claim or buy a ticket",
    body: "Claim a free ticket, or buy a paid one in the organizer's coin (e.g. SUI or USDC). Gas is sponsored — you only need the ticket price. On testnet, that's test coins only.",
  },
  {
    title: "Use your ticket",
    body: "Add it to Google Wallet, or send it to a friend on-chain. At the event, show the QR for check-in.",
  },
  {
    title: "Host your own",
    body: "Create event → set details, price, capacity, and per-wallet limits. Manage edits, add check-in staff, and pay out from on-chain escrow — all permissionless, any wallet can host.",
  },
  {
    title: "After the event",
    body: "Claim a POAP to prove you were there. Organizers withdraw revenue once the refund window closes.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need a crypto wallet?",
    a: "No. Sign in with Google and zkLogin handles the rest. You can connect a Sui wallet if you prefer self-custody.",
  },
  {
    q: "Do I need SUI for gas?",
    a: "No — gas is sponsored via Enoki. For paid events you only need the ticket price in the event's coin.",
  },
  {
    q: "Is this real money?",
    a: "No. It runs on Sui testnet — tickets and payments use test coins. Nothing touches real funds.",
  },
  {
    q: "Does it work on mobile?",
    a: "Yes — fully responsive with a mobile tab bar, and you can add tickets to Google Wallet on your phone.",
  },
  {
    q: "Is the code open / audited?",
    a: "The Move package and the app are open source (links below). It's a testnet hackathon build — not audited; don't use it for real funds.",
  },
];

export default function DocsPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link href="/" aria-label="HostIt home" className="inline-flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 24 }} />
          </Link>
          <Link
            href="/discover"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open app <Icon icon="ic:round-arrow-forward" size={16} />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-14 sm:px-8 sm:py-20">
        <p className="text-sm font-medium uppercase tracking-wider text-primary">Docs</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">How HostIt works</h1>
        <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
          HostIt is permissionless event ticketing on Sui — anyone can host, sell in any coin, check
          attendees in, and issue proof-of-attendance NFTs, with a gasless, wallet-optional experience.
        </p>

        {/* quick nav */}
        <nav className="mt-6 flex flex-wrap gap-2 text-sm">
          {[
            ["Sui-native stack", "#stack"],
            ["Getting started", "#start"],
            ["FAQ", "#faq"],
            ["Source", "#source"],
          ].map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>

        {/* Sui-native stack */}
        <section id="stack" className="mt-14 scroll-mt-20 sm:mt-20">
          <h2 className="text-xl font-semibold tracking-tight">Built on the Sui-native stack</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            HostIt leans on Sui&rsquo;s object model and ecosystem primitives end-to-end.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STACK.map((s) => (
              <div key={s.title} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
                    <Icon icon={s.ic} size={18} />
                  </span>
                  <h3 className="text-sm font-semibold">{s.title}</h3>
                </div>
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Getting started */}
        <section id="start" className="mt-14 scroll-mt-20 sm:mt-20">
          <h2 className="text-xl font-semibold tracking-tight">Getting started</h2>
          <ol className="mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-4">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{step.title}</h3>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* FAQ */}
        <section id="faq" className="mt-14 scroll-mt-20 sm:mt-20">
          <h2 className="text-xl font-semibold tracking-tight">FAQ</h2>
          <dl className="mt-6 grid gap-x-10 gap-y-7 sm:grid-cols-2">
            {FAQ.map((item) => (
              <div key={item.q}>
                <dt className="text-sm font-semibold">{item.q}</dt>
                <dd className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Source */}
        <section id="source" className="mt-14 scroll-mt-20 sm:mt-20">
          <h2 className="text-xl font-semibold tracking-tight">Dig into the code</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Want the architecture and internals? The codebase is open and explorable.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={DEEPWIKI}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/60"
            >
              <Icon icon="ph:book-open-text-fill" size={18} /> Architecture wiki (DeepWiki)
            </a>
            <a
              href={GITHUB}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/60"
            >
              <Icon icon="ri:github-fill" size={18} /> GitHub repo
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-5 py-6 text-sm text-muted-foreground sm:px-8">
          <span>© 2026 HostIt, Inc.</span>
          <div className="flex gap-4">
            <Link href="/support" className="transition-colors hover:text-foreground">
              Support
            </Link>
            <Link href="/" className="transition-colors hover:text-foreground">
              Back to HostIt
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
