import { NETWORK, PACKAGE_ID, ENOKI_ENABLED } from "@/lib/config";

export function Footer() {
  return (
    <footer className="mt-10 hidden border-t md:block">
      <div className="mx-auto flex max-w-[1180px] flex-col justify-between gap-4 px-5 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:px-8">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-white.png" alt="HostIt" className="h-5 w-auto opacity-80" />
          <span>Events made easy</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
          <span>net {NETWORK}</span>
          <span className="opacity-40">·</span>
          <span>
            pkg {PACKAGE_ID.slice(0, 10)}…{PACKAGE_ID.slice(-4)}
          </span>
          <span className="opacity-40">·</span>
          <span className={ENOKI_ENABLED ? "text-foreground" : undefined}>
            {ENOKI_ENABLED ? "sponsored gas on" : "browser wallets"}
          </span>
        </div>
      </div>
    </footer>
  );
}
