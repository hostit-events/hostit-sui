"use client";

import dynamic from "next/dynamic";

// dapp-kit + Enoki touch `window` / `document` at module load. Defer the
// whole providers tree to a client-only mount so Next's static prerender pass
// doesn't try to import the browser-only code.
const ClientProviders = dynamic(
  () => import("./ClientProviders").then((m) => m.ClientProviders),
  { ssr: false },
);

export function Providers({ children }: { children: React.ReactNode }) {
  return <ClientProviders>{children}</ClientProviders>;
}
