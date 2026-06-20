// Rich event metadata lives on Walrus (the on-chain Event only holds name,
// times, caps, flags + the metadata blob id in its `uri` field). This keeps
// descriptions, category, venue, cover image and tiers off-chain & cheap.

import { storeJson, readJson, isBlobId } from "./walrus";

export interface Tier {
  name: string;
  price: number; // display price (smallest unit handled at purchase via on-chain price)
  note?: string;
  qty?: number;
}

export interface EventMetadata {
  v: 1;
  description?: string; // optional: instant-create omits it (added later from manage)
  category: string; // music | web3 | tech | sports | arts | food | community
  tag?: string; // "Festival", "Conference"…
  venue?: string;
  city?: string;
  coverBlobId?: string; // Walrus blob id of the cover image
  tiers?: Tier[];
  poap?: boolean;
  web3?: boolean;
  refundable?: boolean;
}

export async function putEventMetadata(m: EventMetadata): Promise<string> {
  return storeJson(m);
}

/**
 * Minimal sentinel metadata for instant ("Quick") event creation. Carries only
 * the schema version + category so `event.move`'s non-empty-`uri` assert is
 * satisfied with a tiny, fast Walrus upload — no cover, description, venue, city
 * or tiers. Those are added later from the manage screen (`update_metadata`).
 * Readers (Discover, event page, card) already fall back when fields are absent.
 */
export function minimalEventMetadata(category: string): EventMetadata {
  return { v: 1, category };
}

const cache = new Map<string, EventMetadata | null>();

/** Resolve an event's `uri` field into metadata. Accepts a Walrus blob id or a
 * plain JSON URL; returns null if it isn't HostIt metadata (older/plain uri). */
export async function getEventMetadata(uri: string | undefined | null): Promise<EventMetadata | null> {
  if (!uri) return null;
  if (cache.has(uri)) return cache.get(uri) ?? null;
  try {
    let m: EventMetadata | null = null;
    if (/^https?:\/\//.test(uri)) {
      const r = await fetch(uri);
      m = r.ok ? ((await r.json()) as EventMetadata) : null;
    } else if (isBlobId(uri)) {
      m = await readJson<EventMetadata>(uri);
    }
    if (m && m.v !== 1) m = null;
    cache.set(uri, m);
    return m;
  } catch {
    cache.set(uri, null);
    return null;
  }
}
