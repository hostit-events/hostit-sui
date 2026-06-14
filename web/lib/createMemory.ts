// HostIt — AI-assisted event creation: memory format helpers (GH#19).
//
// The organizer-memory layer (lib/memoryClient.ts) stores free-text one-liners.
// To make recalled memories useful as *structured* create-wizard suggestions we
// agree on a single canonical one-line summary format that we both WRITE (on an
// opt-in publish) and PARSE (to derive suggestions on open). The parser is
// deliberately forgiving: it pulls known `key: value` pairs out of the line and
// ignores everything else, so older / hand-written memories degrade gracefully
// (we simply surface fewer suggestions, never crash).
//
// Privacy/scope note: only the repeatable *preferences* below are summarized —
// category, city, venue, price, capacity. The event NAME is intentionally NOT
// stored or suggested (it's unique per event, not a reusable preference).

/** The canonical prefix every create-preferences memory starts with. */
export const CREATE_MEMORY_PREFIX = "Event creation preferences";

/** A fixed recall query describing what we want back from organizer memory. */
export const CREATE_MEMORY_QUERY =
  "event creation preferences: category, pricing, city, venue, capacity";

/** The repeatable preference fields we summarize + suggest (never the name). */
export interface CreatePrefs {
  category?: string;
  city?: string;
  venue?: string;
  /** Free-text price label, e.g. "25 SUI" (or "Free"). Display-only. */
  price?: string;
  /** Capacity as a string (max tickets), e.g. "100". */
  capacity?: string;
}

/** Inputs the wizard hands us to build a one-line memory on publish. */
export interface CreateSummaryInput {
  name: string; // used only to make the line human-readable; not a suggestion
  category: string;
  city?: string;
  venue?: string;
  isFree: boolean;
  basePrice?: string;
  coinSymbol: string;
  maxTickets: string;
}

/**
 * Build the concise one-line summary stored on an opt-in publish. Example:
 *   "Event creation preferences (Sui Builders Night) — category: tech;
 *    city: Lisbon; venue: The Glasshouse; price: 25 SUI; capacity: 100"
 * Only non-empty fields are included. Returns null if there's nothing useful to
 * remember (so callers can skip the write entirely).
 */
export function buildCreateSummary(i: CreateSummaryInput): string | null {
  const parts: string[] = [];
  if (i.category.trim()) parts.push(`category: ${i.category.trim()}`);
  if (i.city?.trim()) parts.push(`city: ${i.city.trim()}`);
  if (i.venue?.trim()) parts.push(`venue: ${i.venue.trim()}`);
  const price = i.isFree
    ? "Free"
    : i.basePrice?.trim()
      ? `${i.basePrice.trim()} ${i.coinSymbol}`
      : "";
  if (price) parts.push(`price: ${price}`);
  if (i.maxTickets.trim()) parts.push(`capacity: ${i.maxTickets.trim()}`);
  if (!parts.length) return null;
  const name = i.name.trim();
  const head = name
    ? `${CREATE_MEMORY_PREFIX} (${name})`
    : CREATE_MEMORY_PREFIX;
  return `${head} — ${parts.join("; ")}`;
}

// Match `key: value` up to the next `;`, `—`, `|` or end of line. Forgiving on
// spacing/case for the key; value keeps its original casing.
function pick(text: string, key: string): string | undefined {
  const re = new RegExp(`${key}\\s*:\\s*([^;|—]+)`, "i");
  const m = text.match(re);
  const v = m?.[1]?.trim();
  return v || undefined;
}

/**
 * Parse a single recalled memory line into structured preferences. Unknown
 * formats just yield an empty object (no throw). Used to derive suggestions.
 */
export function parseCreatePrefs(text: string): CreatePrefs {
  return {
    category: pick(text, "category"),
    city: pick(text, "city"),
    venue: pick(text, "venue"),
    price: pick(text, "price"),
    capacity: pick(text, "capacity"),
  };
}

/**
 * Merge several recalled memories (most-relevant first) into a single set of
 * suggestions: the first non-empty value wins per field. We pass memories in the
 * order recall returned them (ascending distance ⇒ most relevant first).
 */
export function mergeCreatePrefs(texts: string[]): CreatePrefs {
  const out: CreatePrefs = {};
  for (const t of texts) {
    const p = parseCreatePrefs(t);
    if (!out.category && p.category) out.category = p.category;
    if (!out.city && p.city) out.city = p.city;
    if (!out.venue && p.venue) out.venue = p.venue;
    if (!out.price && p.price) out.price = p.price;
    if (!out.capacity && p.capacity) out.capacity = p.capacity;
  }
  return out;
}

/** True when there is at least one suggestion worth showing. */
export function hasAnyPref(p: CreatePrefs): boolean {
  return Boolean(p.category || p.city || p.venue || p.price || p.capacity);
}
