# sui-ticket — deploy context

Append-only record of testnet/mainnet deploys. Each entry has the canonical headers from `phase-handoff.md`.

> **Note on versioning:** v6+ are package **UPGRADES** of the v5 package (the first non-fresh deploys in this repo), so all v5 objects (Hub, PoapRegistry, TransferPolicy, existing Events/Tickets) are **preserved**. Sui anchors a type's identity to the package version that *introduced* it, so the live id map is: original modules' types → `PACKAGE_ID` `0x4233…1e8d`; `predict::SelloutMarket` (+events) → v6 `0x4829…` (`PREDICT_SELLOUT_PKG`); `predict::RangeMarket` (+events) → v7 `0xb5c9…` (`PACKAGE_ID_LATEST`); **all `predict` call targets** → latest (`PACKAGE_ID_LATEST`). `web/lib/config.ts` is the live source of truth.

---

## Upgrade, 2026-06-07T02:00:00Z (v7 — predict::RangeMarket)

Phase 2 of native prediction markets. **Package upgrade** v6 → v7 (additive: adds `RangeMarket` to the `predict` module; all other modules byte-identical, all v5/v6 objects preserved). DeepBook Predict proper stays deferred (no self-serve oracle on testnet); these are HostIt-native parimutuel markets that settle on-chain via `event::minted()`.

### Package
- **package id (v7, latest)**: `0xb5c95242b1a2acc8a2561246f95f8de182b3cbc67d71a370ee413c9dcdffcc0f`
- modules: `access`, `checkin`, `event`, `forum`, `hub`, `market`, `poap`, `predict`, `ticket`
- upgrade tx: `Bbzptbbeoh2d8frfmhJSAkmYsiFBRZLVywEkFh7hRUVY`
- UpgradeCap: `0x82729a8d95e0f83de08f3488fdf649cd29737d917d54776ef0f4d16924f3bbfb` (→ version 3)
- `Move.toml` `published-at` rolled to the v6 id `0x4829…` for this upgrade; `[addresses] hostit_ticket` stays the original `0x4233…`.

### What changed
- Adds `predict::RangeMarket<phantom T>` — parimutuel **vertical-range** market on final tickets-sold (N cutoffs → N+1 buckets over `event::minted`). Entry fns `create_range_market` / `bet_bucket` / `settle_range` / `claim_range`; events `RangeMarketCreated` / `RangeBet` / `RangeSettled`; new errors `E_BAD_CUTOFFS=7`, `E_BAD_BUCKET=8`. Settles trustlessly by reading `event::minted()` at/after `expiry_ms` and crediting the containing bucket; no oracle, no fee.
- **Type origin:** `RangeMarket` + its events live at this v7 id (`PACKAGE_ID_LATEST`). `SelloutMarket` stays pinned at v6 `0x4829…` (`PREDICT_SELLOUT_PKG`).
- 57 Move tests pass (12 new range tests; a pro-rata payout-weighting bug was found + fixed during testing).

### Frontend
- `config.ts` `PACKAGE_ID_LATEST` → `0xb5c952…`; `RANGE_MARKET_TYPE`/`EV_RANGE_*` use it; all predict calls via `targetLatest`. Allowlist (`app/api/sponsor/route.ts` + `lib/sponsor.ts`) gains `predict::create_range_market`/`bet_bucket`/`settle_range`/`claim_range`. New `EventMarketsScreen`, `lib/markets.ts`, organizer panel + Discover "Market" badge.

### On-chain smoke (testnet, succeeded)
- `create_range_market<USDC>(event 0x2ec7ae…, cutoffs [25,50,75,100])` → shared `RangeMarket` `0xf3de0ee6fe110d2e588edfd6ae2225d8413f6395d9e47e241434d80aca0f44e0`; `RangeMarketCreated` emitted. Both Sellout + Range cards render on the event page.

---

## Upgrade, 2026-06-07T01:00:00Z (v6 — predict module + SelloutMarket)

Phase 1 of native prediction markets, and the **first package upgrade** in this repo (prior deploys were fresh publishes). Additive: adds the `predict` module; all v5 modules byte-identical and all v5 objects preserved.

### Package
- **package id (v6)**: `0x4829706d16be235a2c3fbe86a1f7449100d39a46e3dd8105a5db3762a8ce1848`
- modules: v5 set + `predict` (`access`, `checkin`, `event`, `forum`, `hub`, `market`, `poap`, `predict`, `ticket`)
- upgrade tx: `FzKcKHkrU2qaXfnJCd9vHieMkKFXKcksCPKZe4XPGcjj`
- UpgradeCap: `0x82729a8d95e0f83de08f3488fdf649cd29737d917d54776ef0f4d16924f3bbfb` (controls the v5 package `0x4233…`; → version 2)
- gas address: `0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9`
- **Enabled upgrades:** `Move.toml` got `published-at = 0x4233…` (the v5 id) and `[addresses] hostit_ticket = 0x4233…` (was `0x0`). Each on-chain upgrade requires explicit per-deploy user authorization (the permission layer blocks it otherwise).

### What changed
- Adds `predict::SelloutMarket<phantom T>` — parimutuel **binary** "will it sell out?" market (YES wins iff `event::minted >= max_tickets` snapshot at creation, settled at `start_ms`). Entry fns `create_sellout_market` / `bet_yes` / `bet_no` / `settle` / `claim`; events `MarketCreated` / `Bet` / `Settled`; errors 1–6. `event.move` unchanged (its `minted`/`start_ms`/`max_tickets`/`event_seq` getters were already public).
- **Type origin:** `SelloutMarket` + its events live at this v6 id, NOT the original `0x4233…` — Sui anchors a type to the version that introduced it.
- 48 Move tests pass (9 new predict tests covering pro-rata payout, one-sided pools, double-claim/expiry guards).

### Frontend
- `config.ts` adds `PACKAGE_ID_LATEST` (call targets for predict via `targetLatest`) + `SELLOUT_MARKET_TYPE`/`EV_*`. Allowlist gains the 5 predict targets. `lib/predict.ts` wrappers + Sellout Clock card on the event page. Gasless via the existing Enoki sponsor routes.

### On-chain smoke (testnet, succeeded)
- `create_sellout_market<USDC>(event 0x2ec7ae…, "Sui Dev meetup", strike 100)` → shared `SelloutMarket` `0xe50bbf4968db5b53f275df62db42ba3204bd6f1e8b2ab8a90562c6916f8237be`; `MarketCreated` emitted; card renders on the event page.

---

## Deploy, 2026-06-07T00:00:00Z (v5 — adds POAP + Seal access + forum)

Adds three modules to the v3 port for the full HostIt product build (Walrus + Seal + POAP + community): `poap` (proof-of-attendance NFT via shared registry, claimable by checked-in ticket holders), `access` (Seal `seal_approve_ticket`/`seal_approve_organizer`/`seal_approve_self` policies), `forum` (ticket-gated on-chain anchor for Walrus+Seal messages). Core ticketing modules unchanged. Fresh deploy (v3/v4 orphaned). 39 Move tests pass.

### Package
- **package id**: `0x423336143d4e5a810d24b97762bfa10be56b7d5dc86b75e831cb0897264b1e8d`
- modules: `hub`, `event`, `ticket`, `market`, `checkin`, `access`, `poap`, `forum`
- publish tx: `9rAc5yeffi4RNmfY8AFcYGrQQHwzcrwzZhWQWMXCwWZr`

| Object | ID | Owner |
|---|---|---|
| **Hub** | `0xa2b9ceb63babc6897932c6f4cfdbbddc9d3493d36691e4520278fc58090efabd` | shared |
| **PoapRegistry** | `0x57e285538f99b6bcc4d42e6adca2d2bb305cfb0c8b292094677fb70963d6021f` | shared |
| **TransferPolicy<Ticket>** | `0x3a8325aadee206476e5e71507d444e3fe2b25c11c9cd467503a8bba4e0ede8da` | shared |
| **PlatformCap** | `0x8bdebc3bb008e2f9648054d61ccbc0187053b0e877f50ca86781cf4291660597` | deployer |

### Integrations wired (frontend)
- **Walrus testnet** (publisher/aggregator HTTP): event metadata JSON + cover images; blob id in the event `uri`.
- **Seal testnet** (key server `0xb012…1e98`, pkg `0x8d90…54b2`): forum messages (ticket-gated) + KYC (self-gated), ciphertext on Walrus.
- **POAP**: `poap::claim_poap(registry, event, ticket)` after check-in.
- **forum**: `forum::post(event, ticket, channel, blob_id, clock)` anchors Seal+Walrus messages on-chain (`PostCreated` events).
- **Copilot**: `/api/copilot` → Anthropic Claude (model `claude-haiku-4-5`), grounded in event data, deterministic fallback.

---

## Deploy, 2026-05-31T00:00:00Z (v3 — HostIt EVM Diamond port, multi-module `hostit_ticket`)

Full re-architecture: a faithful Sui Move port of the HostIt EVM Diamond (`../ticket`,
`HostItTickets`). Replaces the v2 `TicketKind` prototype in place (package renamed
`sui_ticket` → `hostit_ticket`). v2 + v1 packages are orphaned on-chain.

### Network
- env: **testnet** · rpc: `https://fullnode.testnet.sui.io:443`
- gas address: `0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9`
- net publish cost: ~0.113 SUI

### Package
- **package id**: `0x6cf071ec35504a7d107110e0a4cce295a81bdbe3b6b26b2a5656dd105112cc91`
- modules: `hub`, `event`, `ticket`, `market`, `checkin`
- publish tx: `763Z2VqNvd7Peu2HdGanoBnz9JnApK2FRvaSNUCk5UPM`
- edition `2024.beta`, toolchain `sui 1.73.0`

### Objects minted at publish

| Object | ID | Owner |
|---|---|---|
| **`Hub`** (config + 3% fee treasury) | `0xb6aca69cb3b8d1fe750ab1906dcd016aac897a55a540b4500bab1ab4c7f7b0eb` | **shared** |
| **`PlatformCap`** | `0x5e72bc92efabdcb4d04f458456c782e4d69654a4d1260025ebb4d7be70fd4c79` | deployer |
| `Publisher` | `0x8e86162faf05459612ef1b44d2c17c8511bb9669c984a2cc5b2222f1bc4d175a` | deployer |
| `Display<Ticket>` | `0x450fcced6bad7913e1163842dc05f4cdcbbbe1e6a5a6b92958efc2acc8c9267a` | deployer |
| `TransferPolicy<Ticket>` | `0x776eff8e9956df83389840b89967b4ac364599ca1be48336387df0988b431e9a` | **shared** (empty rules in v1) |
| `TransferPolicyCap<Ticket>` | `0x64b21f44dc2dc0a0d5a1f4c8dfe95ec23703a2f5edbf95109d8ce3595c6f94ba` | deployer |
| `UpgradeCap` | `0x6f9a9175c48f9604e685fe4f65be25bb28f3e736df33ca2e8328ae1c56f16d95` | deployer |

Hub config confirmed on-chain: `fee_bps=300`, `refund_period_ms=259_200_000`, `royalty_bps=500`.

### Architecture (EVM → Sui)
- Diamond facets → modules `hub`/`event`/`market`/`checkin`; per-event ERC721 clone → one shared `Event` per event + one global `Ticket` type with an `event_id` field.
- `mapping(FeeType=>…)` → generic `Coin<T>` + dynamic fields (`PriceKey<T>`→u64, `EscrowKey<T>`→`Balance<T>` on Event; `FeeBalanceKey<T>`→`Balance<T>` on Hub). Launch coins: SUI (+ USDC pending the testnet coin-type lookup; core is generic).
- keccak role ids → capabilities: `PlatformCap` (protocol owner) + `OrganizerCap{event_id}` (per-event main admin); revocable check-in staff = ed25519 pubkey set on the Event.
- Check-in: attendee owns the Ticket and signs (sponsorable); admin-gated by an **ed25519 voucher** over `event_id(32)||ticket_id(32)||expiry_ms(8 LE)`, verified vs a registered signer pubkey. `self_check_in` fallback gated by `allow_self_checkin`. **Multi-day** attendance restored (per-(day,attendee) guard; status is an idempotent "used" marker).
- seconds → **milliseconds** throughout. Per-user cap = mints-per-address `>=`. Refund returns stored `paid` and transfers the ticket to the organizer.

### Quality
- 36 `test_scenario` tests, all passing; 0 warnings.
- Adversarial parity review (5 dimensions, 12 agents): 7 findings, 1 confirmed (multi-day check-in — fixed), 6 dismissed (boundary/overflow/throughput all parity-faithful or unreachable). Signer-key validation hardening added (reject non-32-byte / all-zero pubkey).

### On-chain smoke (testnet, all succeeded)
- `create_event` → shared `Event` `0x6604fb…` (event_seq 1) + `OrganizerCap` to sender.
- `create_event` (open window) + `set_price<SUI>(1_000_000)` + `buy_with_sui` → `Ticket` `0xd0c3b3…` minted, `TicketMinted{ serial:1, total_paid:1_000_000, coin_type: …0002::sui::SUI }`. Fee split (escrow + Hub) executed without abort.

### SDK wiring quick reference
```ts
export const PACKAGE_ID = "0x6cf071ec35504a7d107110e0a4cce295a81bdbe3b6b26b2a5656dd105112cc91";
export const HUB_ID = "0xb6aca69cb3b8d1fe750ab1906dcd016aac897a55a540b4500bab1ab4c7f7b0eb";
export const TRANSFER_POLICY_ID = "0x776eff8e9956df83389840b89967b4ac364599ca1be48336387df0988b431e9a";
export const CLOCK_ID = "0x6";
// Move targets:
//   ${PKG}::event::create_event(&mut Hub, name, symbol, uri, start_ms, end_ms,
//        purchase_start_ms, max_tickets, max_per_user, is_free, is_refundable, &Clock) -> OrganizerCap
//   ${PKG}::event::set_price<T>(&OrganizerCap, &mut Event, price)
//   ${PKG}::market::buy<T> / buy_with_sui(&mut Event, &mut Hub, Coin, recipient, &Clock)
//   ${PKG}::market::claim_free(&mut Event, recipient, &Clock)
//   ${PKG}::market::refund<T>(&mut Event, &Hub, Ticket, &Clock) -> Coin<T>
//   ${PKG}::market::withdraw_event_balance<T>(&OrganizerCap, &mut Event, &Hub, &Clock) -> Coin<T>
//   ${PKG}::hub::withdraw_platform_balance<T>(&mut Hub, &PlatformCap, amount, to) -> Coin<T>
//   ${PKG}::checkin::check_in(&mut Event, &mut Ticket, pubkey, sig, expiry_ms, &Clock)
//   ${PKG}::checkin::self_check_in(&mut Event, &mut Ticket, &Clock)
//   ${PKG}::event::{add_checkin_signer, remove_checkin_signer, set_allow_self_checkin, update_*}
```

### Manual step (sponsored tx, when frontend is re-wired)
- The Enoki portal allowlist must be updated to the v3 package's targets (replace all v2 `0x381599…` entries). The whole `web/` frontend still targets the v2 `TicketKind` prototype and needs re-wiring before sponsored tx are relevant.

---

## Deploy, 2026-05-29T00:00:00Z (v2 — single-concept TicketKind)

### Network
- env: **testnet**
- rpc: `https://fullnode.testnet.sui.io:443`
- gas address: `0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9`
- net cost: ~0.048 SUI (computation 0.001 + storage 0.047 − rebate 0.001)

### Package
- **package id**: `0x381599091baf265f9bd2454374af45a29c23fbcaae9938b9ff7bfae4466c8da1`
- modules: `ticketing`
- tx digest: `DycksQJdS7ccZqGWdmt8x2Qpivsrrh3MKGu4WqFA9CHr`
- upgrade cap object: `0xbb0199246c218ae089d1164c6ce349d3d33e834e382859876e4864efc5de9eaf`
- upgrade cap policy: **COMPATIBLE** (default)

### Objects minted at publish

| Object | ID | Owner |
|---|---|---|
| `UpgradeCap` | `0xbb0199246c218ae089d1164c6ce349d3d33e834e382859876e4864efc5de9eaf` | deployer |
| `Publisher` | `0x34c3b50bf5e30f30f3b0807f9cf982cb6e203258ba60dca17ac497474ec6866c` | deployer |
| `Display<Ticket>` | `0xb4f1707aedcac0d46b4d667adc00a2e4511bbed0a184cf62f27311de81138e6c` | deployer |
| `TransferPolicy<Ticket>` | `0x9d928801b213265d2917134f3e06b4faec10560cc7c6c159494c86e69f703d8d` | **shared** |
| `TransferPolicyCap<Ticket>` | `0x20eabdf09d1229d5ba0ae08a23d07ffd38f810f47dad7cdc8dadf4b94d3a14e5` | deployer |

### What changed vs v1 (`0xd1a0b7f4…c960cb`)
- **Drop `Issuer` + `IssuerCap` entirely.** Single concept: `TicketKind`.
- **Drop `register_issuer`.** One public action: `create_ticket_kind` — the wallet that signs becomes the kind's `creator`.
- **Admin auth via `ctx.sender()` check**, not by capability reference. `pause_kind` / `resume_kind` / `close_kind` / `update_kind_metadata` / `withdraw_revenue` now take `&mut TicketKind<C>` and `ctx`, and assert `kind.creator == ctx.sender()`.
- **`Ticket` no longer carries `issuer_id`.** It still has `kind_id`; the kind has the creator.
- **`TicketKind` gains `creator: address` and `creator_name: String`** (free-form brand name, was previously the Issuer object's `name`).
- **Events**: dropped `IssuerRegistered` and `IssuerRevoked`. `TicketKindCreated` now carries `creator + creator_name` directly — verification lookup no longer needs an extra event hop.

### What's orphaned (still on chain at old package, just unreachable from v2)
- v1 package + UpgradeCap, Publisher, Display, TransferPolicy, TransferPolicyCap
- Any Issuer / IssuerCap / TicketKind / Ticket instances created against v1

### Manual step still required
- **Enoki portal allowlist**: replace v1 targets with v2:
  - `0x381599091baf265f9bd2454374af45a29c23fbcaae9938b9ff7bfae4466c8da1::ticketing::create_ticket_kind`
  - `0x381599091baf265f9bd2454374af45a29c23fbcaae9938b9ff7bfae4466c8da1::ticketing::use_ticket`
  - `0x381599091baf265f9bd2454374af45a29c23fbcaae9938b9ff7bfae4466c8da1::ticketing::buy_ticket`
  - `0x381599091baf265f9bd2454374af45a29c23fbcaae9938b9ff7bfae4466c8da1::ticketing::buy_ticket_for`
  - Keep the seven `0x2::coin::*` and `0x2::balance::*` framework targets (unchanged).
  - Drop v1 entries (`…::register_issuer`, `…::register_issuer_and_create_kind`).

---

## Deploy, 2026-05-28T00:00:00Z (v1 — Issuer + IssuerCap model)

---

## Deploy, 2026-05-28T00:00:00Z

### Network
- env: **testnet**
- rpc: `https://fullnode.testnet.sui.io:443`
- gas address: `0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9`
- balance before: 8.57 SUI
- balance after: 8.52 SUI
- net cost: ~0.054 SUI (computation 0.001 SUI + storage 0.054 SUI − rebate 0.001 SUI)

### Package
- **package id**: `0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb`
- modules: `ticketing`
- package digest: `CDNGZGSEfiLWARFdeAPFDeEwZV6nAZKf1BLRkAD6f3NA`
- tx digest: `5v2YsQTBvfL7Y6H985XvsyUuDwJ7BzFkqPRSHa5PQ7Hm`
- upgrade cap object: `0x69a3afca264492d23a4d33702b153ab4ad56f4087f5ad6bdd1f3f16751e10988`
- upgrade cap policy: **COMPATIBLE** (policy value `0`; allows non-breaking upgrades)
- upgrade cap owner: deployer (`0xc856...c2d9`) — single-EOA on testnet; transfer to a multisig before mainnet deploy

### Objects minted at publish

| Object type | Object ID | Owner |
|---|---|---|
| `UpgradeCap` | `0x69a3afca264492d23a4d33702b153ab4ad56f4087f5ad6bdd1f3f16751e10988` | deployer |
| `Publisher` | `0xe0ca80b961108afbba747c1aaaf4abf12d7fe969b08faba5c835b0666ac13861` | deployer |
| `Display<Ticket>` | `0xd962098c2c1a1af80e2e6765619c401508f2b1dc7cfacc525b3ff31f4ebced68` | deployer |
| `TransferPolicy<Ticket>` | `0x031b9e4f1e81aeb582e62fc624984dce98c3c20416d24fbacfd22dfa2259d5ab` | **shared** (initial version 869435602) |
| `TransferPolicyCap<Ticket>` | `0xa45e2066b073f4935fa0c641cb7f9cc8e823559db7a1651fa2976470faf0d90b` | deployer |

### Notes
- TransferPolicy has **no royalty rule attached yet**. To enable Kiosk-aftermarket royalties, follow up with a PTB that calls `royalty_rule::add(policy, policy_cap, basis_points, min_amount)` from the deployer address. Track in build-context open issues.
- Sui CLI `--json` output is preceded by a `[NOTE]` banner about auto-added framework deps; capture commands must strip the preamble (we `tail -n +5`). See `/tmp/sui-ticket-publish.clean.json` for the parsed form.
- `Move.toml` pins `Sui` framework to `rev = "framework/testnet"`. Before promoting this package to mainnet, pin to a specific SHA and re-publish (a separate package id on mainnet).
- Lint suppressions in the module-level `#[allow(...)]` are intentional and documented in `build-context.md`.

### Quick reference for SDK wiring

```ts
export const SUI_TICKET_PACKAGE_ID =
  "0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb";
export const TRANSFER_POLICY_ID =
  "0x031b9e4f1e81aeb582e62fc624984dce98c3c20416d24fbacfd22dfa2259d5ab";
// Sui shared Clock (well-known): 0x6
export const CLOCK_ID = "0x6";

// Move targets (for tx.moveCall):
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::register_issuer
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::create_ticket_kind
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::buy_ticket
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::use_ticket
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::refund
//   ${SUI_TICKET_PACKAGE_ID}::ticketing::withdraw_revenue
```

### Smoke test (next step — exercise from the CLI)

```bash
# 1) Register an issuer (returns IssuerCap to sender)
sui client call \
  --package 0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb \
  --module ticketing --function register_issuer \
  --args '"Acme Tickets"' '[]' \
  --gas-budget 100000000

# After: capture the new Issuer (shared) ID and IssuerCap (owned) ID from objectChanges.

# 2) Create a ticket kind paying in SUI (C = 0x2::sui::SUI)
sui client call \
  --package 0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb \
  --module ticketing --function create_ticket_kind \
  --type-args 0x2::sui::SUI \
  --args <ISSUER_CAP_ID> <ISSUER_ID> '"GA Pass"' '"General admission"' '"https://img.example/ga.png"' \
         100 1000000 0 9999999999999 1 true \
  --gas-budget 100000000
```

The CLI flow above is for sanity-checking; for serious dapp use, switch to the TS SDK PTB pattern next (run `/suiper:ptb-composer`).
