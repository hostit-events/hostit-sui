"use client";

import React from "react";
import { catPalette, catGlyph, hashHue, seededInt } from "@/lib/data";
import { Icon } from "@/components/Icon";

/**
 * EventPoster — the generated editorial-halftone artwork behind every event
 * surface (cards, hero, wallet tickets). It is SELF-CONTAINED and fills its
 * container via `absolute inset-0`, so callers drop it inside their existing
 * `position: relative` `.poster` wrapper without touching layout.
 *
 * Direction: EDITORIAL HALFTONE — a DUOTONE seeded palette (catPalette hue-
 * shifted by the seed), a halftone dot texture, and a HUGE masked category
 * glyph (catGlyph) as the hero element, bleeding off a seeded edge with a
 * seeded rotation + scale. A bottom dark gradient keeps overlaid title/badges
 * legible. When `coverUrl` is set the real cover photo overlays the art on top.
 *
 * EVERYTHING is deterministic from `seed` (FNV via lib/data helpers — no
 * Math.random), so it is SSR/hydration-safe and two events in the same category
 * look clearly different.
 */
export interface EventPosterProps {
  /** Deterministic seed — typically the event id (or seq). Drives every varied param. */
  seed: string;
  /** Category id (music, tech, …) → palette + hero glyph. Null/undefined → default. */
  category?: string | null;
  /** When set, the real cover image overlays the generated art (object-cover). */
  coverUrl?: string;
  /** Render the hero glyph. Pass false for small strips (duotone + halftone only). */
  glyph?: boolean;
  /** Above-the-fold hero — load the cover eagerly with high priority (better LCP).
   *  Leave false/undefined on cards/grids so they stay lazy. */
  priority?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

// Hue-rotate a #rrggbb hex by `deg` degrees, returning an `hsl()` string. Keeps
// the brand palette's relationships but shifts it per-seed so same-category
// events differ. Deterministic — pure arithmetic, no DOM.
function hexHueShift(hex: string, deg: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1], 16) / 255;
  const g = parseInt(m[2], 16) / 255;
  const b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  const hh = (h + deg) % 360;
  return `hsl(${Math.round(hh)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

// Mix an `hsl()` string toward a target lightness (build deep/bright stops from
// one tinted hue). `mix` 0..1 = how far toward `targetL`.
function shiftLightness(hsl: string, targetL: number, mix: number): string {
  const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(hsl);
  if (!m) return hsl;
  const h = m[1];
  const s = m[2];
  const l = Number(m[3]);
  const nl = Math.round(l + (targetL - l) * mix);
  return `hsl(${h} ${s}% ${Math.max(0, Math.min(100, nl))}%)`;
}

// Which edge the hero glyph bleeds off — drives its absolute anchoring.
const EDGES = ["tl", "tr", "bl", "br", "right", "bottom"] as const;
type Edge = (typeof EDGES)[number];

function edgeAnchor(edge: Edge, sizePct: number): React.CSSProperties {
  // Position so the glyph runs off the chosen edge (negative offset ≈ 22% bleed).
  const bleed = `-${Math.round(sizePct * 0.22)}%`;
  const center = `${Math.round((100 - sizePct) / 2)}%`;
  switch (edge) {
    case "tl":
      return { top: bleed, left: bleed };
    case "tr":
      return { top: bleed, right: bleed };
    case "bl":
      return { bottom: bleed, left: bleed };
    case "br":
      return { bottom: bleed, right: bleed };
    case "right":
      return { top: center, right: bleed };
    case "bottom":
    default:
      return { bottom: bleed, left: center };
  }
}

export function EventPoster({
  seed,
  category,
  coverUrl,
  glyph = true,
  priority = false,
  className,
  style,
}: EventPosterProps) {
  const [base1, base2] = catPalette(category);

  // ---- seed-derived params (deterministic via lib/data helpers) ----
  // Duotone hue rotation applied to the whole palette (so same-category events differ).
  const hueShift = (hashHue(seed) % 90) - 45; // [-45, 44] deg — tasteful, palette stays recognizable
  const c1 = hexHueShift(base1, hueShift);
  const c2 = hexHueShift(base2, hueShift);
  // Deep duotone: a dark base and two tinted accents built from the shifted hues.
  const deep1 = shiftLightness(c1, 10, 0.78);
  const deep2 = shiftLightness(c2, 8, 0.82);
  const accent1 = shiftLightness(c1, 58, 0.35);
  const accent2 = shiftLightness(c2, 56, 0.4);

  const gradAngle = seededInt(seed, "angle", 105, 215); // gradient direction
  const blobX = seededInt(seed, "blobx", 12, 78); // first accent radial position
  const blobY = seededInt(seed, "bloby", 8, 42);
  const blob2X = seededInt(seed, "blob2x", 60, 96);
  const blob2Y = seededInt(seed, "blob2y", 58, 94);

  // Halftone dot texture — seeded size & density.
  const dotGap = seededInt(seed, "dotgap", 9, 18); // px between dot centers
  const dotR = (seededInt(seed, "dotr", 22, 40) / 100) * dotGap; // radius scales with gap
  const dotAngle = seededInt(seed, "dotangle", -20, 20); // rotate the dot grid

  // Hero glyph transform.
  const glyphPct = seededInt(seed, "glyphsize", 72, 94); // % of the short side
  const glyphRot = seededInt(seed, "glyphrot", -18, 18); // slight rotation
  const glyphScale = seededInt(seed, "glyphscale", 96, 116) / 100; // slight scale
  const edge = EDGES[seededInt(seed, "edge", 0, EDGES.length - 1)];
  const glyphOpacity = seededInt(seed, "glyphop", 16, 26) / 100; // tasteful, knockout-style
  const glyphIcon = catGlyph(category);

  // Stable, seed-unique id so SVG pattern refs don't collide across posters on a
  // page (SVG ids are document-global). Deterministic — same seed → same id.
  const patternId = `ht-${seededInt(seed, "patid", 0, 1_000_000_000)}`;

  const duotone =
    `radial-gradient(80% 70% at ${blobX}% ${blobY}%, ${accent1} 0%, transparent 60%),` +
    `radial-gradient(82% 76% at ${blob2X}% ${blob2Y}%, ${accent2} 0%, transparent 62%),` +
    `linear-gradient(${gradAngle}deg, ${deep1} 0%, ${deep2} 100%)`;

  return (
    <div
      className={className}
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: duotone,
        ...style,
      }}
    >
      {/* Halftone dot texture — SVG pattern, seeded radius/gap, blended over the duotone. */}
      <svg
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          mixBlendMode: "soft-light",
          opacity: 0.55,
        }}
      >
        <defs>
          <pattern
            id={patternId}
            width={dotGap}
            height={dotGap}
            patternUnits="userSpaceOnUse"
            patternTransform={`rotate(${dotAngle})`}
          >
            <circle cx={dotGap / 2} cy={dotGap / 2} r={dotR} fill="rgba(255,255,255,0.9)" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>

      {/* Hero glyph — HUGE masked category icon bleeding off a seeded edge. */}
      {glyph && (
        <div
          style={{
            position: "absolute",
            width: `${glyphPct}%`,
            aspectRatio: "1 / 1",
            color: "#fff",
            opacity: glyphOpacity,
            mixBlendMode: "overlay",
            transform: `rotate(${glyphRot}deg) scale(${glyphScale})`,
            transformOrigin: "center",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
            ...edgeAnchor(edge, glyphPct),
          }}
        >
          {/* Icon SVG inherits currentColor; force it to fill the wrapper box. */}
          <Icon
            icon={glyphIcon}
            size={2000}
            style={{ width: "100%", height: "100%", display: "block" }}
          />
        </div>
      )}

      {/* Bottom dark legibility gradient so overlaid title/badges stay readable. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(0deg, rgba(8,11,28,.72) 0%, rgba(8,11,28,.28) 32%, transparent 58%)",
          pointerEvents: "none",
        }}
      />

      {/* Real cover image overlays the generated art on top (cover path unchanged). */}
      {coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover ring-1 ring-inset ring-white/10"
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          width={1200}
          height={630}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </div>
  );
}
