"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { CopilotPanel, type CopilotEvent } from "@/components/screens/CopilotPanel";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Floating, always-accessible launcher for the event AI Co-pilot.
 *
 * Renders a fixed bottom-right FAB that toggles a Co-pilot surface:
 *  - Desktop (md+): a docked card anchored bottom-right, above the FAB.
 *  - Mobile (< md): a bottom sheet with a dim backdrop, sitting ABOVE the
 *    MobileTabBar (z-index 60) in z-order.
 *
 * The modal mechanics (overlay/backdrop, focus trap, scroll lock, Escape to
 * close, and focus restoration to the FAB) are provided by the shadcn <Sheet>
 * (Radix Dialog) shell — replacing the previously hand-rolled equivalents. Only
 * the surface's bespoke dual-mode positioning + layering is kept in scoped CSS.
 *
 * Layering (matches globals.css conventions — mtabbar=60, header=50):
 *  - FAB:                  z 70  (above the tab bar, below modal surfaces)
 *  - desktop card:         z 75
 *  - mobile backdrop+sheet: z 80 (covers the tab bar)
 *
 * Tab-bar clearance: the .mtabbar is ~64px tall (8px pad + 48px min-height +
 * 8px pad) plus the bottom safe-area inset, and its center create-FAB protrudes
 * ~16px above it. We anchor bottom-RIGHT (never over the centered create-FAB)
 * and lift the FAB's `bottom` above the bar on small screens via the
 * --cp-fab-bottom var; md+ resets it to a normal corner offset. The
 * CopilotPanel chat internals are reused verbatim — only the surfacing changes.
 */
export function CopilotLauncher({ event }: { event: CopilotEvent }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <style>{CP_LAUNCHER_CSS}</style>

      {/* Floating launcher FAB (bottom-right, clears the mobile tab bar). */}
      <SheetTrigger asChild>
        <Button
          type="button"
          className={`cp-fab ${open ? "is-open" : ""}`}
          aria-label="Open AI Co-pilot"
        >
          <span className="cp-fab-glow" aria-hidden="true" />
          <Icon
            icon={open ? "ic:round-close" : "solar:magic-stick-3-bold"}
            size={22}
            className="cp-fab-icon"
          />
          {!open && <span className="cp-fab-label">Co-pilot</span>}
        </Button>
      </SheetTrigger>

      {/* The Co-pilot surface: docked card on desktop, bottom sheet on mobile.
          We keep the bespoke cp-surface positioning/layering CSS and neutralize
          the Sheet's default side-anchored layout via the cp-surface override. */}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="cp-surface"
      >
        {/* Surface header with the close control. CopilotPanel keeps its own
            header (brand + "Grounded in …"); we add only a thin top bar with
            an accessible name + ✕ so we don't double up the brand title. */}
        <div className="cp-surface-head">
          <SheetTitle className="cp-surface-title">
            <Icon icon="ph:sparkle-fill" size={13} /> AI Co-pilot
          </SheetTitle>
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-cp-close
              className="cp-close"
              aria-label="Close AI Co-pilot"
            >
              <Icon icon="ic:round-close" size={18} />
            </Button>
          </SheetClose>
        </div>

        <div className="cp-surface-body">
          <CopilotPanel event={event} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Scoped styles. Uses only existing design tokens (--hi-blue, --card, --hair,
// --raise, --fg1/2/3, radii) — no new colors. The attention pulse/glow is gated
// behind prefers-reduced-motion.
const CP_LAUNCHER_CSS = `
:root {
  /* Bottom offset for the FAB. On mobile it must clear the .mtabbar
     (~64px + safe-area) plus the protruding center create-FAB (~16px). */
  --cp-fab-bottom: calc(72px + env(safe-area-inset-bottom, 0px) + 14px);
  --cp-fab-right: 16px;
}
@media (min-width: 768px) {
  :root { --cp-fab-bottom: 24px; --cp-fab-right: 24px; }
}

.cp-fab {
  position: fixed;
  bottom: var(--cp-fab-bottom);
  right: var(--cp-fab-right);
  z-index: 70;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 16px;
  border-radius: 50px;
  border: 1px solid transparent;
  background: var(--hi-blue);
  color: #fff;
  font-family: var(--font-sans);
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.01em;
  line-height: 1;
  box-shadow: 0 8px 22px rgba(0, 124, 250, .45), 0 2px 0 0 rgba(0, 0, 0, .25);
  transition: transform .16s cubic-bezier(.2,.7,.3,1), background .16s ease, box-shadow .16s ease;
}
.cp-fab:hover { background: var(--hi-blue-hover); transform: translateY(-2px); box-shadow: 0 12px 28px rgba(0, 124, 250, .55), 0 2px 0 0 rgba(0, 0, 0, .25); }
.cp-fab:active { transform: translateY(0) scale(.96); box-shadow: 0 4px 14px rgba(0, 124, 250, .4); }
.cp-fab.is-open { background: var(--raise); border-color: var(--hair-2); box-shadow: 0 8px 22px rgba(0, 0, 0, .45); }
.cp-fab.is-open:hover { background: var(--card-2); }
.cp-fab-icon { position: relative; z-index: 1; }
/* The text label is desktop-only; on mobile the FAB is a compact circle. */
.cp-fab-label { position: relative; z-index: 1; display: none; white-space: nowrap; }
@media (min-width: 768px) { .cp-fab-label { display: inline; } }
/* On mobile, collapse the pill to a circle when showing only the icon. */
@media (max-width: 767px) {
  .cp-fab { width: 52px; padding: 0; justify-content: center; }
}

/* Subtle attention affordance: a soft pulsing glow ring behind the FAB. */
.cp-fab-glow {
  position: absolute;
  inset: -3px;
  border-radius: 50px;
  background: var(--hi-blue);
  opacity: .35;
  z-index: 0;
  pointer-events: none;
  animation: cpFabPulse 2.8s ease-in-out infinite;
}
.cp-fab.is-open .cp-fab-glow { display: none; }
@keyframes cpFabPulse {
  0%, 100% { transform: scale(1); opacity: .28; }
  50% { transform: scale(1.18); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .cp-fab-glow { animation: none; opacity: .22; }
  .cp-fab, .cp-fab:hover, .cp-fab:active { transition: background .16s ease; transform: none; }
}

/* ---- Surface frame ---- */
/* Neutralize the Sheet's default side-anchored layout so our bespoke
   dual-mode placement (docked card on md+, bottom sheet on < md) wins. */
.cp-surface {
  position: fixed;
  inset: auto;
  z-index: 75;
  display: flex;
  flex-direction: column;
  width: auto;
  max-width: none;
  height: auto;
  background: var(--brand-card);
  border: 1px solid var(--hair);
  overflow: hidden;
}

/* ---- Desktop docked card (md+) ---- */
@media (min-width: 768px) {
  .cp-surface {
    right: var(--cp-fab-right);
    /* Sit just above the FAB (FAB height 52 + offset + gap). */
    bottom: calc(var(--cp-fab-bottom) + 52px + 14px);
    width: min(92vw, 400px);
    height: min(72vh, 600px);
    border-radius: 16px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, .55), 0 0 0 1px var(--hair);
  }
}

/* ---- Mobile bottom sheet (< md) ---- */
@media (max-width: 767px) {
  .cp-surface {
    z-index: 81; /* above the overlay (50) and the tab bar (60) */
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-width: 100%;
    height: 88vh;
    height: 88dvh;
    border-radius: 18px 18px 0 0;
    border-bottom: none;
    box-shadow: 0 -16px 40px rgba(0, 0, 0, .5);
  }
}

.cp-surface-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--hair);
  flex: none;
}
.cp-surface-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--fg3);
}
.cp-surface-title iconify-icon { color: var(--hi-blue); }
.cp-close {
  color: var(--fg2);
}

/* The body hosts the reused CopilotPanel. We strip the panel's own border/radius
   so it fills the surface cleanly (the surface already provides the frame). */
.cp-surface-body { flex: 1; min-height: 0; display: flex; }
.cp-surface-body > .panel {
  flex: 1;
  /* CopilotPanel hard-codes an inline minHeight:480 which can clip inside the
     88dvh mobile sheet; defeat it here so the panel shrinks to its surface. */
  min-height: 0 !important;
  border: none;
  border-radius: 0;
  background: transparent;
}
`;
