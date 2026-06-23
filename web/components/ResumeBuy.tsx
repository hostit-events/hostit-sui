"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BuyTicketDialog, type BuyPayload } from "@/components/BuyTicketDialog";
import { takePendingBuy, setBuyResuming } from "@/lib/pendingBuy";
import { useCurrentAccount } from "@/lib/hooks";

/**
 * Resume a purchase after the Google (Enoki zkLogin) sign-in full-page redirect.
 *
 * BuyTicketDialog stashes its payload before redirecting (`stashPendingBuy`);
 * the redirect destroys this dialog's React state, so when the buyer lands back
 * on the app WITH a connected account we re-open the buy dialog for the same
 * event. The dialog inits to its "review" step when an address is present, so
 * the purchase continues where it left off instead of resetting to the feed.
 *
 * Mounted once in the (app) layout, so it covers every entry point that opens a
 * buy dialog (discover card, quick-view modal, event page). It consumes the
 * stash one-shot, so it fires at most once per round-trip.
 */
export function ResumeBuy() {
  const addr = useCurrentAccount()?.address ?? null;
  const queryClient = useQueryClient();
  const [payload, setPayload] = React.useState<BuyPayload | null>(null);

  React.useEffect(() => {
    // Wait until an account is attached (the zkLogin session hydrates in /auth
    // just before bouncing here). takePendingBuy is one-shot + TTL-bounded.
    if (!addr || payload) return;
    const pending = takePendingBuy();
    if (pending) setPayload(pending);
  }, [addr, payload]);

  // While a resumed buy is on screen, signal sibling prompts (ProfileGate) to
  // yield so we don't stack two modals; clear on close/unmount so the email
  // prompt can surface afterward.
  React.useEffect(() => {
    if (!payload) return;
    setBuyResuming(true);
    return () => setBuyResuming(false);
  }, [payload]);

  if (!payload) return null;

  return (
    <BuyTicketDialog
      open
      onOpenChange={(v) => {
        if (!v) setPayload(null);
      }}
      payload={payload}
      onSuccess={() =>
        queryClient.invalidateQueries({
          queryKey: ["getObject", { id: payload.eventId, options: { showContent: true } }],
        })
      }
    />
  );
}
