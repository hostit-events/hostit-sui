// Pure pagination helpers (NO React/client deps) so they unit-test in isolation
// — the cursor-follow + chunk logic that makes Discover enumerate every event
// instead of only the newest RPC page. See GH#32.

/** Default page bound: 20 pages × ~50/page ≈ 1000 logs. Enough for testnet v1;
 *  a server-side indexer is the v2 path when volume outgrows full enumeration. */
export const MAX_PAGES = 20;

/**
 * Accumulate every page of a cursor-paginated source by following `nextCursor`
 * until it runs out (or `maxPages` is hit). `fetchPage` is injected so this is
 * pure and testable with no SuiClient. Returns `truncated: true` when the page
 * bound stopped it early (more data exists) so callers can surface "showing
 * first N" instead of silently dropping the tail.
 */
export async function collectPages<T, C>(
  fetchPage: (
    cursor: C | null,
  ) => Promise<{ data: T[]; nextCursor: C | null; hasNextPage: boolean }>,
  maxPages: number = MAX_PAGES,
): Promise<{ data: T[]; truncated: boolean }> {
  const all: T[] = [];
  let cursor: C | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(cursor);
    all.push(...res.data);
    // End when the source says so OR there's no cursor to continue from.
    if (!res.hasNextPage || res.nextCursor == null) return { data: all, truncated: false };
    cursor = res.nextCursor;
  }
  return { data: all, truncated: true };
}

/** Split `arr` into consecutive chunks of at most `size` (e.g. multiGetObjects'
 *  50-id RPC cap). Throws on a non-positive size. */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
