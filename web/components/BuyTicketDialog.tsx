"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ENOKI_ENABLED, EV_TICKET_MINTED, coinInfo, fmtAmount } from "@/lib/config";
import { buyManyTx, claimFreeManyTx, totalWithFee } from "@/lib/ticketing";
import { useCurrentAccount, useSignAndExecute, useSponsorAndExecute } from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

// The dapp-kit connect button is a window-touching web component — load it
// client-only (mirrors AuthScreen) so its polyfill isn't evaluated during SSR.
const ConnectButton = dynamic(
  () => import("@mysten/dapp-kit-react/ui").then((m) => m.ConnectButton),
  { ssr: false },
);

/**
 * What the dialog needs to render the steps and build the REAL transaction.
 * Event info ONLY — the recipient is the connected address read live inside the
 * dialog (so the connect step can run before any wallet is attached). A `free`
 * payload claims via `claimFreeManyTx`; a paid payload buys via `buyManyTx`
 * (the 3% platform fee is added on top by `totalWithFee`). `remaining` /
 * `maxPerUser` cap the quantity stepper (the on-chain caps are authoritative).
 */
export type BuyPayload =
  | {
      kind: "free";
      eventId: string;
      eventName: string;
      remaining?: bigint;
      maxPerUser?: bigint;
    }
  | {
      kind: "paid";
      eventId: string;
      eventName: string;
      coinType: string;
      priceUnits: bigint;
      remaining?: bigint;
      maxPerUser?: bigint;
    };

export interface BuyTicketDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  payload: BuyPayload | null;
  /** Called after a successful mint so the caller can refetch on-chain counters. */
  onSuccess?: () => void;
}

type Step = "connect" | "review" | "minting" | "done";

/** Hard ceiling on a single purchase regardless of on-chain caps (UX guardrail). */
const QTY_HARD_MAX = 10;

interface MintedTicketJson {
  serial: string | number;
  recipient: string;
}

/**
 * Pull minted serials out of the execute result. The direct
 * `useSignAndExecute` path requests `showEvents: true`, so a successful
 * buy/claim returns one `TicketMinted` event per ticket — we read `serial` from
 * each. The sponsored path returns only `{ digest }` (no events/effects), so we
 * fall back to the quantity the buyer requested for the count and show no
 * serials. The result is read defensively since the two paths differ in shape.
 */
function parseMintResult(out: unknown, requestedQty: number): { count: number; serials: number[] } {
  const r = out as {
    events?: Array<{ type: string; parsedJson?: unknown }> | null;
  } | null;
  const events = r?.events ?? [];
  const serials: number[] = [];
  for (const ev of events) {
    if (ev.type === EV_TICKET_MINTED && ev.parsedJson) {
      const p = ev.parsedJson as MintedTicketJson;
      const n = Number(p.serial);
      if (Number.isFinite(n)) serials.push(n);
    }
  }
  if (serials.length > 0) return { count: serials.length, serials: serials.sort((a, b) => a - b) };
  // No events surfaced (sponsored path): trust the requested quantity.
  return { count: Math.max(1, requestedQty), serials: [] };
}

/**
 * One cohesive purchase dialog: `connect → review → minting → done`. Mirrors the
 * reference prototype's animated, single-dialog morph but fixes its overflow bug
 * (every step fits via a scrollable body + a sticky footer) and wires the REAL
 * submit instead of a fake backend:
 *   - `connect`  — Google (Enoki zkLogin) + dapp-kit ConnectButton when no
 *                  address is attached; auto-advances to `review` the instant a
 *                  wallet connects (the reactive `useCurrentAccount`),
 *   - `review`   — quantity stepper (1..cap) + live total; builds the multi-mint
 *                  PTB on confirm,
 *   - `minting`  — the real `useSignAndExecute`/`useSponsorAndExecute` mutation
 *                  is in flight (sponsored when ENOKI_ENABLED),
 *   - `done`     — shows "N ticket(s) minted", the serial(s), and the tx via
 *                  <TxLink>; errors bounce back to `review` with `humanizeError`.
 *
 * Single source of submit logic: EventQuickViewModal, EventCard and
 * EventPageScreen all open THIS dialog rather than hand-rolling a `run()`.
 */
export function BuyTicketDialog({ open, onOpenChange, payload, onSuccess }: BuyTicketDialogProps) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();

  const [step, setStep] = React.useState<Step>("connect");
  const [qty, setQty] = React.useState(1);
  const [digest, setDigest] = React.useState<string>("");
  const [result, setResult] = React.useState<{ count: number; serials: number[] }>({
    count: 0,
    serials: [],
  });
  const [error, setError] = React.useState<string | null>(null);

  // Reset the wizard whenever it opens. Initial step depends on whether an
  // address is already attached (prototype's reset-on-open pattern).
  React.useEffect(() => {
    if (open) {
      setStep(addr ? "review" : "connect");
      setQty(1);
      setDigest("");
      setResult({ count: 0, serials: [] });
      setError(null);
    }
    // Only re-init on open toggles — not on every `addr` change (the effect
    // below handles a connect-while-open transition).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-advance: while parked on the connect step, the moment an address
  // appears (wallet popover connect — no navigation) glide into review.
  React.useEffect(() => {
    if (open && step === "connect" && addr) setStep("review");
  }, [open, step, addr]);

  if (!payload) return null;

  const isFree = payload.kind === "free";
  const ci = payload.kind === "paid" ? coinInfo(payload.coinType) : null;
  const unitTotal = payload.kind === "paid" ? totalWithFee(payload.priceUnits) : 0n;

  // Quantity cap: min(remaining, maxPerUser, hard max). Falls back to the hard
  // max when a bound is unknown. Always at least 1.
  const remCap = payload.remaining != null ? Number(payload.remaining) : QTY_HARD_MAX;
  const userCap = payload.maxPerUser != null ? Number(payload.maxPerUser) : QTY_HARD_MAX;
  const qtyMax = Math.max(1, Math.min(QTY_HARD_MAX, remCap, userCap));
  const safeQty = Math.min(qty, qtyMax);
  const grandTotal = unitTotal * BigInt(safeQty);
  const totalLabel = isFree
    ? "Free"
    : `${fmtAmount(grandTotal, ci!.decimals)} ${ci!.symbol}`;

  const titleByStep =
    step === "connect"
      ? "Connect to buy"
      : step === "minting"
        ? isFree
          ? "Claiming your ticket…"
          : "Minting your ticket…"
        : step === "done"
          ? "You're going! 🎉"
          : "Review your order";

  const shortAddr = addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
  // Where Google should bounce back to after sign-in (this exact event modal/page).
  const returnTo =
    typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined;

  async function handleConfirm() {
    if (!payload || !addr) return;
    setError(null);
    setStep("minting");
    try {
      const tx =
        payload.kind === "free"
          ? claimFreeManyTx({ eventId: payload.eventId, recipient: addr, quantity: safeQty })
          : buyManyTx({
              eventId: payload.eventId,
              coinType: payload.coinType,
              priceUnits: payload.priceUnits,
              recipient: addr,
              sponsored: ENOKI_ENABLED,
              quantity: safeQty,
            });
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
      setResult(parseMintResult(out, safeQty));
      setStep("done");
      toast.success(isFree ? "Ticket claimed" : "Ticket purchased", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
      onSuccess?.();
    } catch (e: unknown) {
      setError(humanizeError(e));
      setStep("review");
    }
  }

  const ticketWord = (n: number) => (n === 1 ? "ticket" : "tickets");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 p-5 pb-3">
          <DialogTitle>{titleByStep}</DialogTitle>
          <DialogDescription className="sr-only">
            Purchase or claim a ticket for {payload.eventName}.
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable body — guarantees no step ever clips; the footer is sticky. */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-2">
          {/* Event summary (always shown) */}
          <div className="rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-semibold leading-tight">{payload.eventName}</p>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {isFree
                  ? "Free claim"
                  : `Price ${fmtAmount(payload.priceUnits, ci!.decimals)} ${ci!.symbol}`}
              </span>
              {isFree && (
                <Badge variant="secondary" className="text-[10px]">
                  <Icon icon="ph:sparkle-fill" size={11} /> Free
                </Badge>
              )}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === "connect" && (
              <motion.div
                key="connect"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-3"
              >
                <p className="text-xs text-muted-foreground">
                  Sign in to mint your ticket on-chain. Pick how you’d like to connect.
                </p>

                {ENOKI_ENABLED && (
                  <div className="space-y-2">
                    <GoogleSignInButton
                      returnTo={returnTo}
                      style={{ width: "100%", justifyContent: "center", minHeight: 44 }}
                    />
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      or connect a wallet
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  </div>
                )}

                <div className="flex justify-center [&_button]:w-full">
                  <ConnectButton />
                </div>

                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon icon="ic:round-fingerprint" size={14} />
                  Self-custodial — HostIt never holds your keys.
                </p>
              </motion.div>
            )}

            {step === "review" && (
              <motion.div
                key="review"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-3"
              >
                {/* Connected wallet chip */}
                {shortAddr && (
                  <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Icon icon="ph:wallet-fill" size={14} /> Connected
                    </span>
                    <span className="mono">{shortAddr}</span>
                  </div>
                )}

                {/* Quantity stepper */}
                <div className="flex items-center justify-between rounded-xl border bg-muted/20 p-3">
                  <span className="text-sm font-medium">Quantity</span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Decrease quantity"
                      disabled={safeQty <= 1}
                      onClick={() => setQty((q) => Math.max(1, q - 1))}
                    >
                      <Icon icon="ic:round-remove" size={16} />
                    </Button>
                    <span className="mono w-8 text-center text-sm tabular-nums" aria-live="polite">
                      {safeQty}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      aria-label="Increase quantity"
                      disabled={safeQty >= qtyMax}
                      onClick={() => setQty((q) => Math.min(qtyMax, q + 1))}
                    >
                      <Icon icon="ic:round-add" size={16} />
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Up to {qtyMax} per wallet for this event.
                </p>

                {/* Order summary */}
                {!isFree && ci && (
                  <div className="space-y-1.5 rounded-xl border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        Ticket price × {safeQty}
                      </span>
                      <span>
                        {fmtAmount(payload.priceUnits * BigInt(safeQty), ci.decimals)} {ci.symbol}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Platform fee (3%)</span>
                      <span>
                        {fmtAmount(grandTotal - payload.priceUnits * BigInt(safeQty), ci.decimals)}{" "}
                        {ci.symbol}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-t pt-1.5 text-sm">
                      <span className="font-medium">Total</span>
                      <span className="font-semibold">{totalLabel}</span>
                    </div>
                  </div>
                )}

                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon icon="ph:sparkle-fill" size={12} />
                  You’ll receive {safeQty} {ticketWord(safeQty)}, minted on-chain to your address.
                </p>

                {error && (
                  <p role="alert" className="text-xs" style={{ color: "var(--color-danger)" }}>
                    {error}
                  </p>
                )}
              </motion.div>
            )}

            {step === "minting" && (
              <motion.div
                key="minting"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center justify-center gap-3 py-10 text-center"
              >
                <Icon icon="mdi:loading" size={32} className="animate-spin text-primary" />
                <p className="text-sm font-medium">
                  {isFree ? "Claiming your tickets…" : "Minting your tickets…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {ENOKI_ENABLED
                    ? "Confirming the sponsored transaction…"
                    : "Sign the transaction in your wallet."}
                </p>
              </motion.div>
            )}

            {step === "done" && (
              <motion.div
                key="done"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-3"
              >
                <div className="flex flex-col items-center gap-2 py-2 text-center">
                  <Icon icon="ic:round-check-circle" size={44} className="text-emerald-500" />
                  <p className="text-sm font-semibold">
                    {result.count} {ticketWord(result.count)} minted
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Show it at the door — your {ticketWord(result.count)} {result.count === 1 ? "is" : "are"} on-chain.
                  </p>
                </div>

                {result.serials.length > 0 && (
                  <div className="flex flex-wrap items-center justify-center gap-1.5">
                    {result.serials.map((s) => (
                      <Badge key={s} variant="secondary" className="mono text-[11px]">
                        #{s}
                      </Badge>
                    ))}
                  </div>
                )}

                {digest && (
                  <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                    <div className="mb-1 text-muted-foreground">Transaction</div>
                    <TxLink digest={digest} chars={64} className="mono break-all" />
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Sticky footer — Cancel / Mint / Done are ALWAYS visible. */}
        <DialogFooter className="m-0 shrink-0 rounded-none border-t">
          {step === "connect" && (
            <Button variant="ghost" className="ml-auto" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          {step === "review" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleConfirm}>
                <Icon icon="ion:ticket" size={15} />
                {isFree
                  ? `Claim ${safeQty} ${ticketWord(safeQty)}`
                  : `Mint ${safeQty} ${ticketWord(safeQty)} · ${totalLabel}`}
              </Button>
            </>
          )}
          {step === "minting" && (
            <Button className="ml-auto" disabled>
              <Icon icon="mdi:loading" size={15} className="animate-spin" /> Working…
            </Button>
          )}
          {step === "done" && (
            <Button className="ml-auto" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
