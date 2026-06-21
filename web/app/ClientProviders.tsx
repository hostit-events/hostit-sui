"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { getDAppKit } from "@/lib/dapp-kit";
import { ENOKI_API_KEY, ENOKI_SESSION_EPOCHS } from "@/lib/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { TurnstileGate } from "@/components/TurnstileGate";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            // One quick retry heals a single transient RPC/Walrus blip without
            // the default 3× exponential-backoff storm across the many
            // per-card/per-market queries on Discover. Per-query `retry: false`
            // (e.g. EventMarketsScreen) still wins over this default.
            retry: 1,
            retryDelay: 1000,
          },
        },
      }),
  );
  const [dAppKit] = useState(() => getDAppKit());
  return (
    <QueryClientProvider client={qc}>
      {/* EnokiFlow powers Google zkLogin via a full-page redirect. Always
          mounted (even with an empty key when Enoki is off) so the zkLogin
          hooks have a provider; the Google entry points are gated on
          ENOKI_ENABLED.

          additionalEpochs sets the zkLogin nonce's maxEpoch (= currentEpoch +
          ENOKI_SESSION_EPOCHS) AND the locally-stored session TTL, so the
          Google session lasts ~30 days on testnet (~24h epochs) instead of the
          short Enoki default. See ENOKI_SESSION_EPOCHS in lib/config.ts. */}
      <EnokiFlowProvider apiKey={ENOKI_API_KEY} additionalEpochs={ENOKI_SESSION_EPOCHS}>
        <DAppKitProvider dAppKit={dAppKit}>
          <TooltipProvider delayDuration={150}>{children}</TooltipProvider>
          <Toaster />
          {/* Anti-bot bot-wall for the gasless-sponsor + AI routes (#81). Renders
              nothing unless a Turnstile site key is configured. */}
          <TurnstileGate />
        </DAppKitProvider>
      </EnokiFlowProvider>
    </QueryClientProvider>
  );
}
