"use client";

import { useEffect, useRef } from "react";

export interface ShortcutDef {
  key: string;
  description: string;
  group: "navigation" | "actions";
}

// Live-only shortcuts. The prototype's `f` (favorites filter) and `d` (theme
// toggle) are dropped — those features don't exist in the live app (YAGNI).
export const SHORTCUTS: ShortcutDef[] = [
  { key: "⌘K", description: "Open command palette", group: "navigation" },
  { key: "/", description: "Focus search", group: "navigation" },
  { key: "g d", description: "Go to Discover", group: "navigation" },
  { key: "g t", description: "Go to My tickets", group: "navigation" },
  { key: "g a", description: "Go to Dashboard", group: "navigation" },
  { key: "c", description: "Create event", group: "actions" },
  { key: "?", description: "Show this help", group: "actions" },
  { key: "Esc", description: "Close dialog", group: "actions" },
];

export interface ShortcutHandlers {
  onCommandPalette: () => void;
  onFocusSearch: () => void;
  onGoDiscover: () => void;
  onGoTickets: () => void;
  onGoDashboard: () => void;
  onCreateEvent: () => void;
  onShowHelp: () => void;
}

/**
 * Register global keyboard shortcuts. Ignores keypresses while typing in an
 * input/textarea/select/contenteditable (except the Cmd+K combo, which always
 * opens the palette). Routes are the LIVE ones (tickets → /wallet via handler).
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const gPressedRef = useRef(false);
  const gTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      return el.isContentEditable;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl+K — open the command palette (works even while typing).
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        handlersRef.current.onCommandPalette();
        return;
      }

      // Esc handled natively by open dialogs; nothing to do.
      if (e.key === "Escape") return;

      const typing = isTypingTarget(e.target);

      // "g x" two-key sequences — only when not typing and no modifiers.
      if (!typing && (e.key === "g" || e.key === "G") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        gPressedRef.current = true;
        if (gTimeoutRef.current) clearTimeout(gTimeoutRef.current);
        gTimeoutRef.current = setTimeout(() => {
          gPressedRef.current = false;
        }, 700);
        return;
      }
      if (gPressedRef.current && !typing) {
        gPressedRef.current = false;
        if (gTimeoutRef.current) clearTimeout(gTimeoutRef.current);
        if (e.key === "d" || e.key === "D") {
          e.preventDefault();
          handlersRef.current.onGoDiscover();
          return;
        }
        if (e.key === "t" || e.key === "T") {
          e.preventDefault();
          handlersRef.current.onGoTickets();
          return;
        }
        if (e.key === "a" || e.key === "A") {
          e.preventDefault();
          handlersRef.current.onGoDashboard();
          return;
        }
        // unrecognised second key — fall through
      }

      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "/") {
        e.preventDefault();
        handlersRef.current.onFocusSearch();
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        handlersRef.current.onShowHelp();
        return;
      }
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        handlersRef.current.onCreateEvent();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
