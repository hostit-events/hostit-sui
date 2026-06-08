"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { getDAppKit } from "@/lib/dapp-kit";
import { EnokiWarmup } from "@/components/EnokiWarmup";

export function ClientProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient());
  const [dAppKit] = useState(() => getDAppKit());
  return (
    <QueryClientProvider client={qc}>
      <DAppKitProvider dAppKit={dAppKit}>
        <EnokiWarmup />
        {children}
      </DAppKitProvider>
    </QueryClientProvider>
  );
}
