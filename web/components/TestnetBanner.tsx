"use client";

import { useEffect, useState } from "react";
import { NETWORK } from "@/lib/config";
import { cn } from "@/lib/utils";

/** How long the banner stays before it auto-collapses (ms). */
const AUTO_HIDE_MS = 6000;

/**
 * Mobile-visible network indicator. The app defaults to Sui testnet (see
 * lib/config.ts NETWORK), so tickets and payments move TEST coins, not real
 * money. It announces that on load, then auto-collapses after a few seconds (or
 * immediately when the user dismisses it) so it doesn't permanently eat vertical
 * space. Auto-hides entirely on mainnet, so no edit is needed when the network
 * env flips to production.
 */
export function TestnetBanner() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (NETWORK === "mainnet") return;
    const t = setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, []);

  if (NETWORK === "mainnet") return null;
  return (
    <div
      role="status"
      aria-hidden={!visible}
      className={cn(
        "relative overflow-hidden border-b border-amber-500/20 bg-amber-500/10 px-9 text-center font-mono text-xs text-amber-200/90 transition-[max-height,opacity,padding] duration-500 ease-out",
        visible ? "max-h-10 py-1.5 opacity-100" : "max-h-0 border-b-0 py-0 opacity-0",
      )}
    >
      <span className="font-semibold uppercase tracking-wide">{NETWORK}</span>
      {" — tickets and payments use test coins"}
      <button
        type="button"
        onClick={() => setVisible(false)}
        aria-label="Dismiss testnet notice"
        className="absolute right-2 top-1/2 size-5 -translate-y-1/2 rounded leading-none text-amber-200/70 transition-colors hover:bg-amber-500/20 hover:text-amber-100"
      >
        ✕
      </button>
    </div>
  );
}
