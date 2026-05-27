# Learnings — sui-ticket

## Learnings, 2026-05-27T00:00:00Z

### What we tried
- ran sui-beginner: intro to objects, Move abilities, capabilities, PTBs, SDK landscape (~10 minutes)

### Decisions
- prior background: evm
- next step: object-model-design

### Notes for the next skill
- Repo intent: **general-purpose ticketing platform** on Sui (`sui-ticket`). NOT event-specific. Scope must cover arbitrary ticket kinds (events, transit, raffles, access passes, coupons, support queue, etc.).
- User is EVM-native; concepts were taught with Solidity translation passes.
- **Design locked.** See `.suiperpower/build-context.md` for the full Object map, capability flow, public entry surface, and stress-test results.

## Learnings, 2026-05-27 (object-model-design session)

### What we tried
- ran object-model-design: locked the v1 Object schema, capability flow, and API surface (~20 minutes)

### Decisions
- kind discrimination: **single `Ticket` type + `kind_id` discriminator + dynamic fields** (no phantom types for kinds)
- ticket ownership: **owned by holder, abilities `key, store`**
- use / mark-used: **`use_ticket` (renamed from `redeem_self`); holder-signed only in v1**; verifier-cap deferred to v2
- post-use behavior: **per-kind `keep_as_souvenir: bool`** — souvenir flips to USED + stays as NFT collectible; consumable burns on use (storage rebate to holder)
- aftermarket: **Kiosk + `TransferPolicy<Ticket>` with royalty rule**
- soulbound: **deferred to v2** (would require custom TransferPolicy rule)
- currency: **per-kind phantom `TicketKind<phantom C>`** for type-safe payment + balance
- next step: **build-with-move**

## Learnings, 2026-05-27 (build-with-move session)

### What we tried
- ran build-with-move: wrote `sui_ticket::ticketing` module + 16 test_scenario tests; `sui move build` + `sui move test` both pass (~30 minutes)

### Decisions
- single-module package (not split issuer/ticket modules) — easier intra-package helpers
- removed `transfer_ticket` from API — `Ticket` has `key+store` so SDK can use `transfer::public_transfer` directly
- added `outstanding` counter on `TicketKind` for refund liability tracking
- lint suppressions applied: `share_owned`, `custom_state_change`, `self_transfer` — all intentional design choices
- next step: **deploy-to-testnet** (try it on chain), or **ptb-composer** (build the client wiring)

## Learnings, 2026-05-28 (deploy-to-testnet session)

### What we tried
- published `sui_ticket::ticketing` to Sui testnet (~5 minutes)
- verified package + UpgradeCap on chain via `sui client object`
- wrote `.suiperpower/deploy-context.md` with all artifact IDs

### Decisions
- **package id**: `0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb`
- upgrade policy: COMPATIBLE (default; can be tightened later)
- TransferPolicy<Ticket> deployed empty — royalty rule to be added post-deploy via SDK
- Move.toml still pinned to `framework/testnet`; pin to specific SHA before mainnet
- next step: **ptb-composer** (build typed PTB wrappers in TS), or smoke test via the CLI snippets in deploy-context.md

## Learnings, 2026-05-28 (ptb-composer session)

### What we tried
- built TS SDK (`sdk/config.ts` + `sdk/ticketing.ts`) on `@mysten/sui@1.45.2`
- wrote smoke script that exercises register → create_kind → buy → use → double-use(negative) against testnet
- all 4 positive PTBs executed; negative test (dry-run) aborted with MoveAbort as expected

### Decisions
- single-module SDK in `sdk/` directory; flat structure for v1 (resist over-organizing until frontend lands)
- keystore loader supports ed25519 / secp256k1 / secp256r1 — the deployer's key is **secp256r1** (Sui type byte 2), not ed25519
- `buy_ticket` is the composability win: splits gas, calls move, transfers Ticket — 3 ops atomic
- `register_issuer` + `create_ticket_kind` CANNOT be composed in one PTB (shared-object addressability); documented in SDK
- next step: **frontend** (scaffold-project) or **soulbound rule** (custom TransferPolicy rule for v2)

## Learnings, 2026-05-28 (scaffold-project — web/ frontend)

### What we tried
- scaffolded `web/` Next.js 15 dashboard alongside existing Move + SDK + scripts (flat layout, no restructure)
- two dashboards (`/issuer`, `/buy`) with working register / create-kind / pause / withdraw / browse / buy / use / refund flows
- wired Enoki initializer through dapp-kit v2's `walletInitializers`
- 5 iterations on `pnpm build`; finally green at ~198 kB First Load JS, 6 prerendered routes

### Decisions
- **package versions move fast in the Mysten ecosystem.** Initial guesses (`@mysten/dapp-kit-react@^0.18`, `@mysten/sui@^1.45`) were stale; reality: dapp-kit-react 2.x, sui 2.x, enoki 1.x. Future scaffolds: install with `^latest`, don't pin minors yet.
- **dapp-kit v2 is a meaningful rewrite.** Single `DAppKitProvider`, `createDAppKit` factory, hooks moved/renamed, transaction result is a discriminated union. See build-context.md migration table for the cheat sheet.
- **SuiClient → SuiJsonRpcClient.** `@mysten/sui/client` now exports abstract base classes only; concrete clients live in `/jsonRpc` and `/grpc` subpaths. `getFullnodeUrl` → `getJsonRpcFullnodeUrl`.
- **Browser-only code at module load forces `next/dynamic` with `ssr: false`** for the providers shell. Pure `"use client"` on the consumers isn't enough.
- **User flipped `NEXT_PUBLIC_ENOKI_API_KEY` → `ENOKI_API_KEY`** (server-only). Enoki gracefully disabled in-browser; v2 path will be a Next.js route handler proxying sponsored-tx server-side.
- next step: **dev test in browser** (`bun --cwd web dev`), or **add soulbound TransferPolicy rule** (v2 Move work), or **wire sponsored-tx route handler** to make Enoki actually live.

## Learnings, 2026-05-28 (pnpm → bun migration)

### What we tried
- migrated `web/` from pnpm to bun after user pushback ("never ever use pnpm")
- deleted `pnpm-lock.yaml` + `node_modules`, ran `bun install` (106 packages, 49s), `bun run build` (green, identical bundle sizes)

### Decisions
- the user's package-manager preference is now memory-persisted (see [[feedback-package-manager]]) — bun for every directory, ignore skill defaults that say pnpm
- `package.json` scripts (`next dev`, `next build`) are runtime-agnostic — no edits needed for the switch
- root + `web/` each have their own `bun.lock` (not a workspace yet); fine for v1, workspace consolidation is a follow-up

## Learnings, 2026-05-28 (sponsored-transactions wiring)

### What we tried
- v1a: wired Enoki sponsored-tx **client-side** with the public API key. Smoke failed with `403 Private API key required for this endpoint` — public-tier keys can't access sponsor endpoints (only zkLogin endpoints).
- v1b (final): pivoted to **server-side via Next.js route handlers**. Created `/api/sponsor` (create) + `/api/sponsor/execute` (execute), holding `ENOKI_PRIVATE_API_KEY` server-only.
- four allowlisted Move targets: register_issuer / use_ticket / buy_ticket / buy_ticket_for
- standalone smoke at `web/scripts/sponsor-smoke.ts` calls Enoki directly with the private key to verify the API contract independently of the route handlers
- **smoke settled on testnet**: digest `5By7s3spJdx4Vpc2QeqEJ4pReTBgyf7NAdy8UHfCpeFX`, sponsor `0x0dec…1290` distinct from sender `0xc856…c2d9` ✓

### Decisions
- **Server-side sponsorship** (not client-side) — required by Enoki's API surface, not optional
- `ENOKI_PRIVATE_API_KEY` lives in `web/.env.local` without `NEXT_PUBLIC_` prefix; route handlers are the only consumers
- Allowlist is **server-authoritative** (in `app/api/sponsor/route.ts`); client passes a hint but server overrides
- Refund + issuer-admin ops stay on the regular signer path (commercial actions / actor already SUI-funded)
- Two-route design (create + execute as separate POST endpoints) keeps each request stateless

### Notes (gotchas worth remembering)
- **Enoki has two API key tiers with different scopes**: public for zkLogin endpoints (browser-safe), private for sponsor endpoints (server-only). They're separate keys from the same portal; don't conflate.
- A `403 not_supported "Private API key required"` is Enoki's signal that you used the wrong tier.
- v2 SDK rename: `decodeSuiPrivateKey(...)` now returns `{ scheme, secretKey }`, not `{ schema, secretKey }`. Tripped the smoke at first.
- `ClientWithCoreApi` from `@mysten/sui/client` is the right type for `Transaction.build({ client })` in v2 — avoid clever conditional types.
- The user properly de-publicized `GOOGLE_CLIENT_SECRET` after I flagged it ✓
- next step: **browser-test** at localhost:3000 — connect a wallet, click register/buy/use, confirm no gas dialog appears. Then **`/suiper:kiosk-marketplace`** for the royalty rule wiring on `TransferPolicy<Ticket>`, or **soulbound rule** Move work for v2.

## Learnings, 2026-05-28 (sui-zk-login manual flow — attempted, blocked)

### What we tried
- wrote a complete manual zkLogin demo at `/zklogin` (no Enoki dependency): ephemeral keypair → Google OAuth → JWT → deterministic salt → ZK proof from Mysten's public prover → `jwtToAddress` → `getZkLoginSignature` → submit
- attempted self-hosting the Mysten prover via Docker after public prover failed

### Decisions / findings
- **Public Mysten prover (`prover-dev.mystenlabs.com/v1`) produces proofs that fail on-chain `Groth16 proof verify`** despite our wiring being correct (three subagents audited, all inputs coherent). Likely cause: circuit version skew between prover-dev and current testnet's verifier. **Not client-fixable.**
- **Self-hosting the prover failed on Apple Silicon (M3):** Mysten ships only `linux/amd64` images. The `proverServer` binary uses x86 instructions (almost certainly AVX-512) that Rosetta hasn't implemented even on macOS 15. SIGILL on `exec`, before reading the zkey.
- **The zkey ceremony is delivered via git-lfs**, not a plain CDN. File is `zkLogin-main.zkey` at 616 MB (smaller than the docs suggest); Blake2b matches Mysten's published hash. Mount path must be exactly `/app/binaries/zkLogin.zkey` regardless of what the `ZKEY` env var says — the binary opens that path directly.
- **What WORKS in the manual flow** (kept as educational reference): the ephemeral key + OAuth + salt + address derivation + signature assembly are all correct. Only the proof step is blocked.

### Decision: pivot, then full removal
- After Docker self-host also failed (SIGILL on Apple Silicon, AVX-512 not in Rosetta), the user decided to go Enoki-only.
- **Removed** `web/app/zklogin/`, `web/lib/zklogin.ts`, `docker/zklogin-prover/`, and the `NEXT_PUBLIC_PROVER_URL` env var.
- **Bundle size win**: First Load JS dropped from ~643 kB → ~199 kB across all pages. `@mysten/sui/zklogin`'s Poseidon constants are no longer pulled into the shared chunk now that nothing imports them.
- The skill's quality gate (real OAuth + real tx under derived address) is not met for the manual flow, **but it IS met for Enoki** — that's how the user actually got zkLogin working. Recorded honestly in build-context.md.

### Re-unblock options if someone retries later
- The Enoki path (`/issuer` + `/buy` with `enokiWalletsInitializer` + private-key sponsor route) is the working zkLogin product surface
- If a no-Enoki manual flow is wanted later: switch to `EnokiClient.createZkLoginZkp` (Enoki's wrapper around the prover; still server-managed but no dapp-kit dependency), self-host on x86 Linux, or build rapidsnark for arm64 from source

## Learnings, 2026-05-28 (kiosk-marketplace — skipped, decision recorded)

### What we tried
- surveyed the design space for ticketing resale: Mysten's standard `royalty_rule` (flat, single-recipient) vs custom rule (split + per-kind, package upgrade)
- user picked the third option: ship without marketplace infrastructure, keep resale as direct P2P transfer

### Decisions
- **`TransferPolicy<Ticket>` stays empty.** It's available for v2 to layer rules onto without fresh policy creation.
- **No Kiosk UI.** Tickets remain `key, store` and transferable via `sui::transfer::public_transfer`. Off-chain price discovery + on-chain transfer; no platform fee mechanism.
- The skill effectively ends as no-op in this project; design recorded for v2.

### Key constraint surfaced
- **`TransferPolicy<T>` is per-Move-type, not per-instance.** You can't have one policy per `TicketKind` — all Ticket trades route through one policy. Per-kind variation must live inside a custom rule that reads ticket.kind_id at sale time.
- **Mysten's standard `royalty_rule` is flat + single-recipient** by design. It was built for single-creator NFT collections (OpenSea-style royalties). Doesn't fit multi-issuer ticketing without a custom wrapper.

### Decision criteria for revisiting
- If the platform wants revenue from secondary market → custom rule with split + per-kind
- If issuers ask to earn from resales → same custom rule
- If neither happens organically → leave as-is, current product is coherent

## Learnings, 2026-05-28 (permissionless UX unification)

### What we tried
- merged `/issuer` and `/buy` into a single `/`. Sections (Browse / My Tickets / Issuers I control / Become an Issuer) render conditionally based on wallet state
- added suiNS reverse-lookup for any displayed address via `useSuiNSName` (tanstack-query, 5min cache)
- new `<AddressDisplay>` component shows `@name.sui ✓` when a suiNS name exists, falls back to truncated mono otherwise
- dropped Header nav (the protocol is permissionless; the UI no longer projects a role split)

### Decisions
- the user is right that `register_issuer` being permissionless means an account can be both issuer and holder; the previous route split was lying about that
- saved as project memory ([[project-permissionless-ux]]) so future skill sessions don't re-introduce the role split
- KYC tier deferred to v2; the `<AddressDisplay>` `showBadge` slot is ready for a second verification badge

### Notes
- file count went up (5 new components in `components/`) but logic stayed identical — just relocated. Existing buy/page.tsx + issuer/page.tsx content was lifted with minimal change
- the `app/auth/` dir (empty leftover from the manual zkLogin attempt) was cleaned up in the same pass
- Build: same shared-chunk size, slightly larger `/` page (88.7 kB vs ~5 kB previously) because the new home composes content that used to live in separate routes — this is correct, the content has to live *somewhere*
