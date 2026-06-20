"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { AuthControl } from "./AuthControl";
import { Icon } from "./Icon";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openCommandPalette } from "@/components/discovery/DiscoveryCommand";

const NAV = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "My tickets", icon: "ion:ticket" },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
];

/**
 * App header (desktop only — mobile nav lives in MobileTabBar).
 *
 * `notificationsSlot` / `userAvatarSlot` are optional ReactNode seams so future
 * issues can inject a notifications bell / command palette / avatar without the
 * Header importing those components. They render nothing when unset and sit in
 * the right-side cluster; `AuthControl` stays the source of truth for sign-in.
 */
export function Header({
  notificationsSlot,
  userAvatarSlot,
}: {
  notificationsSlot?: ReactNode;
  userAvatarSlot?: ReactNode;
} = {}) {
  const pathname = usePathname() || "/";
  return (
    <header className="sticky top-0 z-50 hidden border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:block">
      <div className="mx-auto flex h-14 max-w-[1340px] items-center gap-2 px-4 sm:px-6">
        <Link href="/" className="mr-1 flex flex-none items-center" aria-label="HostIt home">
          <Logo size={24} />
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
                className={cn(
                  "relative text-muted-foreground",
                  active && "bg-accent text-foreground",
                )}
              >
                <Link href={n.href} aria-current={active ? "page" : undefined}>
                  <Icon icon={n.icon} size={16} />
                  {n.label}
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
                      transition={{ type: "spring", stiffness: 380, damping: 30 }}
                    />
                  )}
                </Link>
              </Button>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                onClick={openCommandPalette}
                aria-label="Open command palette"
                className="gap-1.5 text-muted-foreground"
              >
                <Icon icon="ic:round-search" size={15} />
                <kbd className="hidden font-mono text-[11px] lg:inline">⌘K</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search & commands (⌘K)</TooltipContent>
          </Tooltip>
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
          {notificationsSlot}
          {userAvatarSlot}
          <AuthControl />
        </div>
      </div>
    </header>
  );
}
