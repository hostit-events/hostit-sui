"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { CopilotPanel, type CopilotEvent } from "@/components/screens/CopilotPanel";

/**
 * Floating, always-accessible launcher for the event AI Co-pilot.
 *
 * Renders a fixed bottom-right FAB that toggles a Co-pilot surface:
 *  - Desktop (md+): a docked card anchored bottom-right, above the FAB.
 *  - Mobile (< md): a bottom sheet with a dim backdrop, sitting ABOVE the
 *    MobileTabBar (z-index 60) in z-order.
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
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether the surface has been opened at least once, so we only
  // restore focus to the FAB on a genuine close — never steal it on mount.
  const hasOpened = useRef(false);
  const uid = useId();
  const dialogId = `cp-dialog-${uid}`;
  const titleId = `cp-title-${uid}`;

  const close = useCallback(() => setOpen(false), []);

  // Escape closes (returning focus to the FAB) and Tab is trapped within the
  // dialog so focus can't escape to the page behind the modal surface.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const el = surfaceRef.current;
      if (!el) return;
      // Tabbable elements within the dialog, in DOM order.
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Cycle: wrap forward off the last element, backward off the first, and
      // pull focus back in if it has somehow drifted outside the dialog.
      if (e.shiftKey) {
        if (active === first || !el.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !el.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Move focus into the panel on open; restore to the FAB on close. While open,
  // lock background scroll (prevents the page behind the modal sheet from
  // scrolling) and restore the prior overflow on close/unmount.
  useEffect(() => {
    if (open) {
      hasOpened.current = true;
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      // Defer so the dialog has mounted.
      const t = window.setTimeout(() => {
        const el = surfaceRef.current;
        if (!el) return;
        const focusTarget =
          el.querySelector<HTMLElement>("[data-cp-close]") ??
          el.querySelector<HTMLElement>("input, button, [tabindex]");
        focusTarget?.focus();
      }, 0);
      return () => {
        window.clearTimeout(t);
        document.body.style.overflow = prevOverflow;
      };
    }
    // Return focus to the FAB only after a real close (not on initial mount).
    if (hasOpened.current) fabRef.current?.focus();
  }, [open]);

  return (
    <>
      <style>{CP_LAUNCHER_CSS}</style>

      {/* Floating launcher FAB (bottom-right, clears the mobile tab bar). */}
      <button
        ref={fabRef}
        type="button"
        className={`cp-fab ${open ? "is-open" : ""}`}
        aria-label="Open AI Co-pilot"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cp-fab-glow" aria-hidden="true" />
        <Icon
          icon={open ? "ic:round-close" : "solar:magic-stick-3-bold"}
          size={22}
          className="cp-fab-icon"
        />
        {!open && <span className="cp-fab-label">Co-pilot</span>}
      </button>

      {open && (
        <>
          {/* Mobile-only dim backdrop; click closes. Hidden on md+. */}
          <div className="cp-backdrop md:hidden" onClick={close} aria-hidden="true" />

          {/* The Co-pilot surface: docked card on desktop, bottom sheet on mobile. */}
          <div
            ref={surfaceRef}
            id={dialogId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="cp-surface"
          >
            {/* Surface header with the close control. CopilotPanel keeps its own
                header (brand + "Grounded in …"); we add only a thin top bar with
                an accessible name + ✕ so we don't double up the brand title. */}
            <div className="cp-surface-head">
              <span id={titleId} className="cp-surface-title">
                <Icon icon="ph:sparkle-fill" size={13} /> AI Co-pilot
              </span>
              <button
                type="button"
                data-cp-close
                className="cp-close"
                aria-label="Close AI Co-pilot"
                onClick={close}
              >
                <Icon icon="ic:round-close" size={18} />
              </button>
            </div>

            <div className="cp-surface-body">
              <CopilotPanel event={event} />
            </div>
          </div>
        </>
      )}
    </>
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

/* ---- Desktop docked card (md+) ---- */
.cp-surface {
  position: fixed;
  z-index: 75;
  display: flex;
  flex-direction: column;
  background: var(--brand-card);
  border: 1px solid var(--hair);
  overflow: hidden;
  animation: cpCardIn .22s cubic-bezier(.2,.7,.3,1);
}
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
@keyframes cpCardIn { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }

/* ---- Mobile bottom sheet (< md) ---- */
.cp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(7, 9, 18, .6);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  animation: cpFade .2s ease;
}
@keyframes cpFade { from { opacity: 0; } to { opacity: 1; } }
@media (max-width: 767px) {
  .cp-surface {
    z-index: 81; /* above the backdrop (80) and the tab bar (60) */
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
    animation: cpSheetIn .26s cubic-bezier(.2,.7,.3,1);
  }
}
@keyframes cpSheetIn { from { transform: translateY(100%); } to { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .cp-surface, .cp-backdrop { animation: none; }
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg2);
  transition: background .15s ease, color .15s ease;
}
.cp-close:hover { background: rgba(255, 255, 255, .07); color: var(--fg1); }

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
