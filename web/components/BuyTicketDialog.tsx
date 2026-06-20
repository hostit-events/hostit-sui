"use client";

import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { ENOKI_ENABLED, coinInfo, fmtAmount } from "@/lib/config";
import { buyTx, claimFreeTx, totalWithFee } from "@/lib/ticketing";
import { useSignAndExecute, useSponsorAndExecute } from "@/lib/hooks";
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

/**
 * What the dialog needs to build the REAL transaction + render the review step.
 * `recipient` is the connected address (zkLogin/Enoki or wallet). A `free`
 * payload claims via `claimFreeTx`; a paid payload buys via `buyTx` with the
 * given coin + base price (the 3% platform fee is added on top by `totalWithFee`).
 */
export type BuyPayload =
  | {
      kind: "free";
      eventId: string;
      eventName: string;
      recipient: string;
    }
  | {
      kind: "paid";
      eventId: string;
      eventName: string;
      coinType: string;
      priceUnits: bigint;
      recipient: string;
    };

export interface BuyTicketDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  payload: BuyPayload | null;
  /** Called after a successful mint so the caller can refetch on-chain counters. */
  onSuccess?: () => void;
}

type Step = "review" | "minting" | "done";

/**
 * Guided purchase stepper around the live app's REAL submission. Ports the
 * prototype's animated `review → minting → done` shell but drops its fake
 * backend (no `WALLETS`, no wallet-picker step — auth is zkLogin/Enoki via
 * AuthControl — and no `setTimeout`/random hash). Instead:
 *   - `review` builds `buyTx`/`claimFreeTx` from lib/ticketing on confirm,
 *   - `minting` while the real `useSignAndExecute`/`useSponsorAndExecute`
 *     mutation is in flight (sponsored when ENOKI_ENABLED),
 *   - `done` shows the real `digest` via <TxLink>; errors stay on `review`,
 *     surfaced with `humanizeError`.
 * Single source of submit logic: EventPageScreen and EventQuickViewModal open
 * THIS dialog instead of hand-rolling their own `run()`.
 */
export function BuyTicketDialog({ open, onOpenChange, payload, onSuccess }: BuyTicketDialogProps) {
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();

  const [step, setStep] = React.useState<Step>("review");
  const [digest, setDigest] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);

  // Reset the wizard whenever it opens (prototype's reset-on-open pattern).
  React.useEffect(() => {
    if (open) {
      setStep("review");
      setDigest("");
      setError(null);
    }
  }, [open]);

  if (!payload) return null;

  const isFree = payload.kind === "free";
  const ci = payload.kind === "paid" ? coinInfo(payload.coinType) : null;
  const total = payload.kind === "paid" ? totalWithFee(payload.priceUnits) : 0n;

  const titleByStep =
    step === "minting"
      ? isFree
        ? "Claiming your ticket…"
        : "Minting your ticket…"
      : step === "done"
        ? "You're going!"
        : isFree
          ? "Claim free ticket"
          : "Review your order";

  async function handleConfirm() {
    if (!payload) return;
    setError(null);
    setStep("minting");
    try {
      const tx =
        payload.kind === "free"
          ? claimFreeTx({ eventId: payload.eventId, recipient: payload.recipient })
          : buyTx({
              eventId: payload.eventId,
              coinType: payload.coinType,
              priceUnits: payload.priceUnits,
              recipient: payload.recipient,
              sponsored: ENOKI_ENABLED,
            });
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: payload.recipient })
        : await regular.mutateAsync({ transaction: tx });
      setDigest(out.digest);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="p-5 pb-0">
          <DialogTitle>{titleByStep}</DialogTitle>
          <DialogDescription className="sr-only">
            Purchase or claim a ticket for {payload.eventName}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 pb-1 pt-3">
          {/* Event summary (always shown) */}
          <div className="rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-semibold leading-tight">{payload.eventName}</p>
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {isFree ? "Free claim — one per wallet" : `Price ${fmtAmount(payload.priceUnits, ci!.decimals)} ${ci!.symbol}`}
              </span>
              {isFree && (
                <Badge variant="secondary" className="text-[10px]">
                  <Icon icon="ph:sparkle-fill" size={11} /> Free
                </Badge>
              )}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === "review" && (
              <motion.div
                key="review"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="space-y-3"
              >
                {!isFree && ci && (
                  <div className="space-y-1.5 rounded-xl border bg-muted/20 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Ticket price</span>
                      <span>
                        {fmtAmount(payload.priceUnits, ci.decimals)} {ci.symbol}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Platform fee (3%)</span>
                      <span>
                        {fmtAmount(total - payload.priceUnits, ci.decimals)} {ci.symbol}
                      </span>
                    </div>
                    <div className="flex items-center justify-between border-t pt-1.5 text-sm">
                      <span className="font-medium">Total</span>
                      <span className="font-semibold">
                        {fmtAmount(total, ci.decimals)} {ci.symbol}
                      </span>
                    </div>
                  </div>
                )}

                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Icon icon="ph:sparkle-fill" size={12} />
                  Your ticket is minted on-chain to your address.
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
                className="flex flex-col items-center justify-center gap-3 py-8 text-center"
              >
                <Icon icon="mdi:loading" size={32} className="animate-spin text-primary" />
                <p className="text-sm font-medium">
                  {isFree ? "Claiming your ticket…" : "Minting your ticket…"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {ENOKI_ENABLED
                    ? "Confirming the sponsored transaction…"
                    : "Approve the transaction to confirm."}
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
                  <Icon icon="ic:round-check-circle" size={40} className="text-emerald-500" />
                  <p className="text-sm font-medium">Ticket minted</p>
                  <p className="text-xs text-muted-foreground">
                    Show it at the door — your ticket is on-chain.
                  </p>
                </div>
                {digest && (
                  <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs">
                    <span className="text-muted-foreground">Transaction</span>
                    <TxLink digest={digest} chars={10} />
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <DialogFooter className="gap-2">
          {step === "review" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleConfirm}>
                <Icon icon="ion:ticket" size={15} />
                {isFree
                  ? "Claim free ticket"
                  : `Confirm · ${fmtAmount(total, ci!.decimals)} ${ci!.symbol}`}
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
