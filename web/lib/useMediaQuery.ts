"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media-query hook. Returns `false` on the server and the first client
 * render (so markup is deterministic for hydration), then settles to the real
 * match after mount. Used to switch the ticket view between a centered dialog
 * (desktop) and a bottom sheet (mobile).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
