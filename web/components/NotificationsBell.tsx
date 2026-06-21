"use client";

import * as React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bell, Rocket, Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import {
  useNotifications,
  type AppNotification,
  type NotificationType,
} from "@/lib/notifications";

const TYPE_META: Record<
  NotificationType,
  { icon: React.ElementType; accent: string; bg: string }
> = {
  purchase: {
    icon: Ticket,
    accent: "text-emerald-400",
    bg: "bg-emerald-500/15",
  },
  publish: {
    icon: Rocket,
    accent: "text-fuchsia-400",
    bg: "bg-fuchsia-500/15",
  },
  reminder: {
    icon: Bell,
    accent: "text-amber-400",
    bg: "bg-amber-500/15",
  },
};

export function formatAgo(ts: number): string {
  if (!ts) return "recently";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export interface NotificationsBellProps {
  notifications: AppNotification[];
  unread: number;
  onMarkAllRead: () => void;
  onClear: () => void;
  onDismiss: (id: string) => void;
}

/**
 * Pure UI: the bell trigger + popover inbox. Ported from the prototype's
 * notifications-bell.tsx (shadcn Popover/Button/Badge/ScrollArea + motion),
 * decoupled from any data source — it only takes an AppNotification[] + handlers.
 * The data is supplied by {@link NotificationsBellContainer} via useNotifications.
 */
export function NotificationsBell({
  notifications,
  unread,
  onMarkAllRead,
  onClear,
  onDismiss,
}: NotificationsBellProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-full border border-border/60 bg-card/40 backdrop-blur transition-colors hover:bg-accent"
          aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        >
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <motion.span
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 15 }}
              className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white"
            >
              {unread > 9 ? "9+" : unread}
            </motion.span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 rounded-2xl border-border/60 bg-card/95 p-0 backdrop-blur"
        align="end"
      >
        <div className="flex items-center justify-between border-b border-border/60 p-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4" />
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <Badge
                variant="secondary"
                className="h-5 min-w-5 justify-center rounded-full bg-rose-500/15 px-1.5 text-[10px] font-medium text-rose-300"
              >
                {unread}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {unread > 0 && (
              <button
                type="button"
                onClick={onMarkAllRead}
                className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Mark all read
              </button>
            )}
            {notifications.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <ScrollArea className="max-h-80">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <div className="grid h-10 w-10 place-items-center rounded-full bg-muted/40">
                <Bell className="h-4 w-4 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">
                You&apos;re all caught up.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/40">
              <AnimatePresence initial={false}>
                {notifications.map((n) => {
                  const meta = TYPE_META[n.type];
                  const ItemIcon = meta.icon;
                  return (
                    <motion.li
                      key={n.id}
                      layout
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10, height: 0 }}
                      className={cn(
                        "group relative flex items-start gap-2.5 p-3 transition-colors hover:bg-accent/30",
                        !n.read && "bg-primary/5",
                      )}
                    >
                      <div
                        className={cn(
                          "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                          meta.bg,
                        )}
                      >
                        <ItemIcon className={cn("h-3.5 w-3.5", meta.accent)} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="min-w-0 break-words text-xs font-medium leading-tight">
                            {n.title}
                          </p>
                          {!n.read && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground">
                          {n.description}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          {formatAgo(n.timestamp)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => onDismiss(n.id)}
                        aria-label="Dismiss notification"
                        className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                      >
                        <Icon icon="ic:round-close" size={12} />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Self-contained container wired to the on-chain-derived inbox. Renders nothing
 * when signed out (no account → empty feed and no bell). Mounted into Header's
 * notifications slot.
 */
export function NotificationsBellContainer() {
  const { notifications, unread, isSignedIn, dismiss, markAllRead, clear } =
    useNotifications();
  // Signed out → no bell at all to keep the chrome clean. When signed in the bell
  // shows even with an empty feed (opens to the "all caught up" state).
  if (!isSignedIn) {
    return null;
  }
  return (
    <NotificationsBell
      notifications={notifications}
      unread={unread}
      onMarkAllRead={markAllRead}
      onClear={clear}
      onDismiss={dismiss}
    />
  );
}
