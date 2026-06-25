"use client";

import { useState } from "react";
import { NETWORK } from "@/lib/config";
import { cn } from "@/lib/utils";

/**
 * Mobile-visible network indicator. The app defaults to Sui testnet (see
 * lib/config.ts NETWORK), so tickets and payments move TEST coins, not real
 * money. It announces that and stays until the user dismisses it (✕).
 *
 * NO auto-hide timer: the banner sits ABOVE the `sticky top-0` Header in normal
 * flow, so collapsing it shifts the whole header up by its height. A blind 6s
 * auto-collapse made the header visibly jump ~6s after load ("header not
 * stable"). A user-initiated dismiss is fine (expected, CLS-exempt). Hidden
 * entirely on mainnet, so no edit when the env flips to production.
 */
export function TestnetBanner() {
  const [visible, setVisible] = useState(true);

  if (NETWORK === "mainnet") return null;
  return (
    <div
      role="status"
      aria-hidden={!visible}
      className={cn(
        "relative overflow-hidden border-b border-amber-500/20 bg-amber-500/10 px-9 text-center font-mono text-xs text-amber-200/90 transition-[max-height,opacity,padding] duration-500 ease-out",
        visible ? "max-h-24 py-1.5 opacity-100" : "max-h-0 border-b-0 py-0 opacity-0",
      )}
    >
      <span className="font-semibold uppercase tracking-wide">{NETWORK}</span>
      {" — 👋 Welcome! You're on Sui testnet, so everything runs on free test coins — no real money, explore freely. Need some? Grab test "}
      <a
        href="https://faucet.suilearn.io"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline underline-offset-2 hover:text-amber-100"
      >
        SUI
      </a>
      {" or "}
      <a
        href="https://faucet.circle.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline underline-offset-2 hover:text-amber-100"
      >
        USDC
      </a>
      {" — both free."}
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
