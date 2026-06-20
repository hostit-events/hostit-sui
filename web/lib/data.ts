// HostIt design tokens for events — category palettes + glyphs (ported from the
// design's data.js) so generated posters match the brand by category.

export const PAL: Record<string, [string, string]> = {
  music: ["#FA00D4", "#007CFA"],
  tech: ["#007CFA", "#1CE2D8"],
  sports: ["#05F53D", "#007CFA"],
  arts: ["#F5A623", "#FA00D4"],
  web3: ["#1CE2D8", "#7A5CFF"],
  food: ["#F5A623", "#FA005A"],
  community: ["#7A5CFF", "#1CE2D8"],
  default: ["#2f7bff", "#fa00d4"],
};

export const GLYPH: Record<string, string> = {
  music: "ion:musical-notes",
  tech: "ph:cpu-bold",
  sports: "ph:trophy-fill",
  arts: "ph:paint-brush-fill",
  web3: "ph:cube-transparent-fill",
  food: "ph:wine-fill",
  community: "ph:users-three-fill",
  default: "ion:ticket",
};

export interface Category {
  id: string;
  label: string;
  icon: string;
}

export const CATEGORIES: Category[] = [
  { id: "all", label: "All", icon: "ic:round-explore" },
  { id: "music", label: "Music", icon: "ion:musical-notes" },
  { id: "web3", label: "Web3", icon: "ph:cube-transparent-fill" },
  { id: "tech", label: "Tech", icon: "ph:cpu-bold" },
  { id: "sports", label: "Sports", icon: "ph:trophy-fill" },
  { id: "arts", label: "Arts", icon: "ph:paint-brush-fill" },
  { id: "food", label: "Food & Drink", icon: "ph:wine-fill" },
  { id: "community", label: "Community", icon: "ph:users-three-fill" },
];

export function catPalette(cat?: string | null): [string, string] {
  return (cat && PAL[cat]) || PAL.default;
}
export function catGlyph(cat?: string | null): string {
  return (cat && GLYPH[cat]) || GLYPH.default;
}

// ---- deterministic seeded helpers (SSR/hydration-safe — no Math.random) ----
// FNV-1a 32-bit hash of a string. Shared so every surface that derives a look
// from an id (EventCard, EventPageScreen, EventPoster) hashes identically.
function fnv1a(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0; // force unsigned 32-bit
}

/** Map a seed string to a hue in [0, 359]. */
export function hashHue(seed: string): number {
  return fnv1a(seed) % 360;
}

/**
 * Deterministic integer in [min, max] (inclusive) from a seed + salt. The salt
 * lets one seed drive many independent params (angle, scale, edge, …) that don't
 * correlate. Pure — same inputs always yield the same output (hydration-safe).
 */
export function seededInt(seed: string, salt: string, min: number, max: number): number {
  if (max <= min) return min;
  const span = max - min + 1;
  return min + (fnv1a(`${seed}::${salt}`) % span);
}
