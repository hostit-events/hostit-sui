"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { Icon } from "./Icon";

const NAV = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "My tickets", icon: "ion:ticket" },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
];

export function Header() {
  const pathname = usePathname() || "/";
  return (
    <header
      className="sticky top-0 z-50"
      style={{
        background: "rgba(11,15,38,.82)",
        backdropFilter: "blur(16px) saturate(1.2)",
        WebkitBackdropFilter: "blur(16px) saturate(1.2)",
        borderBottom: "1px solid var(--hair)",
      }}
    >
      <div className="mx-auto max-w-[1340px] h-16 flex items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="flex items-center flex-none mr-1" aria-label="HostIt home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-white.png" alt="HostIt" style={{ height: 25, width: "auto", display: "block" }} />
        </Link>
        <nav className="hidden md:flex items-center gap-1">
          {NAV.map((n) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            return (
              <Link key={n.href} href={n.href} className={`topnav-item ${active ? "active" : ""}`}>
                <Icon icon={n.icon} size={17} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <Link href="/create" className="btn btn-primary btn-sm">
            <Icon icon="ic:round-add" size={16} />
            <span className="hidden sm:inline">Create event</span>
          </Link>
          <ConnectButton />
        </div>
      </div>
      {/* mobile nav */}
      <nav className="md:hidden flex items-center gap-1 px-3 pb-2 -mt-1 overflow-x-auto">
        {NAV.map((n) => {
          const active = pathname === n.href || pathname.startsWith(n.href + "/");
          return (
            <Link key={n.href} href={n.href} className={`topnav-item ${active ? "active" : ""}`}>
              <Icon icon={n.icon} size={16} />
              {n.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
