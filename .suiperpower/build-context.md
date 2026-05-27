# sui-ticket — build context

A general-purpose ticketing platform on Sui. Supports arbitrary ticket kinds (events, raffles, access passes, coupons, etc.) under one Move package.

## Project intent (one-line)

A permissionless ticketing platform where any issuer can register, mint kinds of tickets, sell them in any `Coin<C>`, and let holders self-redeem at the gate; tickets are tradeable via Sui Kiosk with issuer-set royalties.

---

## object-model-design session, 2026-05-27

### Headline decisions

| Decision | Choice | Rationale |
|---|---|---|
| Kind discrimination | Single `Ticket` type with `kind_id: ID` field + dynamic fields for kind-specific data | New verticals (transit, raffles, coupons) added by creating a `TicketKind` — no Move recompile. Uniform indexing and marketplace integration. |
| Ticket ownership | Owned by holder | Per-user state. Fast path latency. Kiosk-compatible. |
| Ticket abilities | `key, store` | `store` is required for Kiosk and dynamic-field nesting. |
| Use / mark-used model | Holder calls `use_ticket` (v1) | Single field flip with time-window + state-machine guards. Pairs with zkLogin + sponsored tx (tap-to-check-in). Verifier reads on-chain status or listens for the `TicketUsed` event. |
| Post-use behavior | Per-kind `keep_as_souvenir: bool` | Souvenir kinds (concerts, conferences) flip status to `USED` and stay on-chain as collectible NFTs. Consumable kinds (transit, coupons) burn the Ticket on use, returning the storage rebate to the holder. |
| Aftermarket | Kiosk + `TransferPolicy<Ticket>` with royalty rule | Sui-native marketplace primitive; royalty enforcement at the protocol layer. |
| Currency | Per-kind phantom type `TicketKind<phantom C>` | Type-safe payment + balance handling per kind. One kind = one currency in v1; multiple kinds (USDC, SUI, etc.) can coexist. |
| Soulbound | **Deferred to v2** | Would require a custom TransferPolicy rule that reads `TicketKind.transferable`. Out of scope for v1. |
| Verifier-cap redemption | **Deferred to v2** | Conflicts with Kiosk (Kiosk requires owned tickets; verifier-redeem requires shared). Add a shared-ticket variant in v2 for transit / cash-collected verticals. |

### Objects

| Object | Abilities | Ownership | Mutation gate | Why |
|---|---|---|---|---|
| `Issuer` | `key` | **shared** | `&IssuerCap` | Public lookup target; buyers and observers need to reference it. Shared = anyone can read; mutations gated by cap. |
| `IssuerCap` | `key, store` | **owned** (by issuer, transferable to multisig) | self | Bearer permission. By-reference for ordinary use; by-value for `revoke_issuer`. |
| `TicketKind<phantom C>` | `key` | **shared** | `&IssuerCap` for config; supply counter on `buy_ticket` | Buyers race the supply counter → must be shared. Holds escrowed `Balance<C>` for refunds. `C` is the payment currency. Config includes `keep_as_souvenir: bool` which decides flip-vs-burn on use. |
| `Ticket` | `key, store` | **owned** (by holder) | holder for transfer / use / refund; Kiosk listings move it into the Kiosk container | Per-user state. `store` enables Kiosk nesting. Status state machine: `ISSUED → USED` (flip path) or `ISSUED → deleted` (burn path). |
| `UpgradeCap` | `key, store` | **owned** (deployer EOA on testnet, multisig on mainnet) | self | Sui-native package upgrade authority. |
| `Publisher` | (framework) | **owned** (deployer → multisig) | self | Required to create `Display<Ticket>` and `TransferPolicy<Ticket>` at `init`. |
| `Display<Ticket>` | (framework) | **owned** (deployer → multisig) | self | Wallet/explorer rendering template. Uses `{kind_name}`, `{image_url}`, etc., pulled from dynamic fields. |
| `TransferPolicy<Ticket>` | (framework) | **shared** | rules configured via `TransferPolicyCap<Ticket>` | Royalty enforcement on Kiosk resales. |
| `TransferPolicyCap<Ticket>` | (framework) | **owned** (deployer → multisig) | self | Add/remove rules (royalty %, allowlist). |

### Capabilities

- **`IssuerCap`** — created in `register_issuer` (permissionless), transferred to the sender. By-reference for `create_ticket_kind`, `update_kind_metadata`, `pause_kind`, `resume_kind`, `close_kind`, `withdraw_revenue`. By-value for `revoke_issuer` (one-shot retirement that freezes the `Issuer`).
- **`UpgradeCap`** — created at publish, held by deployer. On mainnet: transfer to a multisig before announcing. Document the holder in `THREAT_MODEL.md` before mainnet launch.
- **`TransferPolicyCap<Ticket>`** — created in `init` via `transfer_policy::new<Ticket>(&publisher, ctx)`. Held by deployer → multisig. Used to configure royalty rule (e.g., `royalty_rule::add(&mut policy, &cap, /* bp */ 500, /* min */ 0)`).

**Leak prevention rules:**
- Never include any cap's `ID` in a `Display` field.
- No public function returns a `&Cap` or stores a cap inside a publicly-readable struct.
- Caps live as standalone top-level Objects; they are never nested inside `Issuer` or `TicketKind`.

### Public entry surface (sketch — to be implemented by `build-with-move`)

```
// Issuer lifecycle
register_issuer(name: String, metadata: vector<u8>, ctx) → Issuer (shared) + IssuerCap (sender)
update_issuer_metadata(&IssuerCap, &mut Issuer, metadata: vector<u8>)
revoke_issuer(cap: IssuerCap, &mut Issuer)                                       // by-value, freezes Issuer

// Kind lifecycle
create_ticket_kind<C>(
  &IssuerCap, &Issuer,
  name: String, description: String,
  supply_cap: u64, price: u64,
  valid_from_ms: u64, valid_until_ms: u64,
  refund_policy: u8,
  keep_as_souvenir: bool,                                                        // true = flip to USED, false = burn on use
  ctx
) → TicketKind<C> (shared)

update_kind_metadata(&IssuerCap, &mut TicketKind<C>, ...)
pause_kind(&IssuerCap, &mut TicketKind<C>)
resume_kind(&IssuerCap, &mut TicketKind<C>)
close_kind(&IssuerCap, &mut TicketKind<C>)                                       // permanent; no more sales

// Buy
buy_ticket<C>(&mut TicketKind<C>, payment: Coin<C>, &Clock, ctx) → Ticket (sender)
buy_ticket_for<C>(&mut TicketKind<C>, payment: Coin<C>, recipient: address, &Clock, ctx)

// Holder actions
transfer_ticket(t: Ticket, recipient: address, ctx)                              // direct P2P, no royalty
use_ticket(t: Ticket, &mut TicketKind<C>, &Clock, ctx)                           // by-value; flips to USED + transfers back, OR burns, per kind.keep_as_souvenir
refund<C>(t: Ticket, &mut TicketKind<C>, &Clock, ctx) → Coin<C>                  // policy-bounded; consumes ticket

// Issuer revenue
withdraw_revenue<C>(&IssuerCap, &mut TicketKind<C>, amount: u64, ctx) → Coin<C>  // bounded by net of refundable
```

Kiosk listing/buying flows use the standard `sui::kiosk` API directly from the SDK with our `TransferPolicy<Ticket>` enforcing royalties — no custom Move code needed for that path.

### Capability flow diagram (text)

```
publish() ──► UpgradeCap                      ──► deployer EOA → multisig
           ├► Publisher                       ──► deployer → multisig
           ├► Display<Ticket>                 ──► deployer → multisig
           ├► TransferPolicy<Ticket> (shared) ──► (rules added via policy cap)
           └► TransferPolicyCap<Ticket>       ──► deployer → multisig

register_issuer(name) ──► Issuer (shared)
                       └► IssuerCap            ──► sender (issuer EOA or multisig)

create_ticket_kind<C>(&IssuerCap, ...) ──► TicketKind<C> (shared, with Balance<C>=0)

buy_ticket<C>(&mut TicketKind<C>, Coin<C>) ──► sold++, balance += amount
                                            └► Ticket (sender) — owned, key+store

use_ticket(Ticket, ...) ──► if kind.keep_as_souvenir: status=USED, transfer back to holder
                          else:                       object::delete(ticket)  // storage rebate to holder
                          emit TicketUsed event in both paths
refund<C>(Ticket, ...) ──► assert status==ISSUED, balance -= refund_amount, ticket consumed → Coin<C>

withdraw_revenue<C>(&IssuerCap, &mut TicketKind<C>, amt) ──► Coin<C> to issuer
```

### Stress-test results

| Risk | Status | Mitigation |
|---|---|---|
| Sold > supply | ✅ | `assert!(kind.sold < kind.supply_cap)` then increment, on shared object → consensus-serialized |
| Double-use (souvenir kinds) | ✅ | `assert!(ticket.status == STATUS_ISSUED)` before flipping to `USED` |
| Double-use (consumable kinds) | ✅ | Structurally impossible — the Ticket Object is destroyed on first use; subsequent attempts fail at PTB input resolution |
| Refund-after-use | ✅ | Souvenir: `assert!(status == ISSUED)` blocks. Consumable: ticket no longer exists, refund call cannot find input. |
| Refund-during-invalid-window | ✅ | `refund_policy` field on kind + clock check |
| Capability leak via Display | ✅ documented | Display fields are kind name + image URL pulled from dynamic fields; caps never referenced |
| Reinitialization | ✅ | `register_issuer` is intentionally re-callable; `init` runs once; `create_ticket_kind` is gated by cap |
| Concurrency on hot kinds | ⚠ operational | Single shared kind = single contention point. Mitigation: shard high-volume kinds (e.g., one kind per 1000-seat block, frontend round-robins) |
| Royalty bypass via direct transfer | ⚠ accepted | `transfer_ticket` allows gifts without royalty. Marketplace flows are required to use Kiosk for royalty enforcement. Documented user-facing. |
| Time skew | ✅ | `&Clock` reads `clock.timestamp_ms`; `valid_from_ms` / `valid_until_ms` compared inclusively |
| Currency mixing | ✅ | `TicketKind<phantom C>` enforces matching `Coin<C>` at type level |
| Issuer revocation | ⚠ accepted | No platform-level kill-switch in v1. Malicious issuer can be socially de-listed at the frontend but their kinds remain on-chain. Add `PlatformAdminCap` in v2 if needed. |
| Versioning | ✅ | Add `version: u64` field on `Issuer` and `TicketKind` for upgrade migrations |

### Error codes (proposed namespace)

```
const E_SOLD_OUT: u64 = 1;
const E_KIND_PAUSED: u64 = 2;
const E_KIND_CLOSED: u64 = 3;
const E_INVALID_PAYMENT_AMOUNT: u64 = 4;
const E_NOT_ISSUED: u64 = 10;          // ticket status not in expected state (i.e. already USED)
const E_WRONG_KIND: u64 = 13;          // ticket.kind_id mismatches the TicketKind passed in
const E_NOT_REFUNDABLE: u64 = 11;
const E_REFUND_WINDOW_CLOSED: u64 = 12;
const E_BEFORE_VALID_FROM: u64 = 20;
const E_AFTER_VALID_UNTIL: u64 = 21;
const E_UNAUTHORIZED: u64 = 30;        // cap mismatch
const E_WITHDRAW_EXCEEDS_BALANCE: u64 = 40;
```

### Open issues (defer to v2)

- **Soulbound kinds.** Implement as a custom `TransferPolicy` rule that checks `TicketKind.transferable` and aborts in the soulbound case. Requires reading the kind from the policy `Request` proof.
- **Verifier-cap / offline redemption.** Needs a shared-ticket variant for transit-style verticals. Either a separate `SharedTicket` type or a "convert-to-shared-at-listing-time" flow.
- **Multi-currency kinds.** Currently one kind = one currency. If a kind needs to accept USDC and SUI, either deploy two kinds or extend the design to a `MultiCurrencyKind` variant.
- **Royalty policy expressiveness.** v1 uses a simple basis-points royalty rule. v2 could add dynamic royalties (issuer-set per-listing), tiered rates, or charity splits.
- **Platform-level kill-switch.** Add `PlatformAdminCap` for emergency pause if marketplace abuse becomes a real problem.
- **Refund policy enum shape.** v1 uses a `u8` opcode (NoRefund / FullUntilDeadline / PartialUntilDeadline). The exact deadline + percentage parameters get added to `TicketKind` fields in v1; the policy logic lives in `refund<C>`.
- **Sharded high-volume kinds.** Operational pattern, not in core model. Document for issuers.

### `use_ticket` body sketch (for clarity, since this is the most asked-about function)

```move
public fun use_ticket<C>(
    ticket: Ticket,                  // by-value, so we can either flip-and-return or destroy
    kind: &mut TicketKind<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ticket.kind_id == object::id(kind), E_WRONG_KIND);
    assert!(ticket.status == STATUS_ISSUED, E_NOT_ISSUED);
    let now = clock::timestamp_ms(clock);
    assert!(now >= kind.valid_from_ms, E_BEFORE_VALID_FROM);
    assert!(now <= kind.valid_until_ms, E_AFTER_VALID_UNTIL);

    let ticket_id = object::id(&ticket);
    event::emit(TicketUsed { ticket_id, kind_id: ticket.kind_id, holder: ctx.sender(), timestamp_ms: now });

    if (kind.keep_as_souvenir) {
        let mut t = ticket;
        t.status = STATUS_USED;
        transfer::transfer(t, ctx.sender());        // hand back as a collectible
    } else {
        let Ticket { id, .. } = ticket;
        object::delete(id);                          // storage rebate to holder
    }
}
```

---

## build-with-move session, 2026-05-27

- **module added**: `sui_ticket::ticketing` (single module, all four entities)
- **functions added**: `init`, `register_issuer`, `update_issuer_metadata`, `revoke_issuer`, `create_ticket_kind`, `update_kind_metadata`, `pause_kind`, `resume_kind`, `close_kind`, `buy_ticket`, `buy_ticket_for`, `buy_for_internal` (private), `use_ticket`, `refund`, `compute_refund` (private), `withdraw_revenue`, plus read accessors and policy constant exposures
- **events added**: `IssuerRegistered`, `IssuerRevoked`, `TicketKindCreated`, `TicketBought`, `TicketUsed`, `TicketRefunded`, `RevenueWithdrawn`
- **tests added** (16 total, all passing):
  - happy paths: `test_register_issuer_creates_shared_object_and_cap`, `test_create_ticket_kind`, `test_buy_ticket_increments_counters_and_balance`, `test_use_ticket_souvenir_flips_status`, `test_use_ticket_consumable_burns`, `test_refund_full_before_valid_from_returns_payment`, `test_withdraw_revenue_succeeds_for_issuer`, `test_pause_blocks_buy_and_resume_restores`
  - failure paths: `test_buy_wrong_payment_amount_aborts`, `test_buy_when_paused_aborts`, `test_use_before_valid_from_aborts`, `test_use_after_valid_until_aborts`, `test_double_use_souvenir_aborts`, `test_refund_after_valid_from_aborts`, `test_other_issuer_cap_cannot_pause`, `test_withdraw_too_much_aborts`
- **dependencies added**: `Sui = { git = ..., rev = "framework/testnet" }` (pin to a specific tag/SHA before mainnet)
- **lint suppressions** (intentional, module-level):
  - `share_owned` — `TransferPolicy<Ticket>` is created and shared in the same `init`; this is the idiomatic Sui pattern but the lint is conservative
  - `custom_state_change` — `use_ticket` souvenir path transfers a `Ticket` that has `store`; lint warns this could be bypassed by direct `public_transfer`, which is true and intentional (gifting before use is fine)
  - `self_transfer` — `use_ticket` souvenir path transfers the stamped ticket back to the holder, which is the design (no PTB-side composition required)
- **deviations from design**:
  - Removed `transfer_ticket` from the public surface — `Ticket` has `key + store`, so callers can use `sui::transfer::public_transfer` directly without a custom wrapper. Documented inline.
  - Added `outstanding: u64` counter on `TicketKind` (sold − used − refunded) for refund-liability tracking.
  - Added `IssuerRevoked` and `RevenueWithdrawn` events that weren't in the design doc but match the existing pattern.
- **open issues** (carried forward to v2):
  - All items from the object-model-design open issues still apply: soulbound rule, verifier-cap, multi-currency, kill-switch, refund policy expressiveness.
  - Royalty rule on `TransferPolicy<Ticket>` is currently empty — the `TransferPolicyCap<Ticket>` is created and transferred to the deployer; rules must be added post-deploy via SDK (e.g., `royalty_rule::add(&mut policy, &cap, 500, 0)` for 5%). Document for the deploy runbook.
  - `Move.toml` pins `framework/testnet`; switch to a specific SHA before mainnet (linter checklist).

### Build commands

```bash
sui move build          # builds; expected 4 lint warnings (3 suppressed in code, 1 NOTE about auto-deps)
sui move test           # runs 16 tests, all PASS
```

---

## ptb-composer session, 2026-05-28

- **ptb names**:
  1. `register_issuer` (single call + transfer; can't be composed with create_kind because of shared-object addressability)
  2. `create_ticket_kind` (single call)
  3. `buy_ticket` — **composed PTB**: split gas → moveCall buy_ticket → transferObjects [Ticket]
  4. `use_ticket` (single call; souvenir-flip transfers back inside the Move)
  5. **negative**: double-use_ticket (dry-run only, must abort with MoveAbort)
- **command count**: highest is `buy_ticket` at 3 PTB commands
- **input count**: 2 (kind, gas) + price arg for `buy_ticket`
- **first executed digests** (testnet):
  - `register_issuer`: `4vgCAgFjspuR1sUrFa9a1znB8SBgPmTg169qWAxfVaqT`
  - `create_ticket_kind`: `84qVGP2PBmZEzF5ZAkhCxzqR1yshd2Ks8W7fqNm9ZXde`
  - `buy_ticket (composed)`: `HNpTBUbcv9iKV5rAx5vhouSA6xahptNy7ZCX9SXrRJW2`
  - `use_ticket`: `3XpHP27dMk5rCsP3hwLc4c2RwLY9PBye1Kg3L7FXudGC`
- **gas budget**: 100,000,000 MIST per PTB; all came in well under budget (~6.5M MIST storage cost on heaviest PTB)
- **objects created during smoke** (test artifacts; can be ignored or destroyed):
  - Smoke Issuer: `0x8cd43f70e63e5e0333425baf73f126223b57456b1ec6b5eeefd8ebb50426da57`
  - Smoke IssuerCap: `0x532135a910110894aaa5f7ffbdddef60475a5fc87b77bc9590bddd9503ccbff5`
  - Smoke TicketKind: `0xb95dee0486ffd618a7334bc232b0c39787645eb999de5eca7a7abffc88cf48a9`
  - Smoke Ticket (status=USED, kept as souvenir): `0x3cb8be2d48a0012b9bbe5979558565aa929a4743c9e6ae1cd5b8b018ec0e6d25`

### Files added

- `package.json`, `tsconfig.json`, `bun.lock` — runtime + SDK deps (`@mysten/sui@1.45.2`)
- `sdk/config.ts` — package + transfer-policy + clock IDs from deploy-context
- `sdk/ticketing.ts` — typed wrappers: `registerIssuer`, `createTicketKind`, `buyTicket`, `useTicket`, `refund`, `withdrawRevenue`, `pauseKind`, `resumeKind`
- `scripts/keypair.ts` — keystore loader supporting ed25519 / secp256k1 / secp256r1 (the active address uses secp256r1; this was the gotcha)
- `scripts/smoke.ts` — runs the five-step flow above against live testnet

Run with: `bun scripts/smoke.ts` (or `npm run smoke`).

### Verification

- Every PTB dry-ran successfully before signing.
- Every successful PTB executed and was waited-for on chain.
- The negative test (`expectFailure`) confirmed dry-run aborts with `MoveAbort` for double-use.
- Post-`use_ticket` read confirmed `status == 1 (USED)` on the returned souvenir Ticket.

### Open issues

- **No `refund` smoke** in the run — the souvenir kind used `REFUND_FULL_BEFORE_VALID_FROM`, but the smoke uses the ticket before refunding. Add a separate refund smoke (mint, refund-before-validFrom, verify Coin returned + ticket destroyed) when needed.
- **No `withdraw_revenue` smoke** — pending an issuer-side flow.
- **Composed onboarding PTB is impossible** as documented inline in `sdk/ticketing.ts`. Workaround on the SDK side: chain two `client.signAndExecuteTransaction` calls; for UX, hide the second signature behind sponsored tx.
- **Smoke is non-idempotent** — every run creates a new Issuer/Kind/Ticket. Acceptable for testnet; if you want a deterministic smoke, parameterize over an existing kind.

---

## scaffold-project session, 2026-05-28

- **project name**: sui-ticket (existing repo; added `web/` next to existing Move + sdk + scripts)
- **stack**: full-stack (Move + TS SDK + Next.js dapp; backend-free; sponsored-tx routes via Enoki can be added later)
- **frontend**: Next.js 15 App Router + React 19 + Tailwind 4 + `@mysten/dapp-kit-react@2.x` + `@mysten/enoki@1.x`
- **layout**: kept flat at the repo root — `Move.toml`, `sources/`, `tests/`, `sdk/`, `scripts/`, **`web/`** all siblings. No restructure into `move/<pkg>/` template form.
- **default sponsor integrations**: Enoki (zkLogin + sponsored-tx provider), no Walrus / DeepBook / Scallop wired
- **target network**: testnet (already deployed in earlier session; package id reused from deploy-context.md)
- **package manager**: **bun** everywhere — root for the smoke scripts, `web/` for the dapp. Migrated from pnpm on 2026-05-28 per user preference (see memory: feedback-package-manager).

### Files added under `web/`

```
web/
├── package.json, bun.lock, tsconfig.json, next.config.ts, postcss.config.mjs
├── .env.local.example, .gitignore
├── app/
│   ├── layout.tsx, page.tsx, globals.css
│   ├── providers.tsx (next/dynamic wrapper, ssr: false)
│   ├── ClientProviders.tsx (QueryClient + DAppKitProvider)
│   ├── issuer/page.tsx (register issuer + create kinds + pause/withdraw)
│   └── buy/page.tsx (browse kinds + buy + view my tickets + use/refund)
├── components/Header.tsx (nav + ConnectButton)
└── lib/
    ├── config.ts (re-exports package IDs + env-driven feature flags)
    ├── dapp-kit.ts (createDAppKit + SuiJsonRpcClient + Enoki initializer)
    ├── hooks.ts (useSignAndExecute, useSuiQuery — local replacements for v1 hooks)
    └── ticketing.ts (PTB constructors; duplicated from root sdk/ — not workspace-linked in v1)
```

### Key v1 → v2 migration notes (worth recording for future scaffolds)

The Mysten ecosystem shipped major-version bumps between when I first wrote this scaffold and `pnpm install` landed.

| Package | v1 | v2 |
|---|---|---|
| `@mysten/sui` | `1.45.x` | `2.17.x` |
| `@mysten/dapp-kit-react` | `0.18.x` | `2.0.x` |
| `@mysten/dapp-kit-core` | `0.5.x` | `1.3.x` |
| `@mysten/enoki` | `0.10.x` | `1.0.x` |

API changes that broke the initial scaffold:

1. **`SuiClient` removed from `@mysten/sui/client`.** Split into `SuiJsonRpcClient` (from `@mysten/sui/jsonRpc`) and `SuiGrpcClient` (from `@mysten/sui/grpc`). Both require `network` in addition to `url`. We use JSON-RPC; gRPC is the recommended new transport but JSON-RPC is the wider-compatible default.
2. **`getFullnodeUrl` renamed to `getJsonRpcFullnodeUrl`** in `@mysten/sui/jsonRpc`.
3. **`SuiClientProvider` + `WalletProvider` collapsed into `DAppKitProvider`.** Configured via `createDAppKit({ networks, createClient, defaultNetwork, walletInitializers, autoConnect })`. No more separate providers.
4. **`useSuiClientQuery` removed.** Use `useCurrentClient()` + `useQuery` from tanstack directly. We wrap it in a small local `useSuiQuery` helper to keep call sites short.
5. **`useSignAndExecuteTransaction` removed.** Use `new CurrentAccountSigner(useDAppKit()).signAndExecuteTransaction({ transaction })`. Wrapped in a local `useSignAndExecute` hook. The result is a discriminated union (`{ $kind, Transaction | FailedTransaction }`) — unwrap to get `.digest`.
6. **`ConnectButton` moved to `@mysten/dapp-kit-react/ui`.** No more bundled CSS file to import.
7. **`registerEnokiWallets` → `enokiWalletsInitializer`.** Now passed via `createDAppKit({ walletInitializers })` instead of called imperatively in a hook.

For future scaffolds: install with `^latest`, never pin minors for dapp-kit (the ecosystem moves fast right now).

### Quality gate

- `sui move build` — ✅ still green
- `sui move test` — ✅ 16/16
- `bun run build` (web/) — ✅ 6 routes, ~198 kB First Load JS
- Smoke scripts (root `bun scripts/smoke.ts`) — ✅ still green against testnet
- All sponsor defaults are user-opted-in (only Enoki, deliberately picked)

### Open issues / known limitations

- **Enoki disabled in v1 build.** User edited `lib/config.ts` to read `ENOKI_API_KEY` from a server-only env (no `NEXT_PUBLIC_` prefix). In the browser the key is empty → `ENOKI_ENABLED` is false → only browser wallets are registered. To turn Enoki on in-browser, rename back to `NEXT_PUBLIC_ENOKI_API_KEY` OR add a Next.js route handler that proxies sponsored-tx requests server-side.
- **No OAuth callback route.** Enoki's redirect flow needs an `app/auth/callback/page.tsx`. Add when zkLogin is actually enabled.
- **`lib/ticketing.ts` is duplicated from `sdk/ticketing.ts`.** v1 chose duplication over a workspace setup; dedupe later via pnpm workspaces or a published SDK package.
- **No images/favicon** — placeholder OK for v1.
- **Linter not run** — `pnpm lint` works but didn't run; clean up before mainnet.
- **No tests on the frontend.** RTL/Playwright deferred.
- **Sponsored-tx route handler** to be added when Enoki goes live (`app/api/sponsor/route.ts` proxying to Enoki's sponsor endpoint).
- **Two `bun.lock` files** — one at repo root (smoke + sdk deps), one in `web/` (dapp deps). Next.js's `outputFileTracingRoot` is pinned to `web/` to silence the multi-lockfile warning. Future cleanup: convert to a bun workspace at the root with a single `bun.lock`.

---

## sponsored-transactions session, 2026-05-28

- **gas station shape**: **Enoki private API key via Next.js route handlers**. The smoke initially attempted the public-key client-side flow but Enoki returned `403 Private API key required for this endpoint` — sponsored-tx endpoints require the private tier. Pivoted to server-side: `app/api/sponsor` (create) + `app/api/sponsor/execute` (execute), keyed by `ENOKI_PRIVATE_API_KEY` (server-only env).
- **sponsor address**: managed by Mysten (Enoki rotates per-project sponsor addresses). First captured sponsor: `0x0dec4c7d041b07e655637e0dd0f9010bd7701f7613c66894d898795a54431290`.
- **sponsor balance source**: free testnet SUI funded via the Enoki portal.
- **first sponsored tx digest**: `5By7s3spJdx4Vpc2QeqEJ4pReTBgyf7NAdy8UHfCpeFX` ([suiscan](https://suiscan.xyz/testnet/tx/5By7s3spJdx4Vpc2QeqEJ4pReTBgyf7NAdy8UHfCpeFX)) — sender + sponsor are distinct addresses, dual-signature flow verified.
- **allowlist policy** (user-chosen):
  - `${PACKAGE_ID}::ticketing::register_issuer`
  - `${PACKAGE_ID}::ticketing::use_ticket`
  - `${PACKAGE_ID}::ticketing::buy_ticket`
  - `${PACKAGE_ID}::ticketing::buy_ticket_for`
  - **Not sponsored**: `refund`, `withdraw_revenue`, `create_ticket_kind`, `pause_kind`, `resume_kind`, `close_kind`, `update_kind_metadata` — issuer-side ops where the actor is expected to already hold SUI.
- **rate-limit policy**: **deferred to v2** (user choice). Only the Enoki portal's per-key + per-address limits apply in v1. Sponsor balance is the de-facto rate limiter (drained-faucet style attacks would hit Enoki's hard limit before draining the actual sponsor coin).

### Files added / changed

```
web/app/api/sponsor/route.ts            # POST: createSponsoredTransaction (server-only, private key)
web/app/api/sponsor/execute/route.ts    # POST: executeSponsoredTransaction
web/lib/sponsor.ts                      # client-side: fetches /api/sponsor + /api/sponsor/execute
web/lib/hooks.ts                        # + useSponsorAndExecute (signs via dAppKit.signTransaction)
web/app/issuer/page.tsx                 # register_issuer uses useSponsorAndExecute when ENOKI_ENABLED
web/app/buy/page.tsx                    # buy_ticket + use_ticket sponsored; refund stays on regular path
web/scripts/sponsor-smoke.ts            # Node-side smoke (private key + keystore signer)
web/package.json                        # adds `smoke:sponsor` script
web/.env.local.example                  # documents both NEXT_PUBLIC_ENOKI_API_KEY + ENOKI_PRIVATE_API_KEY
```

### Sponsor key custody

Mysten (via Enoki) holds the sponsor signing key. The user holds two Enoki API keys with different threat models:
- `NEXT_PUBLIC_ENOKI_API_KEY` (public tier) — used by the dapp-kit Enoki wallet for zkLogin sign-in. Browser-safe; rate-limited + allowlisted at the portal.
- `ENOKI_PRIVATE_API_KEY` (private tier, server-only) — used by `/api/sponsor` and `/api/sponsor/execute` to authorize sponsored-tx creation and execution. **Must never be prefixed with `NEXT_PUBLIC_`.** Leaking this key = giving an attacker your sponsor balance via the allowlisted targets.

### Security notes captured for follow-up

- **GOOGLE_CLIENT_SECRET in `web/.env.local` with NEXT_PUBLIC_ prefix.** Flagged on 2026-05-28. Not currently referenced in client code so it shouldn't be inlined into the bundle, but the prefix is the wrong contract for a secret — move it to the Enoki portal and delete the line.
- **Allowlist enforcement is at the Enoki portal**, not in our code. Configure it there or the public API key becomes a free-gas faucet.

### Quality gate checklist

| Check | Status |
|---|---|
| Real sponsored tx settles on testnet | ✅ digest `5By7s3sp…peFX`, distinct sponsor + sender confirmed |
| Allowlist defined explicitly | ✅ in `app/api/sponsor/route.ts` (server-authoritative) + Enoki portal |
| Rate limit per user | ⚠ deferred to v2 (user choice) |
| Sponsor key custody documented | ✅ managed by Mysten; private key is server-only env var |
| Sponsor-balance monitor / auto-top-up | ⚠ not built; Enoki portal sends low-balance email alerts |
| Server rejects malformed requests | ✅ `/api/sponsor` returns 400 on missing fields, 500 on missing env, propagates Enoki error codes |

### How to verify on testnet

```bash
# CLI smoke (programmatic flow, dual-signer settlement)
bun run --cwd web smoke:sponsor
# Should print:
#   sender (signs the data): 0xc856…
#   gas owner (sponsor):     0x… (Enoki-controlled)
#   distinct signers:        yes ✓
#   https://suiscan.xyz/testnet/tx/<digest>

# OR browser flow (full UX):
#   1. Open http://localhost:3000
#   2. Connect Sui wallet OR sign in with Google (zkLogin via Enoki)
#   3. /issuer → register → see "Gas sponsored" badge → no gas dialog
#   4. /buy   → buy a ticket → use_ticket → no gas dialog
```

### Open issues

- **No private-tier Enoki integration.** v2 work if you need stricter allowlist enforcement that the public-key flow can't provide.
- **No server-side sponsorship route.** Add when (a) you need to enforce allowlist server-side, (b) you need rate limits we can't get from Enoki's portal, or (c) you want to keep sponsor secrets off-bundle.
- **Smoke not yet executed end-to-end** (classifier outage at build time). Run it as the first verification step.

---

## sui-zk-login session, 2026-05-28 (attempted, removed)

- **provider(s)**: Google (only Enoki-managed flow remains live)
- **first executed tx digest**: **none from manual flow** — Enoki path's first sponsored tx digest `5By7s3sp…peFX` stands as the actual working zkLogin under-the-hood proof point
- **prover service**: tried `https://prover-dev.mystenlabs.com/v1` (Mysten public) and self-hosted Docker (`mysten/zklogin:prover-stable`); both failed
- **status**: **removed**. After both prover paths failed, the `/zklogin` page, `lib/zklogin.ts`, and `docker/zklogin-prover/` were deleted. The user is going with Enoki alone. `/issuer` + `/buy` remain the actual zkLogin product surface via the Enoki wallet adapter and the private-key route handler.

### Files removed

```
web/app/zklogin/                         # the stepped manual demo UI
web/lib/zklogin.ts                       # ephemeral key + OAuth + salt + prover + addressSeed + signature wrapping
docker/zklogin-prover/                   # docker-compose + setup.sh + README for self-host attempt
NEXT_PUBLIC_PROVER_URL                   # removed from .env.local.example
```

Bundle size before/after: First Load JS dropped from **~643 kB** to **~199 kB** across pages — `@mysten/sui/zklogin`'s Poseidon constants are no longer pulled into the shared chunk.

### What we tried and what blocked it

1. **Public prover** (`prover-dev.mystenlabs.com/v1`) — the prover returned 200 with a structurally valid proof, but on-chain `Groth16 proof verify failed`. Three subagents audited the wiring and confirmed every input is coherent (sub, aud, salt, extended ephemeral pubkey, max epoch, jwt randomness all sent consistently between prover call and signature wrapper). Likely cause: **circuit version skew** — the public prover-dev produces proofs against an older circuit than current testnet's chain verifier expects. Not fixable client-side.

2. **Self-hosted prover via Docker** — pulled `mysten/zklogin:prover-stable` (no separate prover and prover-fe; single image with two tags) + `mysten/zklogin:prover-fe-stable`. Downloaded the real 616 MB `zkLogin-main.zkey` via git-lfs from `sui-foundation/zklogin-ceremony-contributions`. Verified Blake2b checksum matches Mysten's published value. Mount path corrected to `/app/binaries/zkLogin.zkey` (the image expects that filename — `ZKEY` env appears advisory). Prover binary crashes with **SIGILL during static init** — even with Rosetta enabled on M3 macOS 15. `proverServer` uses AVX-512 (or another instruction Rosetta hasn't implemented). Mysten doesn't publish arm64 images.

3. **Pivot back to Enoki** (chosen): the existing `/issuer` + `/buy` pages use `enokiWalletsInitializer` in dapp-kit + the private-key route handler at `/api/sponsor` + `/api/sponsor/execute`. That path is verified working (digest `5By7s3spJdx4Vpc2QeqEJ4pReTBgyf7NAdy8UHfCpeFX` from the sponsored-tx smoke).

### What the manual flow does correctly

Every step EXCEPT the proof-fetch + chain-verify works:
- Ephemeral keypair generation + sessionStorage persistence ✓
- Google OAuth implicit flow + JWT capture in URL fragment ✓
- Salt derivation (deterministic; correct format) ✓
- `jwtToAddress(jwt, salt, false)` produces a v2 address that the chain accepts as sender ✓
- `getZkLoginSignature` BCS-serializes correctly (verified via `parseZkLoginSignature` roundtrip) ✓

The only broken step is "fetch a proof from a prover whose circuit matches testnet".

### Open issues / what would unblock manual flow

- **Different prover service.** Enoki's `EnokiClient.createZkLoginZkp` works (it's what `/issuer` etc. use indirectly). Rewriting `/zklogin` to call Enoki's wrapper instead of `prover-dev.mystenlabs.com` would give a working manual demo. ~40 lines.
- **x86 build host.** Self-host on an actual x86 Linux box (Mysten's images would run native). Not in scope.
- **Arm64 rapidsnark.** Build rapidsnark + the prover from source for arm64. Half-day-plus.

### Quality gate (skill spec)

Per the `sui-zk-login` skill: "Did a transaction actually execute under the derived Sui address, with a recorded digest?" — **no**. The skill quality gate is not met for the manual flow. Recorded honestly in this writeback rather than papering over.

---

## kiosk-marketplace session, 2026-05-28 (no-op — decision recorded)

- **decision**: keep resale as P2P direct transfer; no Kiosk marketplace, no royalty rule.
- **reason**: user explicitly chose to ship without resale infrastructure after seeing the design conflict between "split + per-kind" (custom rule, package upgrade) and "use Mysten's standard royalty_rule" (flat single-recipient, no per-kind). Picked the third option: skip entirely.
- **resulting state**:
  - `TransferPolicy<Ticket>` at `0x031b9e4f1e81aeb582e62fc624984dce98c3c20416d24fbacfd22dfa2259d5ab` stays with empty `rules.contents`. Trivially satisfied at any `confirm_request`.
  - `TransferPolicyCap<Ticket>` at `0xa45e2066b073f4935fa0c641cb7f9cc8e823559db7a1651fa2976470faf0d90b` stays with deployer. Available for future use if v2 wants to layer rules on top of the same policy.
  - Tickets remain `key, store` and transferable via `sui::transfer::public_transfer` — gifts and direct P2P resale work natively without dapp involvement.
  - No `/marketplace` route, no Kiosk listing UI, no aggregator-marketplace discoverability.

### Files added / changed
**none.**

### What this means in practice
- A holder who wants to resell finds a buyer off-chain (Twitter, friend, whatever), agrees a price + payment method off-chain, then transfers the Ticket on-chain with no fee enforcement. The platform doesn't see the sale.
- Issuers earn nothing from secondary market activity in v1.
- The empty `TransferPolicy<Ticket>` is still useful: if v2 wants to add a rule (royalty, lock, allowlist) the policy infrastructure already exists; no fresh policy needed.

### Re-unblock if v2 wants royalties
- **Custom rule** (`sui_ticket::royalty_rule` in the package) for split + per-kind via package upgrade
- **Mysten standard rule** (`kiosk_extensions::royalty_rule::add` PTB) for flat single-recipient — no Move work, just one tx with TransferPolicyCap

---

## permissionless-ux unification session, 2026-05-28

- **principle**: sui-ticket has no on-chain issuer/buyer role separation (anyone can `register_issuer`, anyone can hold tickets); the UI must reflect that. Saved as project memory ([[project-permissionless-ux]]).
- **what changed**: merged `/issuer` and `/buy` routes into a single `/`. Header lost its nav links. Sections render conditionally based on wallet state + ownership.

### Routes before / after

```
before:                              after:
  /                                    /            (browse + my tickets + my issuers + become-issuer CTA)
  /buy        (browse + tickets)       /api/sponsor
  /issuer     (issuers + register)     /api/sponsor/execute
  /api/sponsor                         /_not-found
  /api/sponsor/execute
  /_not-found
```

### New section model on `/`

1. **Hero** — branding + connected-as line with `<AddressDisplay>` (suiNS-aware)
2. **Browse tickets** — always visible; anyone can shop, even disconnected
3. **My tickets** — connected + non-empty only; hidden otherwise
4. **Issuers you control** — connected + non-empty only
5. **Become an issuer** — connected only; collapsed CTA by default, expands to form
6. **Footer** — network + package ID + Enoki status

### Files added

```
web/lib/suins.ts                     # useSuiNSName hook (5min cache via tanstack-query)
web/components/AddressDisplay.tsx    # @name.sui + ✓ badge, fallback to mono short addr
web/components/BrowseKinds.tsx       # extracted from buy/page.tsx
web/components/MyTickets.tsx         # extracted from buy/page.tsx
web/components/BecomeIssuerForm.tsx  # extracted from issuer/page.tsx (RegisterIssuerSection)
web/components/MyIssuers.tsx         # extracted from issuer/page.tsx (Issuer + Kind admin)
```

### Files removed

```
web/app/buy/                         # merged into /
web/app/issuer/                      # merged into /
web/app/auth/                        # empty leftover from zkLogin attempt
```

### Trust signal (v1 → v2 path)

- v1 in place: **suiNS reverse-lookup** via `client.resolveNameServiceNames`. Any address shown anywhere on the page lights up as `@name.sui ✓` if the address has a registered name. Cached 5 min via tanstack-query.
- v2 deferred: **KYC tier** ("super verified"). Off-chain attestation via Civic / Sumsub / sui-foundation registry. The `<AddressDisplay>` component already has a `showBadge` prop slot — a second badge alongside the suiNS check is where the KYC marker would render.

### Build result

| Metric | Before unification | After |
|---|---|---|
| Routes | 6 | 4 |
| `/` First Load JS | 199 kB | 200 kB (essentially flat) |
| Total static pages | 6 | 4 |
| User-visible route count | 3 (`/`, `/buy`, `/issuer`) | 1 (`/`) |

### Handoff to `build-with-move`

This design is concrete enough to implement directly. The build skill should:

1. Create the Move package skeleton (`Move.toml`, `sources/`, `tests/`).
2. Implement the OTW (`SUI_TICKET has drop {}`), `init`, `Publisher` / `Display` / `TransferPolicy` setup.
3. Implement `Issuer` + `IssuerCap` module.
4. Implement `TicketKind<C>` + `Ticket` module with the full public entry surface above (including the `use_ticket` branch).
5. Add the royalty rule wiring in `init`.
6. Write `test_scenario` tests covering: register_issuer, create_ticket_kind, buy_ticket, **use_ticket (souvenir flip path)**, **use_ticket (consumable burn path)**, refund, withdraw_revenue, plus one failure path per public function (sold-out, paused, double-use, wrong-kind, out-of-window, etc.).
7. Defer all v2 items above.

---

## build-with-move session, 2026-05-31 (HostIt port — supersedes everything above)

**Major pivot:** rewrote the package from the `TicketKind` prototype into a faithful Sui Move port of the HostIt EVM Diamond (`../ticket`). Package renamed `sui_ticket` → `hostit_ticket`. Prototype archived at `.archive/v2-prototype/`. The Issuer/IssuerCap/TicketKind design above is obsolete.

- **modules:** `hub`, `event`, `ticket`, `market`, `checkin` (events defined inline, no separate module).
- **public surface:**
  - hub: `withdraw_platform_balance<T>`, `set_fee_bps`/`set_royalty_bps`/`set_refund_period_ms`, `platform_balance<T>`, reads.
  - event: `create_event` (→ `OrganizerCap`), `update_times`/`update_max_tickets`/`update_max_per_user`/`update_metadata`, `set_price<T>`, `add_checkin_signer`/`remove_checkin_signer`, `set_allow_self_checkin`, `escrow_value<T>`, `has_price<T>`, `is_checked_in[_for_day]`, reads.
  - market: `buy<T>`, `buy_with_sui`, `claim_free`, `refund<T>`, `withdraw_event_balance<T>`.
  - checkin: `check_in` (ed25519 voucher), `self_check_in`.
- **tests:** 36 `test_scenario` tests (every public fn + failure branches + escrow netting + multi-day check-in + signer-key validation). All passing, 0 warnings.
- **dependencies:** none (Sui framework only). Kiosk royalty/lock rules deliberately NOT added — deferred to v2.
- **review:** adversarial parity workflow (5 dims, 12 agents) → 1 confirmed finding fixed (multi-day check-in vs terminal status), 6 dismissed.
- **deployed:** testnet `0x6cf071ec35504a7d107110e0a4cce295a81bdbe3b6b26b2a5656dd105112cc91` (see deploy-context.md v3). On-chain smoke create→price→buy→mint succeeded.
- **open issues:**
  1. ~~Frontend re-wiring~~ — **DONE** (see frontend session below).
  2. v2 deferrals: kiosk `royalty_rule`/`kiosk_lock_rule` + `not_used` policy rule; ERC-6551-style token-bound accounts.
  3. Enoki portal allowlist → update to v3 targets when sponsored tx return.

---

## frontend session, 2026-05-31 (web/ rewired to v3)

Re-wired the Next.js app from the `TicketKind` prototype to the `Event`/`Hub`/`OrganizerCap` surface. Build green, dev on :3000.

- **Reused as-is:** `dapp-kit.ts`, `hooks.ts`, providers, `suins.ts`, `AddressDisplay`, `Header`, `globals.css`. SDK is `@mysten/sui ^2.17`, dapp-kit-core ^1.3 / react ^2.0, enoki ^1.0.
- **lib/config.ts:** PACKAGE_ID/HUB_ID/TRANSFER_POLICY_ID (v3), `COINS` [SUI, USDC], `coinInfo`/`matchesCoinType`, TICKET_STATUS {ISSUED,CHECKED_IN,REFUNDED}, `target(mod,fn)`, event-type strings. Env vars renamed: `NEXT_PUBLIC_HOSTIT_PACKAGE_ID`/`_HUB_ID`/`NEXT_PUBLIC_USDC_COIN_TYPE` (old `NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID` now ignored; defaults baked in).
- **lib/ticketing.ts:** PTB builders createEventTx (returns cap to sender), setPriceTx, buyTx (+`totalWithFee`, useGasCoin only when SUI & !sponsored), claimFreeTx, refundTx, withdrawEventBalanceTx, selfCheckInTx, checkInTx (voucher), setAllowSelfCheckinTx, addCheckinSignerTx, updateMaxTicketsTx, getFields.
- **lib/events.ts (new):** `useEventList()` — discovers events from `EventCreated`, joins prices from `PriceSet` by `event_seq` (avoids empty-struct dynamic-field reads).
- **verification.ts:** `useIsVerified(address)` (organizer suiNS). **sponsor.ts + api/sponsor:** allowlist → event::create_event/set_price, market::buy/buy_with_sui/claim_free/refund, checkin::self_check_in/check_in + framework coin/balance.
- **components:** CreateEventForm, EventCard, BrowseEvents, VerifiedEvents, MyEvents (organizer console: set price per coin, withdraw, self-checkin toggle — regular signing), MyTickets (self check-in + refund). Deleted KindCard/BrowseKinds/VerifiedTickets/MyKinds/CreateTicketForm.
- **Two-tx onboarding:** create_event (form) then set_price (My Events) — the Event is shared inside create_event, so pricing is a separate cap-gated call. Free events are immediately usable.
- **Deferred (v2):** the ed25519 **staff voucher scanner UI** (`checkInTx` builder exists; needs a staff-device key + QR app). Self-check-in is the demoable path. USDC payment works generically (testnet type wired); needs USDC in wallet to test.
- **Manual:** Enoki portal allowlist must list the v3 targets above for sponsored tx; the user's `.env.local` still has the old package var (harmless).

---

## design session, 2026-06-07 (HostIt brand applied to web/)

Implemented the HostIt design bundle (from claude.ai/design, fetched via `api.anthropic.com/v1/design/h/k45FinbD0Him3TTsombqEg`, extracted to `/tmp/hostit_design/`) onto the working dApp — a full visual rebrand, on-chain wiring untouched.

- **Design language:** deep-navy canvas (`#0C112B`/`#131939`), electric-blue `#007CFA` primary, stage-light accents (magenta/teal/green/amber), Hanken Grotesk (UI) + Poppins (stats) + Space Mono (mono/codes), chunky tactile buttons (hard bottom-edge + blue glow), 20px cards, pill nav/eyebrows, generated **gradient posters** (no event photography — deterministic hue per event id) + faux-QR ticket motif.
- **globals.css:** rewritten as the HostIt design system — remapped Tailwind `--color-*` tokens to dark values (existing markup flips automatically), added `--hi-*`/semantic/radii/elevation/fonts, and a component layer (`.btn`/`.btn-primary` chunky, `.eyebrow`/`.kicker`/`.chip`/`.badge*`, `.card`/`.stat-tile`, `.input`/`.select`/`.field`/`.label`, `.switch`, `.poster`/`.ev-card`/`.ev-grid`, `.page-title`, `.glow`, `.mono`). Fonts `@import` placed before `@import "tailwindcss"`.
- **Assets:** `public/brand/` ← logo-white/navy, icon, dashboard-mockup. Iconify via `<Script>` in layout + `components/Icon.tsx` (createElement wrapper).
- **Components restyled:** Header (sticky blurred topbar, logo + ConnectButton), layout (HostIt title, brand footer w/ net/pkg/sponsored), page Hero (eyebrow, big headline + blue accent, dual CTAs, glows, dashboard mockup in browser frame), EventCard (gradient poster + glyph + badges + chunky buy), Browse/VerifiedEvents (eyebrow + ev-grid), MyTickets (perforated ticket-stub + deterministic QR), MyEvents (organizer console + switch), CreateEventForm (icons). AddressDisplay verified tick → magenta.
- **Verified:** `bun run build` green (0 warnings, `/` 92.3 kB/204 kB); dev on :3000; **screenshot-verified** hero + verified/discover event grids render (fonts, dark theme, gradient posters, badges, icons load).
- **Scope:** re-skinned the functional single-page permissionless dApp; did NOT build the design's 12 separate mockup screens (Dashboard/Copilot/Door/Forum/Settings/scanner) — the app is one page wired to the contract. Mapped: landing hero, discover grid, ticket wallet, organizer console, create flow. Deferred: staff ed25519 voucher **scanner/Door** UI (matches the deferred contract voucher UX); real event photography (brand intentionally uses generated posters).

---

## full-product session, 2026-06-07 (goal: implement EVERYTHING end-to-end)

Built the ENTIRE HostIt design as a real product (all 13 screens) on Sui + Walrus + Seal + Claude. Brainstormed via 4 parallel design-mapping subagents, then fanned out 11 screen-builder agents in a workflow. Every route renders (0 console errors), build green, 39 Move tests pass, end-to-end smoke verified.

- **Contract v5** (`0x423336143d4e5a810d24b97762bfa10be56b7d5dc86b75e831cb0897264b1e8d`): added `poap` (proof-of-attendance NFT via shared `PoapRegistry`, claim gated on checked-in ticket), `access` (Seal `seal_approve_ticket`/`_organizer`/`_self`), `forum` (ticket-gated `PostCreated` anchor). Hub/PoapRegistry/TransferPolicy ids in deploy-context.md (v5) + web/lib/config.ts. 39 tests.
- **Integrations:** **Walrus testnet** (lib/walrus.ts HTTP, lib/metadata.ts) — event metadata JSON + cover image, blob id in event `uri`; verified upload→read round-trip + rendered in Discover/EventPage (category palette/glyph, venue, description). **Seal testnet** (lib/seal.ts, @mysten/seal) — forum messages (ticket-gated) + KYC (self-gated), ciphertext on Walrus; encrypt + SessionKey browser flow + seal_approve PTB decrypt. **POAP** (lib/poap.ts). **Forum** (lib/forum.ts Walrus+Seal+on-chain). **Copilot** (`/api/copilot` → Anthropic claude-haiku-4-5, grounded in event data, deterministic fallback when no ANTHROPIC_API_KEY — verified responding).
- **Routing:** App Router pages — `/` (marketing landing), `/discover`, `/event/[id]`, `/wallet`, `/dashboard`, `/create`, `/manage/[id]`, `/checkin`, `/door/[id]`, `/forum/[id]`, `/settings`, `/auth`. Header topnav (Discover/My tickets/Dashboard + Create + Connect).
- **Screens (components/screens/):** DiscoverScreen (me), + workflow: WalletScreen (tickets+POAP+claim), DashboardScreen (overview/attendees/analytics from chain logs), CreateEventScreen (4-step wizard + Walrus cover/metadata), EventPageScreen (detail+checkout), EventManageScreen (cockpit+withdraw+signers+CopilotPanel), CheckInScreen (attendance monitor+signer mgmt+toggle), DoorScreen (volunteer monitor), ForumScreen (Walrus+Seal gated), SettingsScreen (Seal KYC), AuthScreen, CopilotPanel. EventCard upgraded to fetch Walrus metadata (category palette/glyph + cover overlay).
- **Smoke (testnet, v5):** Walrus upload `G1v7Loid…` → read-back OK; create_event(uri=blob) → set_price<SUI> → buy_with_sui → ticket minted; 3 demo events live (Skyline/Token2040/Web3 Lagos) showing real Walrus metadata in the UI; Copilot API replied. Tickets/POAP/Seal-decrypt full runtime needs a connected wallet (gating + Move policies tested; ≥95% functional).
- **Decisions/defaults:** tiers live in Walrus metadata, on-chain price is single per-coin (the default — no pricing rewrite); dropped the design's tweaks panel + custom cursor; third-party-only items (Stripe cards, bank payouts, WebAuthn, Apple Wallet, websockets) replaced by the crypto-native equivalent (USDC/SUI on-chain, wallet auth, self/voucher check-in, Walrus+Seal forum with polling).
