import { Header } from "@/components/Header";
import { NETWORK, PACKAGE_ID, ENOKI_ENABLED } from "@/lib/config";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 py-8">{children}</main>
      <Footer />
    </>
  );
}

function Footer() {
  return (
    <footer style={{ borderTop: "1px solid var(--hair)" }} className="mt-10">
      <div className="mx-auto max-w-[1180px] px-5 sm:px-8 py-9 flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 22, width: "auto" }} />
          <span className="mono">Events made easy</span>
        </div>
        <div className="mono flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>net {NETWORK}</span>
          <span>·</span>
          <span>
            pkg {PACKAGE_ID.slice(0, 10)}…{PACKAGE_ID.slice(-4)}
          </span>
          <span>·</span>
          <span style={{ color: ENOKI_ENABLED ? "var(--hi-green)" : undefined }}>
            {ENOKI_ENABLED ? "sponsored gas on" : "browser wallets"}
          </span>
        </div>
      </div>
    </footer>
  );
}
