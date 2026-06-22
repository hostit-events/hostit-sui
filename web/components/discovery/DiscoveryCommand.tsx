"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useDiscoverEvents } from "@/lib/events";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import { CommandPalette } from "./CommandPalette";
import { CalendarViewDialog } from "./CalendarViewDialog";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

/** Custom DOM event other components dispatch to open the palette (Header button,
 *  mobile search affordance) without prop drilling through the layout. */
export const OPEN_COMMAND_EVENT = "hostit:open-command";

/** Dispatch from anywhere (e.g. the Header Cmd+K button) to open the palette. */
export function openCommandPalette() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_COMMAND_EVENT));
}

/**
 * App-level discovery command island: mounts the Cmd+K command palette, the
 * calendar dialog, the shortcuts help, and the global keyboard-shortcut listener
 * ONCE in the route-group layout. Self-contained — feeds itself from
 * `useDiscoverEvents()` (real on-chain reads) and navigates via the router. Does
 * not depend on any Header slot.
 */
export function DiscoveryCommand() {
  const router = useRouter();
  const { events, isLoading: eventsLoading } = useDiscoverEvents();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener(OPEN_COMMAND_EVENT, open);
    return () => window.removeEventListener(OPEN_COMMAND_EVENT, open);
  }, []);

  const focusSearch = useCallback(() => {
    const el = document.getElementById("discover-search");
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    } else {
      router.push("/discover");
    }
  }, [router]);

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen((v) => !v),
    onFocusSearch: focusSearch,
    onGoDiscover: () => router.push("/discover"),
    onGoTickets: () => router.push("/wallet"),
    onGoDashboard: () => router.push("/dashboard"),
    onCreateEvent: () => router.push("/create"),
    onShowHelp: () => setHelpOpen(true),
  });

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        events={events}
        eventsLoading={eventsLoading}
        onAction={(action) => {
          switch (action) {
            case "discover":
              router.push("/discover");
              break;
            case "tickets":
              router.push("/wallet");
              break;
            case "dashboard":
              router.push("/dashboard");
              break;
            case "create":
              router.push("/create");
              break;
            case "settings":
              router.push("/settings");
              break;
            case "calendar":
              setCalendarOpen(true);
              break;
            case "shortcuts":
              setHelpOpen(true);
              break;
          }
        }}
        onSelectEvent={(id) => router.push(`/event/${id}`)}
      />
      <CalendarViewDialog open={calendarOpen} onOpenChange={setCalendarOpen} events={events} />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}
