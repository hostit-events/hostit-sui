import type { CSSProperties, ReactNode } from "react";
import { explorerTxUrl } from "@/lib/config";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Clickable transaction digest — opens the tx in the SuiVision explorer in a new
 * tab. Renders `{label} {short}…` by default; pass `before` for a leading icon
 * and `label` to change the prefix (e.g. "added · tx"). Keeps the caller's
 * `className`/`style` so each call site preserves its existing look.
 */
export function TxLink({
  digest,
  chars = 10,
  label = "tx",
  before,
  className,
  style,
}: {
  digest: string;
  chars?: number;
  label?: string;
  before?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  // Self-sufficient TooltipProvider: TxLink renders inside Sonner toast
  // descriptions (a portal outside the app-level TooltipProvider) and in tests,
  // and this repo's <Tooltip> (raw Radix Root) throws without a provider ancestor.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={explorerTxUrl(digest)}
            target="_blank"
            rel="noopener noreferrer"
            className={`tx-link${className ? ` ${className}` : ""}`}
            style={style}
          >
            {before}
            {label} {digest.slice(0, chars)}…
          </a>
        </TooltipTrigger>
        <TooltipContent>Open transaction in Sui explorer</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
