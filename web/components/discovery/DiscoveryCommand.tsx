"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useDiscoverEvents } from "@/lib/events";
import { useKeyboardShortcuts } from "@/lib/useKeyboardShortcuts";
import { CommandPalette } from "./CommandPalette";
import { CalendarViewDialog } from "./CalendarViewDialog";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

/** Custom DOM events other components dispatch to open the palette / calendar
 *  (Header buttons, mobile search affordance) without prop drilling through the
 *  layout. The calendar dialog lives here in the island, so the global Header
 *  opens it via this event rather than owning its own state. */
export const OPEN_COMMAND_EVENT = "hostit:open-command";
export const OPEN_CALENDAR_EVENT = "hostit:open-calendar";

/** Dispatch from anywhere (e.g. the Header Cmd+K button) to open the palette. */
export function openCommandPalette() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_COMMAND_EVENT));
}

/** Dispatch from anywhere (e.g. the Header Calendar button) to open the calendar. */
export function openCalendar() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_CALENDAR_EVENT));
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
    const openCmd = () => setPaletteOpen(true);
    const openCal = () => setCalendarOpen(true);
    window.addEventListener(OPEN_COMMAND_EVENT, openCmd);
    window.addEventListener(OPEN_CALENDAR_EVENT, openCal);
    return () => {
      window.removeEventListener(OPEN_COMMAND_EVENT, openCmd);
      window.removeEventListener(OPEN_CALENDAR_EVENT, openCal);
    };
  }, []);

  useKeyboardShortcuts({
    onCommandPalette: () => setPaletteOpen((v) => !v),
    // "/" — no inline search bar anymore, so open the command palette (search).
    onFocusSearch: () => setPaletteOpen(true),
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
