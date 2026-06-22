import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Canonical screen header — one consistent title/sub treatment across every
 * screen (replaces the hand-rolled `<header><h1 className="page-title" style={{
 * fontSize: 34 }}>` blocks the audit found copy-pasted in Dashboard/Settings/
 * Manage/etc., each overriding the size inline). Drop the dead `.glow` blob with
 * it. `actions` renders right-aligned on the same baseline as the title.
 */
export function PageHeader({
  title,
  sub,
  actions,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="flex flex-none items-center gap-2">{actions}</div>}
    </header>
  );
}
