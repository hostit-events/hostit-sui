"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icon";

/**
 * Native-app-style bottom navigation for mobile (hidden on md+, where the top
 * Header takes over). Center is an elevated "+" FAB to create an event.
 */
const TABS = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "Tickets", icon: "ion:ticket" },
  { href: "/create", label: "Create", icon: "ic:round-add", fab: true },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
  { href: "/settings", label: "Account", icon: "ic:round-person" },
] as const;

export function MobileTabBar() {
  const pathname = usePathname() || "/";
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <nav className="mtabbar md:hidden" aria-label="Primary">
      {TABS.map((t) =>
        "fab" in t && t.fab ? (
          <Link key={t.href} href={t.href} className="mtab-fab" aria-label="Create event">
            <Icon icon={t.icon} size={26} />
          </Link>
        ) : (
          <Link
            key={t.href}
            href={t.href}
            className={`mtab ${isActive(t.href) ? "active" : ""}`}
            aria-current={isActive(t.href) ? "page" : undefined}
          >
            <Icon icon={t.icon} size={22} />
            <span>{t.label}</span>
          </Link>
        ),
      )}
    </nav>
  );
}
