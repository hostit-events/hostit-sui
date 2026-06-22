"use client";

// Route-group error boundary for every (app) screen. Without this, an uncaught
// render/runtime error (e.g. BigInt() on malformed on-chain data) fell through to
// Next's bare error overlay with no in-app recovery. Renders inside the (app)
// layout, so the Header/Footer/nav stay put.

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/Icon";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center screen-in">
      <span className="text-destructive">
        <Icon icon="ic:round-error-outline" size={42} />
      </span>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This screen hit an unexpected error. You can try again, or head back to Discover.
        {error?.digest ? ` (ref: ${error.digest})` : ""}
      </p>
      <div className="flex items-center gap-2 pt-1">
        <Button onClick={reset}>
          <Icon icon="ic:round-refresh" size={16} /> Try again
        </Button>
        <Button variant="outline" asChild>
          <Link href="/discover">
            <Icon icon="ic:round-explore" size={16} /> Discover
          </Link>
        </Button>
      </div>
    </div>
  );
}
