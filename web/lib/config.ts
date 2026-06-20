// Sui network + hostit_ticket package config for the frontend.
// v3 (2026-05-31): faithful Sui port of the HostIt EVM Diamond. Multi-module
// package (hub/event/ticket/market/checkin); shared Hub; one shared Event per
// event; generic Coin<T> payments.

export const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

/** SuiVision explorer URL for a transaction digest (mainnet has no subdomain). */
export function explorerTxUrl(digest: string): string {
  const sub = NETWORK === "mainnet" ? "" : `${NETWORK}.`;
  return `https://${sub}suivision.xyz/txblock/${digest}`;
}

export const PACKAGE_ID =
  process.env.NEXT_PUBLIC_HOSTIT_PACKAGE_ID ??
  "0x423336143d4e5a810d24b97762bfa10be56b7d5dc86b75e831cb0897264b1e8d";

/**
 * Latest UPGRADED package version (v8, 2026-06-14 — adds the `policy_rules`
 * module; v6/v7 added `predict`). Sui anchors a type's identity to the package
 * version where it was INTRODUCED: existing modules (event/ticket/market/…) keep
 * the original PACKAGE_ID, and each predict struct stays pinned to the version
 * that introduced it (SelloutMarket → PREDICT_SELLOUT_PKG, RangeMarket →
 * PREDICT_RANGE_PKG). Move-call targets for predict + policy_rules use the latest
 * via `targetLatest`, while every proven existing flow keeps using PACKAGE_ID.
 */
export const PACKAGE_ID_LATEST =
  process.env.NEXT_PUBLIC_HOSTIT_PACKAGE_LATEST_ID ??
  "0xf6ebcba4e9c661c9bdbf6dc75fa44db3095dc35566d7cf246862f76603e56c12";

/**
 * Type-origin pin for `predict::SelloutMarket` (+ its events). Sui anchors a
 * type to the package version that INTRODUCED it; SelloutMarket shipped in the
 * 2026-06-07 upgrade (0x4829…), so its `*_TYPE`/`EV_*` constants must stay there
 * even as PACKAGE_ID_LATEST rolls forward with future upgrades. Calls still use
 * PACKAGE_ID_LATEST (latest version). Range markets get their own pin once the
 * Phase-2 upgrade lands.
 */
export const PREDICT_SELLOUT_PKG =
  process.env.NEXT_PUBLIC_HOSTIT_PREDICT_SELLOUT_PKG ??
  "0x4829706d16be235a2c3fbe86a1f7449100d39a46e3dd8105a5db3762a8ce1848";

/**
 * Type-origin pin for `predict::RangeMarket` (+ its events). RangeMarket shipped
 * in the v7 upgrade (0xb5c952…), so its `*_TYPE`/`EV_*` constants stay pinned
 * there even though PACKAGE_ID_LATEST has since rolled to v8 (policy_rules).
 */
export const PREDICT_RANGE_PKG =
  process.env.NEXT_PUBLIC_HOSTIT_PREDICT_RANGE_PKG ??
  "0xb5c95242b1a2acc8a2561246f95f8de182b3cbc67d71a370ee413c9dcdffcc0f";

/** Shared protocol Hub (config + 3% fee treasury). Every paid sale needs it. */
export const HUB_ID =
  process.env.NEXT_PUBLIC_HOSTIT_HUB_ID ??
  "0xa2b9ceb63babc6897932c6f4cfdbbddc9d3493d36691e4520278fc58090efabd";

/** Shared POAP dedup registry (one proof-of-attendance NFT per ticket). */
export const POAP_REGISTRY_ID =
  process.env.NEXT_PUBLIC_HOSTIT_POAP_REGISTRY_ID ??
  "0x57e285538f99b6bcc4d42e6adca2d2bb305cfb0c8b292094677fb70963d6021f";

export const TRANSFER_POLICY_ID =
  "0x3a8325aadee206476e5e71507d444e3fe2b25c11c9cd467503a8bba4e0ede8da";

// Well-known Sui shared Clock
export const CLOCK_ID = "0x6";

// === Walrus testnet (blob storage for event metadata + cover images) ===
export const WALRUS_PUBLISHER =
  process.env.NEXT_PUBLIC_WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space";
export const WALRUS_AGGREGATOR =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
export const WALRUS_EPOCHS = 10;

// === Seal testnet (threshold encryption for sensitive data) ===
export const SEAL_KEY_SERVER_ID =
  "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98";
export const SEAL_AGGREGATOR_URL = "https://seal-aggregator-testnet.mystenlabs.com";
// Seal policies live in OUR package (the seal_approve_* fns in `access`).
export const SEAL_POLICY_PACKAGE_ID = PACKAGE_ID;

export const target = (mod: string, fn: string) =>
  `${PACKAGE_ID}::${mod}::${fn}` as const;

/** Like `target`, but against the latest upgraded package — required for modules
 *  added in an upgrade (e.g. `predict`, which doesn't exist in the original id). */
export const targetLatest = (mod: string, fn: string) =>
  `${PACKAGE_ID_LATEST}::${mod}::${fn}` as const;

// === DeepBook Predict (Phase 3 — DEFERRED / NOT wired) ===
// HostIt's live prediction markets are the native `predict` module, which settles
// trustlessly on `event::minted()`. Integrating DeepBook Predict proper is
// blocked: Predict settles via admin/Block-Scholes PRICE oracles and has no
// self-serve custom oracle on testnet, so it cannot settle on event state today.
// These constants are the ready-to-wire swap-in point (see lib/predict.ts header
// for the PTB surface). They default OFF; set the env vars only once DeepBook
// opens self-serve oracles (or on mainnet). Testnet IDs are NON-STABLE.
// Known testnet refs at research time (2026-06): package 0xf5ea2b…785138,
// registry 0x43af…6e64, DUSDC 0xe95040…ba73e1a::dusdc::DUSDC.
export const PREDICT_PACKAGE_ID = process.env.NEXT_PUBLIC_DEEPBOOK_PREDICT_PACKAGE_ID ?? "";
export const PREDICT_REGISTRY_ID = process.env.NEXT_PUBLIC_DEEPBOOK_PREDICT_REGISTRY_ID ?? "";
export const DUSDC_COIN_TYPE = process.env.NEXT_PUBLIC_DUSDC_COIN_TYPE ?? "";
/** True only when the deferred DeepBook Predict path is explicitly configured. */
export const DEEPBOOK_PREDICT_ENABLED = PREDICT_PACKAGE_ID.length > 0;

// === MemWal (organizer memory — Phase 1, GH#15) — NON-SECRET config only ===
// The "organizer memory" layer talks to a MemWal relayer (TEE) that does
// embedding + SEAL encryption + Walrus storage server-side. The wiring lives in
// the SERVER-ONLY module lib/memwal.ts and the /api/memory/* route handlers.
//
// SECRETS ARE NOT EXPORTED HERE. config.ts is imported by client code, so the
// two secret values are read via process.env ONLY inside server code:
//   - MEMWAL_DELEGATE_KEY — Ed25519 delegate private key (hex). SERVER-ONLY,
//     never NEXT_PUBLIC_-prefixed, never exported from this file.
//   - MEMWAL_ACCOUNT_ID    — on-chain MemWalAccount object id. SERVER-ONLY
//     (REQUIRED for the layer to be enabled; Phase 0 creates it — may be UNSET
//     today, in which case the layer gracefully disables).
//
// Only the relayer host (non-secret) gets a default here.
//
// UNRESOLVED HOST MISMATCH (flag, do not silently pick one): the ops env has
// historically used `relayer.memory.walrus.xyz`, while the SDK's built-in
// default is `relayer.memwal.ai`. Set MEMWAL_RELAYER_URL explicitly to the
// correct relayer once confirmed; until then this stays empty and lib/memwal.ts
// falls through to the SDK default.
export const MEMWAL_RELAYER_URL = process.env.MEMWAL_RELAYER_URL ?? "";

// === Coins ===
export const SUI_COIN_TYPE = "0x2::sui::SUI";
// Circle native USDC (testnet). Override via env for mainnet
// (0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC).
export const USDC_COIN_TYPE =
  process.env.NEXT_PUBLIC_USDC_COIN_TYPE ??
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

export interface CoinInfo {
  symbol: string;
  type: string;
  decimals: number;
}

export const COINS: CoinInfo[] = [
  { symbol: "SUI", type: SUI_COIN_TYPE, decimals: 9 },
  { symbol: "USDC", type: USDC_COIN_TYPE, decimals: 6 },
];

export function coinInfo(type: string): CoinInfo {
  return COINS.find((c) => c.type === type) ?? { symbol: "?", type, decimals: 9 };
}

/** Normalize a coin type from a `type_name` (which omits the 0x and may be padded). */
export function matchesCoinType(typeName: string, full: string): boolean {
  const norm = (s: string) => s.replace(/^0x0*/, "").toLowerCase();
  return norm(typeName) === norm(full);
}

// === Protocol constants (mirror Hub defaults) ===
export const FEE_BPS = 300; // 3% platform fee on top of price
export const ROYALTY_BPS = 500; // 5% (not enforced in v1)
export const DAY_MS = 86_400_000;
export const REFUND_PERIOD_MS = 259_200_000; // 3 days

export const TICKET_STATUS = {
  ISSUED: 0,
  CHECKED_IN: 1,
  REFUNDED: 2,
} as const;

export const ENOKI_API_KEY = process.env.NEXT_PUBLIC_ENOKI_API_KEY ?? "";
export const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
export const ENOKI_ENABLED = ENOKI_API_KEY.length > 0;

/**
 * How long a Google (Enoki zkLogin) session stays valid, expressed in epochs.
 *
 * zkLogin caps the lifetime of an ephemeral key at the `maxEpoch` baked into
 * the nonce at sign-in: `maxEpoch = currentEpoch + additionalEpochs`. Enoki
 * also derives the locally-stored session TTL (`estimatedExpiration`) from this
 * same value, so setting it once extends BOTH the on-chain key validity and the
 * local session — there is no separate JWT/local TTL to change.
 *
 * 30 is the protocol/Enoki maximum (`additionalEpochs` range is 0..=30). On
 * Sui **testnet** epochs are ~24h, so 30 epochs ≈ 30 days, which is the target.
 * Epoch duration is a live network parameter — if testnet epoch cadence drifts
 * from ~24h, the effective wall-clock lifetime shifts with it; confirm against
 * the live network (e.g. `getLatestSuiSystemState().epochDurationMs`) if exact
 * days matter. We use the constant rather than computing from the live value
 * because 30 is already the hard ceiling — we cannot extend further regardless
 * of epoch duration, and asking for more would be rejected by the Enoki API.
 *
 * Security note: this only lengthens the session lifetime; the ephemeral key is
 * still single-use-per-session, generated fresh at each sign-in, and bound to
 * the zkLogin proof — extending `maxEpoch` does not weaken that.
 */
export const ENOKI_SESSION_EPOCHS = 30;

// Move type identifiers — for getOwnedObjects filters (both non-generic now).
export const TICKET_TYPE = `${PACKAGE_ID}::ticket::Ticket`;
export const EVENT_TYPE = `${PACKAGE_ID}::event::Event`;
export const ORGANIZER_CAP_TYPE = `${PACKAGE_ID}::event::OrganizerCap`;
/** Generic struct head (no type arg) for filtering parimutuel sellout markets. */
export const SELLOUT_MARKET_TYPE = `${PREDICT_SELLOUT_PKG}::predict::SelloutMarket`;
/**
 * Generic struct head (no type arg) for filtering parimutuel RANGE markets.
 * RangeMarket was introduced in the v7 upgrade, so its type origin is pinned to
 * PREDICT_RANGE_PKG (0xb5c952…) — NOT PACKAGE_ID_LATEST, which has since rolled
 * to v8 (policy_rules).
 */
export const RANGE_MARKET_TYPE = `${PREDICT_RANGE_PKG}::predict::RangeMarket`;

// Event (log) type strings for queryEvents
export const EV_EVENT_CREATED = `${PACKAGE_ID}::event::EventCreated`;
export const EV_PRICE_SET = `${PACKAGE_ID}::event::PriceSet`;
export const EV_TICKET_MINTED = `${PACKAGE_ID}::market::TicketMinted`;
// predict (parimutuel sellout market) log type strings for queryEvents
export const EV_MARKET_CREATED = `${PREDICT_SELLOUT_PKG}::predict::MarketCreated`;
export const EV_BET = `${PREDICT_SELLOUT_PKG}::predict::Bet`;
export const EV_SETTLED = `${PREDICT_SELLOUT_PKG}::predict::Settled`;
// predict (parimutuel RANGE market) log type strings for queryEvents.
// RangeMarket shipped in v7 -> type origin pinned to PREDICT_RANGE_PKG (not LATEST).
export const EV_RANGE_MARKET_CREATED = `${PREDICT_RANGE_PKG}::predict::RangeMarketCreated`;
export const EV_RANGE_BET = `${PREDICT_RANGE_PKG}::predict::RangeBet`;
export const EV_RANGE_SETTLED = `${PREDICT_RANGE_PKG}::predict::RangeSettled`;

/**
 * Parse a human decimal string into smallest units for a coin with `decimals`,
 * EXACTLY (no float). Returns null on malformed input or more fractional digits
 * than the coin supports — callers should surface that as a validation error.
 */
export function toUnits(human: string, decimals: number): bigint | null {
  const s = human.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

/**
 * Format a smallest-unit bigint as a human amount for a coin with `decimals`,
 * grouped (thousands separators) and with trailing fractional zeros trimmed.
 * Display only — never use to compute on-chain amounts (see `toUnits`).
 */
export function fmtAmount(units: bigint, decimals: number): string {
  const d = 10n ** BigInt(decimals);
  const whole = units / d;
  const frac = units % d;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString()}.${fracStr}`;
}
