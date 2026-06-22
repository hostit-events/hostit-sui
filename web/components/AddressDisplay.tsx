"use client";

import { useDisplayName } from "@/lib/profile";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface AddressDisplayProps {
  address: string;
  /** How many trailing chars of the raw address to show in fallback. Default 6. */
  suffix?: number;
  /** Show a "verified" tick + tooltip when a suiNS name is found. Default true. */
  showBadge?: boolean;
  /** Render inline (default) or block. */
  className?: string;
}

/**
 * Renders a Sui address as a display name (GH#96): a provided profile username,
 * else the suiNS reverse name, else truncated hex.
 * - suiNS name:        `@dadadave.sui ✓` (verified badge — the trust signal)
 * - profile username:  `@alice` (NO badge — free-form, not a credential)
 * - neither:           `0xc856…c2d9` (truncated mono)
 *
 * The principle (see memory: project-permissionless-ux): suiNS is the v1 trust
 * signal for sui-ticket's permissionless protocol; a provided username is a
 * convenience and deliberately gets no verified tick.
 */
export function AddressDisplay({
  address,
  suffix = 6,
  showBadge = true,
  className = "",
}: AddressDisplayProps) {
  const { data: name, isLoading, isSuiNS } = useDisplayName(address);

  if (!address) {
    return <span className={`opacity-60 ${className}`}>—</span>;
  }

  if (isLoading) {
    return (
      <span className={`mono ${className}`}>
        {address.slice(0, 8)}…{address.slice(-suffix)}
      </span>
    );
  }

  if (name) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex items-center gap-1 ${className}`}>
            <span className="font-medium">@{name}</span>
            {showBadge && isSuiNS && (
              <Badge variant="secondary" className="px-1 py-0">
                <span aria-hidden="true">✓</span>
                <span className="sr-only">suiNS verified</span>
              </Badge>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {name} · {address}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`mono ${className}`}>
          {address.slice(0, 8)}…{address.slice(-suffix)}
        </span>
      </TooltipTrigger>
      <TooltipContent>{address}</TooltipContent>
    </Tooltip>
  );
}
