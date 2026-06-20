// Pure helpers for building shareable event URLs and social-share intent links.
// Kept framework-free (no React, no DOM beyond an injectable `origin`) so the
// URL/intent builders are unit-testable — see lib/__tests__/share.test.ts.
//
// The canonical shareable URL is the route itself (`/event/<id>`), NOT the
// prototype's `?event=<id>` query param: in the live app the event is an
// addressable route (intercepting/parallel routes give the modal feel while the
// URL stays `/event/<id>`), so the same link both opens the quick-view in-app
// and renders the full page on a hard/direct load.

/** Resolve the current browser origin, or "" during SSR. Injectable for tests. */
export function currentOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "";
}

/**
 * Canonical shareable URL for an event. Absolute when an `origin` is available
 * (browser), otherwise a root-relative path — both resolve to the same route.
 */
export function eventShareUrl(id: string, origin: string = currentOrigin()): string {
  const path = `/event/${id}`;
  return origin ? `${origin}${path}` : path;
}

export interface SocialShareTarget {
  id: "x" | "farcaster" | "lens";
  label: string;
  /** External compose/intent URL with the event URL + text pre-filled. */
  href: string;
}

/**
 * Build the X / Farcaster / Lens compose-intent links for a shareable URL.
 * `text` is the share copy (e.g. the event name); `url` is from `eventShareUrl`.
 */
export function socialShareLinks(text: string, url: string): SocialShareTarget[] {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(text);
  return [
    {
      id: "x",
      label: "X / Twitter",
      href: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    },
    {
      id: "farcaster",
      label: "Farcaster",
      href: `https://warpcast.com/~/compose?text=${t}&embeds[]=${u}`,
    },
    {
      id: "lens",
      label: "Lens",
      href: `https://share.lens.xyz/u/?url=${u}&text=${t}`,
    },
  ];
}
