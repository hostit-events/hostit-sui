"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthControl } from "./AuthControl";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NAV = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "My tickets", icon: "ion:ticket" },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
];

export function Header() {
  const pathname = usePathname() || "/";
  return (
    <header
      className="hidden md:block sticky top-0 z-50"
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
        <nav className="hidden md:flex items-center gap-1" aria-label="Primary">
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
          <Button asChild size="sm">
            <Link href="/create" aria-label="Create event">
              <Icon icon="ic:round-add" size={16} />
              <span className="hidden sm:inline">Create event</span>
            </Link>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="outline" size="sm">
                <Link href="/settings" aria-label="Settings">
                  <Icon icon="ic:round-settings" size={18} />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <AuthControl />
        </div>
      </div>
    </header>
  );
}
