"use client";

import * as React from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Icon } from "@/components/Icon";
import { socialShareLinks } from "@/lib/share";
import { cn } from "@/lib/utils";

export interface SocialShareProps {
  /** Share copy — typically the event name. */
  title: string;
  /** Canonical shareable URL — build with `eventShareUrl(id)`. */
  url: string;
  /** Trigger style: an icon-only round button (hero overlay) or a labelled button. */
  variant?: "icon" | "button";
  className?: string;
}

const PLATFORM_ICON: Record<string, { icon: string; color: string }> = {
  x: { icon: "ri:twitter-x-fill", color: "bg-black text-white" },
  farcaster: { icon: "simple-icons:farcaster", color: "bg-purple-600 text-white" },
  lens: { icon: "simple-icons:lens", color: "bg-emerald-500 text-black" },
};

/**
 * Share-to-social control. A Popover listing X / Farcaster / Lens compose-intent
 * links (built from the REAL shareable URL via `socialShareLinks`) plus a
 * "Copy link" action that writes the canonical URL to the clipboard and confirms
 * with a `sonner` toast — mirroring the clipboard pattern used in DoorScreen /
 * EventManageScreen.
 */
export function SocialShare({ title, url, variant = "icon", className }: SocialShareProps) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const platforms = socialShareLinks(title, url);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — link stays visible in the share targets */
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === "icon" ? (
          <button
            type="button"
            aria-label="Share event"
            className={cn(
              "grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/35 text-white backdrop-blur transition-colors hover:bg-black/55",
              className,
            )}
          >
            <Icon icon="mdi:share-variant" size={16} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Share event"
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              className,
            )}
          >
            <Icon icon="mdi:share-variant" size={15} /> Share
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <p className="px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Share to
        </p>
        <div className="flex flex-col gap-0.5">
          {platforms.map((p) => {
            const pi = PLATFORM_ICON[p.id];
            return (
              <a
                key={p.id}
                href={p.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
                onClick={() => setOpen(false)}
              >
                <span className={cn("grid h-6 w-6 place-items-center rounded-md", pi.color)}>
                  <Icon icon={pi.icon} size={13} />
                </span>
                <span className="flex-1">{p.label}</span>
              </a>
            );
          })}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-muted">
              {copied ? (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="text-emerald-500">
                  <Icon icon="ic:round-check" size={14} />
                </motion.span>
              ) : (
                <Icon icon="mdi:link-variant" size={14} />
              )}
            </span>
            <span className="flex-1">{copied ? "Copied!" : "Copy link"}</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
