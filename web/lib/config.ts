// Sui network + hostit_ticket package config for the frontend.
// v3 (2026-05-31): faithful Sui port of the HostIt EVM Diamond. Multi-module
// package (hub/event/ticket/market/checkin/poap/forum/reviews/predict/governance);
// shared Hub; one shared Event per event; generic Coin<T> payments.
//
// DEPLOY MODEL: every Move change ships as a FRESH PUBLISH (not an in-place
// upgrade). One consequence: there is a SINGLE package id — all type origins and
// all call targets resolve to `PACKAGE_ID`. The old PACKAGE_ID_LATEST /
// PREDICT_SELLOUT_PKG / PREDICT_RANGE_PKG / targetLatest split (which existed only
// to survive in-place upgrades, Sui's "type origin pinned to the introducing
// version" rule) has been collapsed away. On each fresh publish, roll the object
// ids below (PACKAGE_ID, HUB_ID, TRANSFER_POLICY_ID, GOVERNANCE_REGISTRY_ID) via
// scripts/roll-fresh-publish.mjs + a manual GOVERNANCE_REGISTRY_ID edit.

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
  "0xa32a5fa219199d01c34f9f4dfa98d429b9f8fb20eebd0528fc99904994912d74";

/** Shared protocol Hub (config + 3% fee treasury). Every paid sale needs it. */
export const HUB_ID =
  process.env.NEXT_PUBLIC_HOSTIT_HUB_ID ??
  "0x97a47754560651003657a06895175850f362b8f390b459f3cf033e680576fd56";

// (POAP dedup is now a flag on the Ticket — no shared PoapRegistry object.)

export const TRANSFER_POLICY_ID =
  "0x954db2d6db7f2eb5cfe2131890eedfad8ebf669956a8fd998d75908c74da85ce";

// === Protocol governance (OpenZeppelin access_control RBAC — GH#51) ===
// Replaces the single PlatformCap with revocable, role-scoped authority
// (TreasuryRole + ConfigAdminRole) and a timelocked root-admin handoff. Our
// `governance` wrappers (grant/revoke, auth minting) target PACKAGE_ID via
// `target("governance", …)`; the OZ root-admin timelock flow targets the OZ
// package below. See DEPLOYING.md.

/**
 * OZ `access_control` testnet package (published-at). Call target for the OZ
 * root-admin timelock flow (begin/accept transfer, delay change). Env-overridable
 * so a future OZ release can be rolled without a code change.
 */
export const OZ_ACCESS_PKG =
  process.env.NEXT_PUBLIC_OZ_ACCESS_PKG ??
  "0xb357701a05fd1e26b42b167dcadc1c3cf5e521448ceb8fdb088402f7390465d7";

/**
 * Shared `AccessControl<governance::GOVERNANCE>` registry — created by
 * `governance::init` at publish (re-minted on every fresh publish; last rolled at
 * the GH#87 publish, 2026-06-21). Deployer 0xc8567c14… is the default admin
 * holding TreasuryRole + ConfigAdminRole.
 */
export const GOVERNANCE_REGISTRY_ID =
  process.env.NEXT_PUBLIC_HOSTIT_GOVERNANCE_ID ?? "0xfd72543e5bfb9e62b173d18f5c726a5aa2b61340437a630269ddc0c79df38414";

/**
 * Shared `identity::EmailRegistry` (one-account-one-email, GH#96) — created by
 * `identity::init` at publish, so it's (re)minted on every fresh publish. Empty
 * until the identity module is first published; roll it via
 * scripts/roll-fresh-publish.mjs. Email binding no-ops until then (like reviews
 * did pre-deploy).
 */
export const EMAIL_REGISTRY_ID =
  process.env.NEXT_PUBLIC_HOSTIT_EMAIL_REGISTRY_ID ?? "0x279607e407f415e19af073881b9edc579df76349a3fddd18bf776af63ef7459b";

/** Target a function in the OZ `access_control` module (root-admin flow). */
export const ozAccessTarget = (fn: string) =>
  `${OZ_ACCESS_PKG}::access_control::${fn}` as const;

// Well-known Sui shared Clock
export const CLOCK_ID = "0x6";

// === Walrus testnet (blob storage for event metadata + cover images) ===
export const WALRUS_PUBLISHER =
  process.env.NEXT_PUBLIC_WALRUS_PUBLISHER ?? "https://publisher.walrus-testnet.walrus.space";
export const WALRUS_AGGREGATOR =
  process.env.NEXT_PUBLIC_WALRUS_AGGREGATOR ?? "https://aggregator.walrus-testnet.walrus.space";
export const WALRUS_EPOCHS = 10;
/**
 * Walrus storage epochs for SAVED EVENT DRAFTS (GH#46). Drafts are work-in-
 * progress that an organizer may sit on for a while before publishing, so they
 * get a longer TTL than the default `WALRUS_EPOCHS` (10). On testnet an epoch is
 * ~24h, so 30 epochs ≈ 30 days. v1 CEILING: this is a hard Walrus TTL — a draft's
 * encrypted blob is garbage-collected after it lapses (the device-local index
 * entry will then dangle and `loadDraft` will fail to read it). No auto-renew.
 */
export const WALRUS_DRAFT_EPOCHS = 30;

// === Seal testnet (threshold encryption for sensitive data) ===
export const SEAL_KEY_SERVER_ID =
  "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98";
export const SEAL_AGGREGATOR_URL = "https://seal-aggregator-testnet.mystenlabs.com";
/**
 * Whether the Seal client verifies key-server authenticity. ON for every real
 * network (testnet/mainnet/devnet); OFF only on `localnet`, where there is no
 * reachable key server to verify against (dev escape hatch). Previously this
 * was a hardcoded `false` in lib/seal.ts shipped to prod.
 *
 * Note: the installed @mysten/seal SDK skips the /service check for
 * committee-type key servers even when this is true (it goes through the
 * aggregator), so enabling it does not add a network round-trip for the current
 * testnet committee server — it just stops trusting non-committee servers blindly.
 */
export const SEAL_VERIFY_KEY_SERVERS = NETWORK !== "localnet";
// Seal policies live in OUR package (the seal_approve_* fns in `access`).
export const SEAL_POLICY_PACKAGE_ID = PACKAGE_ID;

export const target = (mod: string, fn: string) =>
  `${PACKAGE_ID}::${mod}::${fn}` as const;

/**
 * Move-call targets HostIt will gas-sponsor via /api/sponsor (the Enoki
 * allowlist). SINGLE SOURCE OF TRUTH — imported by app/api/sponsor/route.ts.
 * One package id (fresh-publish model), so every entry is `${PACKAGE_ID}::…`;
 * 0x2 framework calls are emitted by the SDK's coinWithBalance intent. Add new
 * sponsored entry functions HERE (one place). Governance admin fns are
 * intentionally NOT sponsored.
 */
export const SPONSORED_TARGETS: readonly string[] = [
  `${PACKAGE_ID}::event::create_event`,
  `${PACKAGE_ID}::event::create_event_with_price`, // atomic create+price (#68)
  `${PACKAGE_ID}::event::set_price`,
  `${PACKAGE_ID}::event::set_allow_self_checkin`,
  `${PACKAGE_ID}::event::add_checkin_signer`,
  `${PACKAGE_ID}::event::remove_checkin_signer`,
  // Organizer edits (#69) — wire the existing update_* fns into Manage, gasless.
  `${PACKAGE_ID}::event::update_metadata`,
  `${PACKAGE_ID}::event::update_times`,
  `${PACKAGE_ID}::event::update_end_time`,
  `${PACKAGE_ID}::event::update_max_tickets`,
  `${PACKAGE_ID}::event::update_max_per_user`,
  `${PACKAGE_ID}::event::remove_price`,
  // Manage v2 (#87) organizer lifecycle controls.
  `${PACKAGE_ID}::event::set_cancelled`,
  `${PACKAGE_ID}::event::set_poap_enabled`,
  `${PACKAGE_ID}::event::set_is_free`,
  `${PACKAGE_ID}::event::set_is_refundable`,
  `${PACKAGE_ID}::market::withdraw_event_balance`,
  `${PACKAGE_ID}::market::buy`,
  `${PACKAGE_ID}::market::buy_with_sui`,
  `${PACKAGE_ID}::market::claim_free`,
  `${PACKAGE_ID}::market::refund`,
  `${PACKAGE_ID}::checkin::self_check_in`,
  `${PACKAGE_ID}::checkin::check_in`,
  `${PACKAGE_ID}::poap::claim_poap`,
  `${PACKAGE_ID}::forum::post`,
  `${PACKAGE_ID}::forum::post_as_organizer`,
  `${PACKAGE_ID}::forum::moderate`,
  `${PACKAGE_ID}::reviews::post_review`,
  // Account identity (GH#96): gasless email register/unregister + opt-in share grant.
  `${PACKAGE_ID}::identity::register_email`,
  `${PACKAGE_ID}::identity::unregister_email`,
  `${PACKAGE_ID}::identity::grant_email_access`,
  `${PACKAGE_ID}::identity::revoke_email_grant`,
  `${PACKAGE_ID}::predict::create_sellout_market`,
  `${PACKAGE_ID}::predict::bet_yes`,
  `${PACKAGE_ID}::predict::bet_no`,
  `${PACKAGE_ID}::predict::settle`,
  `${PACKAGE_ID}::predict::claim`,
  `${PACKAGE_ID}::predict::create_range_market`,
  `${PACKAGE_ID}::predict::bet_bucket`,
  `${PACKAGE_ID}::predict::settle_range`,
  `${PACKAGE_ID}::predict::claim_range`,
  "0x2::coin::zero",
  "0x2::coin::redeem_funds",
  "0x2::coin::into_balance",
  "0x2::coin::send_funds",
  "0x2::coin::destroy_zero",
  "0x2::balance::zero",
  "0x2::balance::redeem_funds",
];

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
  // Pin the grouping locale: a runtime "."-grouping locale (e.g. de-DE) would
  // collide with the literal "." decimal below → "1.234.5". en-US gives ",".
  if (frac === 0n) return whole.toLocaleString("en-US");
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
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
 * Cloudflare Turnstile (anti-bot) PUBLIC site key. When set, the app mounts an
 * invisible Turnstile widget (components/TurnstileGate.tsx) and attaches a
 * single-use token to the gasless-sponsor + AI requests. The server enforces it
 * ONLY when TURNSTILE_SECRET_KEY (server-only, NOT in this file) is also set —
 * set BOTH or NEITHER. See issue #81 and lib/turnstile.ts.
 */
export const TURNSTILE_SITE_KEY =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
export const TURNSTILE_ENABLED = TURNSTILE_SITE_KEY.length > 0;

/**
 * Account email layer (GH#96). The CLIENT shows the email-binding UI only when
 * this is on; binding also needs the on-chain `EmailRegistry` (EMAIL_REGISTRY_ID).
 * The SERVER secrets that actually power it — `RESEND_API_KEY`, `EMAIL_HASH_PEPPER`
 * (≥32B), optional `EMAIL_FROM` — are read via process.env ONLY inside the
 * /api/email/* routes and are NEVER exported here (same rule as ENOKI/Turnstile).
 * Set NEXT_PUBLIC_EMAIL_ENABLED="true" once the registry is published + the
 * server secrets are configured.
 */
export const EMAIL_ENABLED =
  (process.env.NEXT_PUBLIC_EMAIL_ENABLED ?? "") === "true" && EMAIL_REGISTRY_ID.length > 0;

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
// Protocol RBAC role markers (governance introduced at the GH#51 fresh publish →
// PACKAGE_ID). Used as type args for the OZ access_control root-admin flow.
export const GOVERNANCE_TYPE = `${PACKAGE_ID}::governance::GOVERNANCE`;
export const TREASURY_ROLE_TYPE = `${PACKAGE_ID}::governance::TreasuryRole`;
export const CONFIG_ADMIN_ROLE_TYPE = `${PACKAGE_ID}::governance::ConfigAdminRole`;
/** Generic struct head (no type arg) for filtering parimutuel sellout markets. */
export const SELLOUT_MARKET_TYPE = `${PACKAGE_ID}::predict::SelloutMarket`;
/** Generic struct head (no type arg) for filtering parimutuel RANGE markets. */
export const RANGE_MARKET_TYPE = `${PACKAGE_ID}::predict::RangeMarket`;

// Event (log) type strings for queryEvents
export const EV_EVENT_CREATED = `${PACKAGE_ID}::event::EventCreated`;
export const EV_PRICE_SET = `${PACKAGE_ID}::event::PriceSet`;
export const EV_TICKET_MINTED = `${PACKAGE_ID}::market::TicketMinted`;
// poap::PoapClaimed — origin = PACKAGE_ID (the original/fresh package introduced
// `poap`, per the package-versioning rule). Emitted from poap::claim_poap with
// fields { event_seq, event_id, ticket_id, poap_id, recipient }.
export const EV_POAP_CLAIMED = `${PACKAGE_ID}::poap::PoapClaimed`;
// reviews::ReviewPosted (GH#58). Fields: { event_id, event_seq, author, rating,
// blob_id, ts_ms }.
export const EV_REVIEW_POSTED = `${PACKAGE_ID}::reviews::ReviewPosted`;
// predict (parimutuel sellout market) log type strings for queryEvents
export const EV_MARKET_CREATED = `${PACKAGE_ID}::predict::MarketCreated`;
export const EV_BET = `${PACKAGE_ID}::predict::Bet`;
export const EV_SETTLED = `${PACKAGE_ID}::predict::Settled`;
// predict (parimutuel RANGE market) log type strings for queryEvents.
export const EV_RANGE_MARKET_CREATED = `${PACKAGE_ID}::predict::RangeMarketCreated`;
export const EV_RANGE_BET = `${PACKAGE_ID}::predict::RangeBet`;
export const EV_RANGE_SETTLED = `${PACKAGE_ID}::predict::RangeSettled`;
