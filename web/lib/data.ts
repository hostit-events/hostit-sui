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
