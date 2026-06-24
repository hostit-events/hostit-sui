"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { type DiscoverEvent } from "@/lib/discovery";
import { coinInfo, fmtAmount } from "@/lib/config";

type Action = "discover" | "tickets" | "dashboard" | "create" | "calendar" | "shortcuts" | "settings";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  group: "navigation" | "actions" | "events";
  keywords?: string;
  run: () => void;
  emoji?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  events: DiscoverEvent[];
  /** True while the on-chain event feed is still streaming — shows a loading hint
   *  instead of "No results" when no events have arrived yet. */
  eventsLoading?: boolean;
  onAction: (action: Action) => void;
  onSelectEvent: (eventId: string) => void;
}

function eventHint(e: DiscoverEvent): string {
  const parts: string[] = [];
  if (e.city) parts.push(e.city);
  if (e.isFree) parts.push("Free");
  else if (e.priceUnits !== undefined && e.coinType !== undefined) {
    const ci = coinInfo(e.coinType);
    parts.push(`${fmtAmount(e.priceUnits, ci.decimals)} ${ci.symbol}`);
  }
  return parts.join(" · ");
}

export function CommandPalette({
  open,
  onOpenChange,
  events,
  eventsLoading = false,
  onAction,
  onSelectEvent,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const commands: CommandItem[] = useMemo(() => {
    const base: CommandItem[] = [
      {
        id: "nav-discover",
        label: "Go to Discover",
        hint: "Browse all events",
        icon: "ic:round-explore",
        group: "navigation",
        keywords: "home events grid browse",
        run: () => onAction("discover"),
      },
      {
        id: "nav-tickets",
        label: "My tickets",
        hint: "Your tickets & POAPs",
        icon: "ion:ticket",
        group: "navigation",
        keywords: "poap nft wallet purchased",
        run: () => onAction("tickets"),
      },
      {
        id: "nav-dashboard",
        label: "Dashboard",
        hint: "Organizer analytics",
        icon: "material-symbols-light:analytics-rounded",
        group: "navigation",
        keywords: "analytics stats revenue chart",
        run: () => onAction("dashboard"),
      },
      {
        id: "act-create",
        label: "Create event",
        hint: "Publish a new event",
        icon: "ic:round-add",
        group: "actions",
        keywords: "new publish form host",
        run: () => onAction("create"),
      },
      {
        id: "act-calendar",
        label: "Calendar view",
        hint: "Events by month",
        icon: "proicons:calendar",
        group: "actions",
        keywords: "calendar month dates schedule",
        run: () => onAction("calendar"),
      },
      {
        id: "nav-settings",
        label: "Settings",
        hint: "Account & preferences",
        icon: "ic:round-settings",
        group: "navigation",
        keywords: "account preferences profile notifications config",
        run: () => onAction("settings"),
      },
      {
        id: "act-shortcuts",
        label: "Keyboard shortcuts",
        hint: "Show help",
        icon: "ic:round-keyboard",
        group: "actions",
        keywords: "help keys ? shortcuts",
        run: () => onAction("shortcuts"),
      },
    ];
    const eventItems: CommandItem[] = events.slice(0, 20).map((e) => ({
      id: `evt-${e.eventId}`,
      label: e.name,
      hint: eventHint(e) || undefined,
      icon: "proicons:calendar",
      group: "events",
      keywords: `${e.category ?? ""} ${e.city ?? ""} ${e.organizer}`,
      emoji: e.isFree ? "🎟️" : "🎫",
      run: () => onSelectEvent(e.eventId),
    }));
    return [...base, ...eventItems];
  }, [events, onAction, onSelectEvent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.hint?.toLowerCase().includes(q) ||
        c.keywords?.toLowerCase().includes(q) ||
        c.group.includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[activeIndex];
        if (item) {
          item.run();
          onOpenChange(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, filtered, activeIndex, onOpenChange]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-cmd-idx="${activeIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const c of filtered) {
      const arr = map.get(c.group) ?? [];
      arr.push(c);
      map.set(c.group, arr);
    }
    return map;
  }, [filtered]);

  const groupLabels: Record<string, string> = {
    navigation: "Navigation",
    actions: "Actions",
    events: "Events",
  };
  const groupOrder = ["navigation", "actions", "events"];

  let flatIndex = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Anchor at top-[15vh] on all sizes (cancel the dialog's base
          -translate-y-1/2, else mobile pulls the tall palette up and clips the
          search). Raycast-wide on desktop — sm:max-w-2xl overrides the base
          sm:max-w-sm (384px); mobile keeps the base full-width-minus-margins. */}
      <DialogContent showCloseButton={false} className="top-[15vh] gap-0 overflow-hidden rounded-2xl p-0 translate-y-0 sm:max-w-2xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search commands and events. Use arrow keys to navigate, Enter to select.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b p-3">
          <Icon icon="ic:round-search" size={16} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, events, cities…"
            aria-label="Search commands"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
            ESC
          </kbd>
          {/* Esc has no touch equivalent, so keep a tap-to-close on mobile only;
              desktop closes via Esc (the hint above) — Raycast-style, no X. */}
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close search"
            className="grid size-11 sm:size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] hover:text-foreground active:scale-[0.96] sm:hidden"
          >
            <Icon icon="ic:round-close" size={18} />
          </button>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            eventsLoading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Icon
                  icon="svg-spinners:3-dots-fade"
                  size={24}
                  className="text-muted-foreground"
                />
                <p className="text-sm text-muted-foreground">Loading events…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Icon icon="ic:round-search" size={24} className="text-muted-foreground" />
                <p className="text-sm text-muted-foreground">No results for &ldquo;{query}&rdquo;</p>
              </div>
            )
          ) : (
            groupOrder.map((groupKey) => {
              const items = groups.get(groupKey);
              if (!items || items.length === 0) return null;
              return (
                <div key={groupKey} className="mb-1">
                  <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {groupLabels[groupKey]}
                  </p>
                  {items.map((item) => {
                    flatIndex += 1;
                    const idx = flatIndex;
                    const isActive = idx === activeIndex;
                    let leading: ReactNode;
                    if (item.emoji) leading = <span className="text-base">{item.emoji}</span>;
                    else leading = <Icon icon={item.icon} size={16} />;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-cmd-idx={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => {
                          item.run();
                          onOpenChange(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-[color,transform] active:scale-[0.98]",
                          isActive ? "bg-accent" : "hover:bg-accent/50",
                        )}
                      >
                        <div
                          className={cn(
                            "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                            isActive ? "bg-primary/15 text-primary" : "bg-muted/40 text-muted-foreground",
                          )}
                        >
                          {leading}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium leading-tight">{item.label}</p>
                          {item.hint && (
                            <p className="truncate text-[11px] text-muted-foreground">{item.hint}</p>
                          )}
                        </div>
                        {isActive && (
                          <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline">
                            ↵
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-card px-1 py-0.5 font-mono">↑↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border bg-card px-1 py-0.5 font-mono">↵</kbd>
              select
            </span>
            <span className="hidden items-center gap-1 sm:flex">
              <kbd className="rounded border bg-card px-1 py-0.5 font-mono">esc</kbd>
              close
            </span>
          </div>
          <span className="font-mono tabular-nums">{filtered.length} results</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
