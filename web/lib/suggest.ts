// "Suggest" — AI-invented funny/sarcastic event concepts for the create wizard
// (#93). PURE module (no server-only / no React): shared by the API route that
// generates them, the client that applies them, and the unit tests.
//
// The model output is UNTRUSTED, so `coerceSuggestion` validates + clamps every
// field to a safe, in-range shape (valid category, bounded capacity/price, capped
// strings) before it is ever applied to the form or returned to the browser.

/** Categories the create form actually offers (mirrors data.ts CATEGORIES minus "all"). */
export const SUGGEST_CATEGORIES = [
  "music",
  "web3",
  "tech",
  "sports",
  "arts",
  "food",
  "community",
] as const;

export interface EventSuggestion {
  name: string;
  category: string; // always one of SUGGEST_CATEGORIES after coercion
  tag?: string;
  venue?: string;
  city?: string;
  description: string;
  /** true = free event; when false, `price` + `coin` are set. */
  free: boolean;
  price?: number; // display units (e.g. 10 = 10 SUI), only when !free
  coin?: "SUI" | "USDC";
  capacity?: number; // maxTickets
  maxPerUser?: number;
}

export interface SuggestResponse {
  suggestion: EventSuggestion;
  sourced: "groq" | "fallback";
}

// Field bounds — keep a "suggestion" small, sane, and far below the on-chain
// MAX_TICKET_LIMIT so a hallucinated value can never reach the form unclamped.
const MAX_NAME = 80;
const MAX_TAG = 24;
const MAX_VENUE = 80;
const MAX_CITY = 60;
const MAX_DESC = 320;
const MAX_CAPACITY = 100_000;
const MAX_PER_USER = 100;
const MAX_PRICE = 100_000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Validate + clamp an untrusted suggestion object (from the model). Returns a
 * safe `EventSuggestion`, or null if it lacks the essentials (name + description).
 */
export function coerceSuggestion(raw: unknown): EventSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const name = str(r.name, MAX_NAME);
  const description = str(r.description, MAX_DESC);
  if (!name || !description) return null;

  const catRaw = str(r.category, 20).toLowerCase();
  const category = (SUGGEST_CATEGORIES as readonly string[]).includes(catRaw)
    ? catRaw
    : "community";

  const free = r.free === true || r.free === "true";

  let price: number | undefined;
  let coin: "SUI" | "USDC" | undefined;
  if (!free) {
    const p = Number(r.price);
    // round to 2dp, clamp to a sane range; default to a small fee if missing/bad.
    price = Number.isFinite(p) && p > 0 ? Math.min(Math.round(p * 100) / 100, MAX_PRICE) : 5;
    coin = r.coin === "USDC" ? "USDC" : "SUI";
  }

  const capN = Number(r.capacity);
  const capacity =
    Number.isFinite(capN) && capN >= 1 ? Math.min(Math.floor(capN), MAX_CAPACITY) : 100;

  const mpuN = Number(r.maxPerUser);
  const maxPerUser =
    Number.isFinite(mpuN) && mpuN >= 1 ? Math.min(Math.floor(mpuN), MAX_PER_USER) : undefined;

  return {
    name,
    category,
    tag: str(r.tag, MAX_TAG) || undefined,
    venue: str(r.venue, MAX_VENUE) || undefined,
    city: str(r.city, MAX_CITY) || undefined,
    description,
    free,
    price,
    coin,
    capacity,
    maxPerUser,
  };
}

/**
 * Curated, brand-safe funny concepts used when Groq is unavailable (no key, a
 * blocked bot-check, or a bad model response) — so the feature works out of the
 * box. All are already in coerced shape. Original, self-deprecating crypto/event
 * humor; no real people, no slurs, no NSFW.
 */
export const FUNNY_FALLBACKS: readonly EventSuggestion[] = [
  {
    name: "Gas Fee Support Group",
    category: "community",
    tag: "Group Therapy",
    venue: "The Mempool Lounge",
    city: "Lagos",
    description:
      "A safe space to grieve your last transaction together. We bring the tissues; you bring the trauma. No judgement, only confirmations.",
    free: true,
    capacity: 60,
    maxPerUser: 2,
  },
  {
    name: "Standup Meeting: The Musical",
    category: "tech",
    tag: "Sprint Finale",
    venue: "Conference Room B",
    city: "Remote",
    description:
      "Three hours of daily standup, now with jazz hands and an intermission. Blockers will be sung dramatically. Velocity not guaranteed.",
    free: false,
    price: 5,
    coin: "USDC",
    capacity: 120,
    maxPerUser: 4,
  },
  {
    name: "NFT Funeral & Wake",
    category: "arts",
    tag: "Final Mint",
    venue: "The Cold Wallet Chapel",
    city: "Berlin",
    description:
      "Pour one out for the JPEGs that didn't make it. Bring your floor price and your feelings. Right-click to pay your respects.",
    free: true,
    capacity: 100,
    maxPerUser: 3,
  },
  {
    name: "Mainnet Launch Party (Delayed Again)",
    category: "web3",
    tag: "Soon",
    venue: "Vaporware Hall",
    city: "Singapore",
    description:
      "The launch party for the launch that keeps not launching. BYO patience. Doors open Q-eventually; refunds paid in vibes.",
    free: false,
    price: 10,
    coin: "SUI",
    capacity: 300,
    maxPerUser: 5,
  },
  {
    name: "Touch Grass 5K",
    category: "sports",
    tag: "Log-Off Run",
    venue: "Actual Outside",
    city: "Nairobi",
    description:
      "A gentle jog away from your screen and back toward the sun. No laptops, no notifications, no 'just one more block'. Grass provided.",
    free: true,
    capacity: 200,
    maxPerUser: 4,
  },
  {
    name: "All-You-Can-Eat Testnet Tokens",
    category: "food",
    tag: "Faucet Feast",
    venue: "The Devnet Diner",
    city: "Accra",
    description:
      "A buffet of perfectly worthless tokens served on a silver platter. Infinite supply, zero value, oddly filling. Mainnet menu sold separately.",
    free: true,
    capacity: 150,
    maxPerUser: 3,
  },
  {
    name: "Diamond Hands Spa Day",
    category: "community",
    tag: "HODL & Hydrate",
    venue: "The Cope Cabana",
    city: "Dubai",
    description:
      "Unclench those diamond hands with a hot stone massage and a chart you promise not to check. Paper hands welcome, quietly.",
    free: false,
    price: 25,
    coin: "USDC",
    capacity: 50,
    maxPerUser: 2,
  },
  {
    name: "The 'We're So Back' Comeback Tour",
    category: "music",
    tag: "Up Only (Tonight)",
    venue: "The Bull Run Arena",
    city: "Lisbon",
    description:
      "A one-night show that swings between euphoria and despair every four bars. The setlist is decided live by pure market sentiment.",
    free: false,
    price: 15,
    coin: "SUI",
    capacity: 400,
    maxPerUser: 6,
  },
];

/** A random curated fallback concept (server-side use; varies on reroll). */
export function pickFallback(): EventSuggestion {
  return FUNNY_FALLBACKS[Math.floor(Math.random() * FUNNY_FALLBACKS.length)];
}
