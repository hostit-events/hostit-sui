"use client";

import { NETWORK } from "@/lib/config";

/**
 * Persistent, mobile-visible network indicator. The app defaults to Sui testnet
 * (see lib/config.ts NETWORK), so tickets and payments move TEST coins, not real
 * money — but the only existing signal (the footer's `net {NETWORK}`) is
 * desktop-only (`hidden … md:block`). This renders in the app shell on every
 * breakpoint and auto-hides on mainnet, so no edit is needed when the network
 * env flips to production.
 */
export function TestnetBanner() {
  if (NETWORK === "mainnet") return null;
  return (
    <div
      role="status"
      className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-center font-mono text-xs text-amber-200/90"
    >
      <span className="font-semibold uppercase tracking-wide">{NETWORK}</span>
      {" — tickets and payments use test coins"}
    </div>
  );
}
