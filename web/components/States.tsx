import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared async-surface states. Promoted out of WalletScreen so every screen
 * renders one consistent empty/error treatment instead of hand-rolling them
 * (the audit found ~12 surfaces that swallowed errors into a blank/empty).
 */

/** Centered empty state — icon + title + optional body + optional CTA. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon: string;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={cn("flex flex-col items-center gap-2 p-10 text-center", className)}
      role="status"
      aria-live="polite"
    >
      <span className="text-muted-foreground">
        <Icon icon={icon} size={38} />
      </span>
      <div className="text-base font-semibold">{title}</div>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action && <div className="pt-1">{action}</div>}
    </Card>
  );
}

/**
 * Standard query-error card with a Retry. Use wherever a fetch can fail so a
 * transient RPC/Walrus blip surfaces as a recoverable error instead of being
 * mistaken for "empty".
 */
export function ErrorState({
  title = "Couldn't load this",
  body = "Something went wrong reading on-chain data. This is usually transient.",
  onRetry,
  retryLabel = "Retry",
  className,
}: {
  title?: string;
  body?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <Card
      className={cn("flex flex-col items-center gap-2 p-8 text-center", className)}
      role="alert"
    >
      <span className="text-destructive">
        <Icon icon="ic:round-error-outline" size={34} />
      </span>
      <div className="text-base font-semibold">{title}</div>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          <Icon icon="ic:round-refresh" size={15} /> {retryLabel}
        </Button>
      )}
    </Card>
  );
}
