"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { getDAppKit } from "@/lib/dapp-kit";
import { ENOKI_API_KEY, ENOKI_SESSION_EPOCHS } from "@/lib/config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
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
        </DAppKitProvider>
      </EnokiFlowProvider>
    </QueryClientProvider>
  );
}
