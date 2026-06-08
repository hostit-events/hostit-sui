"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { getDAppKit } from "@/lib/dapp-kit";
import { ENOKI_API_KEY } from "@/lib/config";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  const [dAppKit] = useState(() => getDAppKit());
  return (
    <QueryClientProvider client={qc}>
      {/* EnokiFlow powers Google zkLogin via a full-page redirect. Always
          mounted (even with an empty key when Enoki is off) so the zkLogin
          hooks have a provider; the Google entry points are gated on
          ENOKI_ENABLED. */}
      <EnokiFlowProvider apiKey={ENOKI_API_KEY}>
        <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
      </EnokiFlowProvider>
    </QueryClientProvider>
  );
}
