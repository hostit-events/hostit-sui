"use client";

import { useSuiNSName } from "@/lib/suins";

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
 * Renders a Sui address with suiNS reverse-lookup.
 * - With name:    `@dadadave.sui ✓` (verified badge)
 * - Without name: `0xc856…c2d9` (truncated mono)
 *
 * The principle (see memory: project-permissionless-ux): suiNS is the v1 trust
 * signal for sui-ticket's permissionless protocol. KYC tier ("super verified")
 * is reserved for v2 and would render as a second badge alongside this.
 */
export function AddressDisplay({
  address,
  suffix = 6,
  showBadge = true,
  className = "",
}: AddressDisplayProps) {
  const { data: name, isLoading } = useSuiNSName(address);

  if (!address) {
    return <span className={`opacity-60 ${className}`}>—</span>;
  }

  if (isLoading) {
    return (
      <span className={`mono opacity-60 ${className}`}>
        {address.slice(0, 8)}…{address.slice(-suffix)}
      </span>
    );
  }

  if (name) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${className}`}
        title={`${name} · ${address}`}
      >
        <span className="font-medium">@{name}</span>
        {showBadge && (
          <span className="text-[10px] text-[var(--color-verified)] inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[var(--color-verified)]/15">
            <span aria-hidden="true">✓</span>
            <span className="sr-only">suiNS verified</span>
          </span>
        )}
      </span>
    );
  }

  return (
    <span className={`mono ${className}`} title={address}>
      {address.slice(0, 8)}…{address.slice(-suffix)}
    </span>
  );
}
