"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { AuthControl } from "./AuthControl";
import { NotificationsBellContainer } from "./NotificationsBell";
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
 * Three zones, like a modern app shell: [logo + nav] · [centered search] ·
 * [actions]. The search is a command-palette trigger styled as an input,
 * absolutely centered at lg+ (so it stays centered regardless of the left/right
 * cluster widths); below lg it collapses to a search icon button in the right
 * cluster. Right cluster: Create event, Settings, the notifications bell (#59),
 * the optional injection seams, then AuthControl.
 *
 * `notificationsSlot` / `userAvatarSlot` are optional ReactNode seams so callers
 * can inject extra notifications/avatar UI without the Header importing those
 * components.
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
      <div className="relative mx-auto flex h-14 max-w-[1340px] items-center gap-2 px-4 sm:px-6">
        {/* Left: logo + primary nav */}
        <div className="flex items-center gap-1">
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
        </div>

        {/* Center: search bar — absolutely centered (lg+). The wrapper ignores
            pointer events so it never blocks the left/right clusters; only the
            button itself is interactive. */}
        <div className="pointer-events-none absolute left-1/2 hidden w-full max-w-md -translate-x-1/2 px-4 lg:block">
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label="Search events and commands"
            className="pointer-events-auto flex w-full items-center gap-2 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            <Icon icon="ic:round-search" size={16} />
            <span>Search events…</span>
            <kbd className="ml-auto font-mono text-[11px] opacity-70">⌘K</kbd>
          </button>
        </div>

        {/* Right: actions */}
        <div className="ml-auto flex items-center gap-2">
          {/* search fallback below lg, where the centered bar is hidden */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                onClick={openCommandPalette}
                aria-label="Search"
                className="text-muted-foreground lg:hidden"
              >
                <Icon icon="ic:round-search" size={15} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search &amp; commands (⌘K)</TooltipContent>
          </Tooltip>
          <Button asChild size="sm">
            <Link href="/create" aria-label="Create event">
              <Icon icon="ic:round-add" size={16} />
              <span className="hidden lg:inline">Create event</span>
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
          {/* notifications bell — on-chain-derived inbox (renders nothing signed out) */}
          <NotificationsBellContainer />
          {notificationsSlot}
          {userAvatarSlot}
          <AuthControl />
        </div>
      </div>
    </header>
  );
}
