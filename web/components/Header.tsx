"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthControl } from "./AuthControl";
import { Icon } from "./Icon";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "My tickets", icon: "ion:ticket" },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
];

export function Header() {
  const pathname = usePathname() || "/";
  return (
    <header className="sticky top-0 z-50 hidden border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:block">
      <div className="mx-auto flex h-14 max-w-[1340px] items-center gap-2 px-4 sm:px-6">
        <Link href="/" className="mr-1 flex flex-none items-center" aria-label="HostIt home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-white.png" alt="HostIt" className="block h-6 w-auto" />
        </Link>
        <nav className="hidden items-center gap-0.5 md:flex" aria-label="Primary">
          {NAV.map((n) => {
            const active = pathname === n.href || pathname.startsWith(n.href + "/");
            return (
              <Button
                key={n.href}
                asChild
                variant="ghost"
                size="sm"
                className={cn("text-muted-foreground", active && "bg-accent text-foreground")}
              >
                <Link href={n.href} aria-current={active ? "page" : undefined}>
                  <Icon icon={n.icon} size={16} />
                  {n.label}
                </Link>
              </Button>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm">
            <Link href="/create" aria-label="Create event">
              <Icon icon="ic:round-add" size={16} />
              <span className="hidden sm:inline">Create event</span>
            </Link>
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="outline" size="icon-sm">
                <Link href="/settings" aria-label="Settings">
                  <Icon icon="ic:round-settings" size={16} />
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
