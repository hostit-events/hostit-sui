# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`hostit_ticket` — a permissionless event-ticketing platform on Sui: a Move package (a faithful port of the HostIt EVM Diamond) plus a Next.js frontend ("HostIt — Events made easy"). It covers events, tickets, check-in, POAPs, a ticket-gated forum, and native parimutuel prediction markets, with gasless UX via Enoki, event metadata on Walrus, and encrypted data via Seal.

It is **two trees in one repo**:
- **Root** = the Move package (`Move.toml`, `sources/`, `tests/`). Run `sui` commands here.
- **`web/`** = the Next.js 15 / React 19 app. Run `bun`/`bunx` commands here.

## Package manager: bun only

**Never use pnpm or npm.** Use `bun` / `bunx` in every directory. (`package.json` scripts are runtime-agnostic; just invoke them with bun.)

## Commands

Move (run from repo root):
```bash
sui move build                 # compile the package
sui move test                  # run all Move tests
sui move test <filter>         # run a subset, e.g. `sui move test predict` or a test name
```

Frontend (run from `web/`):
```bash
bun install
bun run dev                    # local dev server (localhost:3000)
bunx tsc --noEmit              # typecheck — the primary verification gate
bun run lint                   # eslint (flat config)
bun run test                   # vitest unit tests (lib/ logic + a component smoke test)
bun run smoke:sponsor          # exercise the Enoki sponsor API contract directly (scripts/sponsor-smoke.ts)
```

Frontend correctness is verified with `bunx tsc --noEmit` + `bun run lint` + `bun run test` (**vitest** — unit tests under `web/lib/__tests__/` and `web/components/__tests__/`, covering pure `lib/` logic + a component smoke test). There is no browser E2E layer. The Move tests (`tests/*.move`) are the contract test suite.

**Critical dev gotcha:** never run `bun run build` (production build) while `bun run dev` is running — they share `.next/` and the production build corrupts the dev client bundle (blank page / "Cannot find module './xxx.js'"). To verify the frontend, use `bunx tsc --noEmit`, not `bun run build`. If the dev bundle breaks: stop dev, `rm -rf .next`, restart.

## Move architecture

One package, multiple modules under `hostit_ticket` (`sources/`):
- `hub` — shared `Hub` object: protocol config + 3% platform-fee treasury. Every paid sale touches it. Treasury/config entry fns (`withdraw_platform_balance`, `set_fee_bps`/`set_royalty_bps`/`set_refund_period_ms`) are gated on `governance` roles via an `&Auth<Role>` witness.
- `governance` — protocol RBAC on OpenZeppelin `access_control` (MVR dep `@openzeppelin-move/access`). Stands up a shared `AccessControl<GOVERNANCE>` in its own `init` (its OTW `GOVERNANCE` is the root role); defines `TreasuryRole` + `ConfigAdminRole` (same module, per OZ Invariant 2). Mint a PTB-local `Auth<Role>` via `treasury_auth`/`config_auth`, grant/revoke via `grant_*`/`revoke_*`; root handoff uses OZ's timelocked transfer. Replaces the old single `PlatformCap`. **Lives in its own module** because `hub`'s OTW is already consumed by `package::claim` and a module has only one OTW.
- `event` — `create_event` shares one `Event` per event and gives the creator an `OrganizerCap{event_id}`. Holds per-coin price + escrow via dynamic fields. Public getters (`minted`, `start_ms`, `max_tickets`, `event_seq`, …) are read by other modules.
- `ticket` — one global `Ticket` type with an `event_id` field (not a per-event type).
- `market` — `buy`/`buy_with_sui`/`claim_free`/`refund`/`withdraw_event_balance`. Generic `Coin<T>` payments; fee split into Hub + event escrow.
- `checkin` — attendee-signed check-in gated by an **ed25519 voucher** over `event_id(32)||ticket_id(32)||expiry_ms(8 LE)` against a registered signer set on the Event; `self_check_in` fallback gated by `allow_self_checkin`.
- `access` — Seal `seal_approve_ticket` / `seal_approve_organizer` / `seal_approve_self` policies (decryption gating).
- `poap` — proof-of-attendance NFT, claimable after check-in via a shared `PoapRegistry` (one per ticket).
- `forum` — ticket-gated on-chain anchor (`PostCreated`) for Walrus+Seal messages.
- `predict` — native parimutuel prediction markets: `SelloutMarket<T>` (binary "will it sell out?") and `RangeMarket<T>` (final-tickets-sold buckets). Settles **trustlessly on-chain by reading `event::minted()`** at/after expiry. No oracle, no fee. See "Prediction markets" below.

EVM→Sui mapping: protocol owner (`onlyOwner`) = OZ `access_control` **roles** in `governance` (`TreasuryRole`/`ConfigAdminRole`, formerly the single `PlatformCap`); `OrganizerCap{event_id}` = per-event admin (a capability — RBAC is protocol-level only, event creation stays **permissionless**); check-in staff = an ed25519 pubkey set on the Event. All times are **milliseconds**.

**OZ `access_control` dependency.** Wired via MVR (`openzeppelin_access = { r.mvr = "@openzeppelin-move/access" }`) which pins the on-chain testnet package; the `Sui`/`MoveStdlib` framework deps carry `override = true` to resolve the version conflict with OZ's transitive pins. Adopting `access_control` needs a One-Time Witness at *first publish*, so it ships as a **fresh publish**, never an upgrade (see DEPLOYING.md).

## Frontend architecture

Next.js App Router. Two layout zones:
- **Root layout** (`app/layout.tsx`) renders the landing page (`components/LandingV2.tsx`) + the custom cursor (`components/CustomCursor.tsx`), no app chrome. Do **not** put a CSS `transform`/`filter`/`will-change` on the `.lv` landing root — it breaks `position: fixed`/`sticky` (intro overlay, sticky nav, pinned sections).
- **`app/(app)/` route group** (`app/(app)/layout.tsx`) adds Header + constrained `<main>` + Footer. Each route (`discover`, `event`, `create`, `manage`, `wallet`, `dashboard`, `checkin`, `door`, `forum`, `settings`, `auth`) is a thin client page rendering a screen from `components/screens/`.

`lib/` wraps each protocol; new on-chain features should mirror these:
- `config.ts` — **single source of truth for all on-chain IDs and Move targets** (package versions, Hub, registries, coin types, Walrus/Seal endpoints). See "Package versioning" — read it before touching any target/type string.
- `ticketing.ts`, `predict.ts` — pure `Transaction` constructors (one per Move entry fn). Reads parse via `getFields`-style helpers.
- `hooks.ts` — `useSignAndExecute` (direct), `useSponsorAndExecute` (Enoki-sponsored), `useSuiQuery` (thin react-query wrapper over any `SuiClient` method).
- `events.ts` / `markets.ts` — `queryEvents`-based discovery hooks. `walrus.ts` (HTTP, no SDK) / `metadata.ts` — event metadata + cover images (blob id stored in the event `uri`). `seal.ts` — threshold encryption. `poap.ts`, `forum.ts`, `verification.ts`/`suins.ts`, `data.ts`, `moveErrors.ts`.

Standard write flow in a screen: build a tx with a `lib/*Tx` constructor → submit via a local `run`/`send` helper that picks `useSponsorAndExecute` when `ENOKI_ENABLED` else `useSignAndExecute` → surface the digest with `<TxLink>` and errors with `humanizeError`. Reuse this pattern; don't hand-roll new submit logic.

`humanizeError(e)` (`lib/moveErrors.ts`) maps `MoveAbort` module+code (and gas/cancel errors) to human text. When adding Move error codes, add the mapping here too.

## Package versioning (Sui upgrades — easy to get wrong)

The package has been upgraded in place (not fresh-deployed) to add `predict`. **Sui anchors a struct's type identity to the package version that *introduced* it, while function calls target the latest version.** `config.ts` encodes this:
- `PACKAGE_ID` — original package. Type/event constants for the original modules (`TICKET_TYPE`, `EVENT_TYPE`, `EV_*`) use it; `target(mod, fn)` calls original modules through it.
- `PACKAGE_ID_LATEST` — newest upgrade. **All `predict` call targets** use `targetLatest(mod, fn)`; `RangeMarket`'s type/event constants use it (Range was introduced in the latest upgrade).
- `PREDICT_SELLOUT_PKG` — the upgrade that introduced `SelloutMarket`; its type/event constants stay pinned here even as `PACKAGE_ID_LATEST` rolls forward.

Rule of thumb: a predict *call* → `targetLatest`/`PACKAGE_ID_LATEST`; a predict struct/event *type string* → the constant pinned to the upgrade that introduced that struct. **Each new predict struct in a future upgrade needs its own type-origin pin.** When in doubt, create the object on-chain and read its reported `objectType` — don't assume.

## Deploys are package upgrades (gated)

Deploying Move changes = `sui client upgrade` (not fresh publish) using the existing `UpgradeCap` (see `.suiperpower/deploy-context.md` for the cap + active address). Before upgrading, set `Move.toml` `published-at` to the **current latest** version id and keep `[addresses] hostit_ticket` at the original id. After upgrading: roll `PACKAGE_ID_LATEST` in `config.ts` to the new version, then re-`tsc` and smoke-test by creating an object on-chain.

**On-chain upgrades require explicit, per-deploy user authorization** — the permission layer blocks them, and a general "continue/finish" instruction is *not* sufficient. Ask for an explicit go-ahead each time before running `sui client upgrade` or `sui client publish`.

`.suiperpower/deploy-context.md` is the append-only record of all deploys (package ids, object ids, costs). `learnings.md` and `build-context.md` hold session history and decisions.

## Gasless transactions (Enoki)

Sponsorship is **server-side**: `app/api/sponsor` (create) + `app/api/sponsor/execute` (execute) hold `ENOKI_PRIVATE_API_KEY` (server-only — never `NEXT_PUBLIC_`-prefixed; likewise `GOOGLE_CLIENT_SECRET`). `ENOKI_ENABLED` (true when `NEXT_PUBLIC_ENOKI_API_KEY` is set) decides sponsored vs direct signing per call.

The sponsorable move-call allowlist is a single exported `SPONSORED_TARGETS` in `web/lib/config.ts`, imported by `app/api/sponsor/route.ts` and passed to Enoki. **Add new sponsored entry functions there (one place)** — predict targets use `PACKAGE_ID_LATEST`, others `PACKAGE_ID`. `web/lib/__tests__/sponsoredTargets.test.ts` pins the version-origin invariant.

## Prediction markets (native, not DeepBook Predict)

These are HostIt-native parimutuel markets in the `predict` module that settle on `event::minted()`. **DeepBook Predict proper is deliberately deferred** — it has no self-serve custom oracle on testnet, so it cannot settle on event state. `config.ts` has an OFF-by-default DeepBook Predict block (`DEEPBOOK_PREDICT_ENABLED`) and `lib/predict.ts` documents the swap-in path; do not wire it until that external blocker clears.

## Conventions

- **Permissionless model:** no issuer/buyer role split — any wallet can host and hold. The UI must not project a role gate; quality/trust is signaled via suiNS/verification badges, not access gating.
- `verifyKeyServers: false` in `lib/seal.ts` is the dev setting; flip to `true` for production. The testnet Seal key server is a **committee (V2) server** and its `serverConfig` must include `aggregatorUrl`.
- Prefer narrow v1 scope with explicit v2 deferrals over speculative generalization.
