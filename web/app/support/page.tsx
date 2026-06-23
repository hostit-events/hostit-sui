import Link from "next/link";
import type { Metadata } from "next";
import { Icon } from "@/components/Icon";

// Public, static support page — deliberately OUTSIDE the (app) route group so it
// carries no wallet chrome / testnet banner. It's the "customer support URL"
// given to Google Wallet (and any payment/app reviewer), and the page real users
// land on for help.

export const metadata: Metadata = {
  title: "Support — HostIt",
  description:
    "Get help with HostIt — tickets, wallet passes, refunds, and hosting events on Sui. Contact our team.",
};

const SUPPORT_EMAIL = "contact@hostit.events";

const CHANNELS: { ic: string; label: string; href: string }[] = [
  { ic: "file-icons:telegram", label: "Telegram", href: "https://t.me/hostitevents" },
  { ic: "ri:twitter-x-fill", label: "X (Twitter)", href: "https://x.com/hostit_events" },
  { ic: "ri:github-fill", label: "GitHub", href: "https://github.com/hostit-events" },
  { ic: "ri:linkedin-fill", label: "LinkedIn", href: "https://www.linkedin.com/company/hostit-events" },
];

const HELP_WITH = [
  "A ticket isn't showing in your wallet",
  "Adding a ticket to Apple Wallet or Google Wallet",
  "Refunds and event payouts",
  "Hosting, editing, or checking in attendees at an event",
];

export default function SupportPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center px-5 sm:px-8">
          <Link href="/" aria-label="HostIt home" className="inline-flex items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 24 }} />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-14 sm:px-8 sm:py-20">
        <p className="text-sm font-medium uppercase tracking-wider text-primary">Support</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">How can we help?</h1>
        <p className="mt-3 max-w-xl text-pretty text-muted-foreground">
          We&rsquo;re a small team and we read every message. Email us and we&rsquo;ll get back to you
          within <span className="text-foreground">1–2 business days</span>.
        </p>

        {/* Primary contact — email */}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="mt-8 flex items-center gap-4 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/60"
        >
          <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
            <Icon icon="ic:round-mail" size={24} />
          </span>
          <span className="min-w-0">
            <span className="block text-xs uppercase tracking-wide text-muted-foreground">Email us</span>
            <span className="block truncate text-lg font-semibold">{SUPPORT_EMAIL}</span>
          </span>
        </a>

        {/* What we help with */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Common things we help with
          </h2>
          <ul className="mt-4 space-y-2.5">
            {HELP_WITH.map((item) => (
              <li key={item} className="flex items-start gap-3 text-sm">
                <Icon icon="ph:check-circle-fill" size={18} className="mt-0.5 shrink-0 text-primary" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">
            Including your ticket or event link helps us answer faster.
          </p>
        </section>

        {/* Other channels */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Other ways to reach us
          </h2>
          <div className="mt-4 flex flex-wrap gap-3">
            {CHANNELS.map(({ ic, label, href }) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium transition-colors hover:border-primary/60"
              >
                <Icon icon={ic} size={18} />
                {label}
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 px-5 py-6 text-sm text-muted-foreground sm:px-8">
          <span>© 2026 HostIt, Inc.</span>
          <Link href="/" className="transition-colors hover:text-foreground">
            Back to HostIt
          </Link>
        </div>
      </footer>
    </div>
  );
}
