# Plan 021: Deploy strategy for the implement-plans branch (fresh-publish vs upgrade)

> **Decision plan / deploy runbook.** No chain action has been taken. The branch
> `advisor/implement-plans` has 19/20 plans' code + tests landed and green, but a
> literal `sui client upgrade` **cannot ship them** as-is. This plan records why,
> and the two viable paths with exact steps, so a maintainer can execute one with
> explicit per-deploy authorization. **Read `DEPLOYING.md` alongside this.**

## Status

- **Priority**: P1 (blocks getting the branch's Move changes on-chain)
- **Effort**: M (fresh publish) / L (rework-for-upgrade)
- **Risk**: HIGH (irreversible, on-chain, costs gas)
- **Depends on**: a maintainer **decision** (Option A vs B) + per-deploy authorization
- **Category**: deploy / direction
- **Planned at**: commit `0ab2da7`, 2026-06-21
- **Blocked on**: user chose "hold — don't deploy yet" (2026-06-21). **More contract
  changes are coming from other branches; the maintainer will merge those and then
  deploy the combined set** — so the Option A/B decision below applies to the
  *union* of all merged contract changes, not this branch alone, and the deploy is
  owned by the maintainer post-merge.

> **Because more contract changes are incoming:** adopt `DEPLOYING.md` §"Strategy
> for many changes coming" now — route every behavior-changeable call target
> through `targetLatest` (not `target()`), keeping type/`EV_*` origins pinned. That
> way the *next* incompatible change is the only thing that can force a fresh
> publish, and additive changes from the other branches can ship as clean upgrades.
> Re-run this plan's "Blocker 1/2" matrix over the **merged** tree before deploying —
> a single incompatible struct/sig change anywhere in the union still forces Option A.

## Current on-chain state (verified 2026-06-21)

- **env** `testnet`; **deployer** `0xc8567c14…d6c2d9` (active address); **gas** ~13.8 SUI.
- **Package** `0x6a41303dbb…671fcd` — `Published.toml` version **1**, `original-id == published-at` → **never upgraded** (all prior deploys were fresh publishes).
- **UpgradeCap** `0xbfc24d71…f5de3`, owned by the deployer address, **policy `0.0` = COMPATIBLE** (additive-only).
- `Move.toml` `[addresses] hostit_ticket = 0x6a41303d…` (the original id; correct for an upgrade — the "0x0" comment above it is stale).
- `Move.toml` Sui rev pinned to lock SHA `94ad8ccd…` (plan 020); `sui move build` + `sui move test` (103/103) green.

## Why a `sui client upgrade` cannot ship this branch

Two independent blockers (either alone forces the issue):

### Blocker 1 — incompatible schema changes (verifier rejects)

The COMPATIBLE UpgradeCap policy forbids changing an existing struct's
fields/abilities or a public function's signature (`DEPLOYING.md` §Prerequisites;
the same rule that forced the `settle_after_ms` republish). This branch does both:

| Plan | Change | Compatible upgrade? |
|---|---|---|
| 007 seal namespace | new `ORG_NS_TAG` const; `seal_approve_organizer` **body** change (sig same) | ✅ additive |
| 008 move-quick | new error consts + new `assert!`s; no struct/sig change | ✅ additive |
| **009 refund fee** | **adds `fee_forfeited` field to existing `TicketRefunded` event struct** | ❌ **incompatible** |
| **010 checkin unit** | **changes `DayKey` struct fields** + **changes public `is_checked_in_for_day` signature** | ❌ **incompatible** |
| 011 dust fold | `claim`/`claim_range` **body** changes only | ✅ additive |

`sui client upgrade` will be **rejected** by the bytecode verifier on 009 + 010.

### Blocker 2 — `target()` call sites run OLD bytecode after an upgrade

Even ignoring Blocker 1, an upgrade adds a *new* package version but
`PACKAGE_ID::mod::fn` (the frontend's `target()` helper) keeps running the
**original** bytecode — only `PACKAGE_ID_LATEST::mod::fn` (`targetLatest`) runs
the new code (`DEPLOYING.md` §"Upgrade vs fresh publish", case 2). The behavior
changes here that are called via `target()` would **silently not take effect**:

- **008** `market::buy` overflow guard — `buyTx` uses `target()` → no effect on upgrade.
- **009** `market::refund` — `refundTx` uses `target()` → no effect on upgrade.
- **010** `checkin::check_in`/`self_check_in` — use `target()` → no effect on upgrade.
- **011** `predict::claim`/`claim_range` — already use `targetLatest` → **would** take effect. ✅
- **007** `seal_approve_organizer` is dry-run by Seal key servers; the TS side already
  coordinates the tag, but confirm which package version the key server dry-runs against.

So shipping 008/009/010's behavior via upgrade *also* requires repointing those
call targets from `target()` to `targetLatest` in `config.ts`.

**Net:** the only way to ship this whole branch via a real upgrade is Option B
(rework 009/010 to be additive **and** repoint 008/009/010 targets to latest).
Otherwise, Option A (fresh publish) ships everything cleanly — which is exactly
what this repo has done for every prior incompatible deploy.

## Option A — Fresh publish (matches repo history; ships everything now)

A fresh publish gives a **new package id**, re-runs `hub::init`/`poap::init`
(re-creating the shared `Hub`, `PoapRegistry`, `TransferPolicy<Ticket>`), and
**orphans all current on-chain state** (old events/tickets/markets/forum stop
resolving) — acceptable on **testnet only**, never mainnet. Follow
`DEPLOYING.md` §"Fresh-publish procedure" exactly. Concretely for this deploy:

1. **Preconditions:** `which sui` → `~/.local/bin/sui` and `sui --version` is **1.73.1**
   (homebrew 1.73.0 can't deploy at protocol ≥126); `sui client active-env` on a
   **gRPC** endpoint (`fullnode.testnet.sui.io:443`, not a JSON-RPC gateway);
   `sui move build && sui move test` green.
2. **Authorized publish** (gated): `sui client publish --gas-budget 2000000000 --json > /tmp/publish.json`.
   If it hangs, use `--serialize-unsigned-transaction` + sign/execute separately
   (`DEPLOYING.md` §"If sui client upgrade hangs").
3. **Capture from `objectChanges`:** new `packageId`; shared `Hub`, `PoapRegistry`,
   `TransferPolicy<…::ticket::Ticket>`; new `UpgradeCap`, `PlatformCap`,
   `TransferPolicyCap<Ticket>`.
4. **Roll `web/lib/config.ts`** (fresh v1 → all pins collapse to the new id):
   `PACKAGE_ID`, `PACKAGE_ID_LATEST`, `PREDICT_SELLOUT_PKG`, `PREDICT_RANGE_PKG` → new id;
   `HUB_ID`, `POAP_REGISTRY_ID`, `TRANSFER_POLICY_ID` → new shared-object ids.
5. **`Move.toml`** `[addresses] hostit_ticket` → new id; `Published.toml` is rewritten by the publish.
6. **Vercel env diff:** `NEXT_PUBLIC_HOSTIT_PACKAGE_ID` (+ any `*_LATEST_ID`/object-id
   overrides) → new ids; redeploy. `SPONSORED_TARGETS` derive from `config.ts`, so the
   Enoki allowlist updates on the next server deploy.
7. **Re-attach** `TransferPolicy<Ticket>` rules if resale is live (`policy_rules::setup_ticket_policy`).
8. **Verify:** `bunx tsc --noEmit`; on-chain smoke (create one object touching new code,
   confirm `objectType` matches the wired constants); browser-check.
9. **Record** in `.suiperpower/deploy-context.md` (package id, publish digest, new caps/objects, what shipped).

**Cost:** orphans current testnet data; the package identity churns again (the
config.ts versioning split resets to all-equal). Lowest effort, highest historical precedent.

## Option B — Rework for a real (first) upgrade (preserves identity + data)

Make 009 + 010 additive, repoint the behavior-changed targets, then upgrade.
This is the investment `DEPLOYING.md` §"Strategy for many changes coming" +
§"Mainnet considerations" call for (on mainnet a fresh publish is never acceptable).

1. **009 → additive:** revert the `fee_forfeited` field on `TicketRefunded`; instead
   emit a **new** event `public struct RefundFeeForfeited has copy, drop { event_seq, ticket_id, holder, coin_type, fee_forfeited }` from `refund<T>`. Keep `TicketRefunded` byte-identical.
2. **010 → additive:** keep `DayKey` and `is_checked_in_for_day(event, day, address)`
   unchanged (deprecate in a comment). Add a **new** key type `DayKeyByTicket { day, ticket: ID }`,
   a new `record_checkin_by_ticket`, and a new reader `is_checked_in_for_ticket_day(event, day, ticket_id)`.
   Switch `checkin::record_and_mark` to write the ticket-keyed entry.
3. **Repoint targets** in `config.ts`: route `market::buy`, `market::refund`,
   `checkin::check_in`/`self_check_in` (and any other behavior-changed `target()` call
   whose new code must run) through `targetLatest`, leaving type/`EV_*` origins on `PACKAGE_ID`.
   Update `SPONSORED_TARGETS` for any of these that are sponsored (and `sponsoredTargets.test.ts`).
4. **Upgrade** per `DEPLOYING.md` §"Upgrade procedure":
   `sui client upgrade --upgrade-capability 0xbfc24d71…f5de3 --gas-budget 2000000000 --json > /tmp/upgrade.json`.
5. **Roll `config.ts`:** `PACKAGE_ID_LATEST` → new version id; add a pinned type-origin
   for any new struct/event introduced (e.g. a `PREDICT_*`-style pin is NOT needed here —
   no new public type beyond events). Existing type origins stay on `PACKAGE_ID`.
6. **Verify + record** as in the upgrade procedure.

**Cost:** moderate Move rework + new tests; but preserves the package id and all
on-chain state, and establishes a working upgrade path before mainnet.

## Recommendation

- **If the goal is "get it on testnet now"** and orphaning test data is fine → **Option A** (fresh publish). It matches every prior deploy here and ships all 19 plans in one shot.
- **If the goal is to mature toward mainnet** (where fresh publish is forbidden) → **Option B**. Do it once now while the surface is small, and route future behavior changes through `targetLatest` so subsequent upgrades "just work."

## STOP conditions / authorization

- **Do not run `sui client publish` or `sui client upgrade` without explicit,
  per-deploy user authorization** (CLAUDE.md, DEPLOYING.md §Authorization). The
  user's standing answer as of 2026-06-21 is **HOLD**.
- Before any deploy: confirm `which sui` → `~/.local/bin/sui` @ 1.73.1 and a gRPC
  `active-env`, or it will hang/fail (DEPLOYING.md §"If sui client upgrade hangs").
- A fresh publish on **mainnet** is never acceptable (strands users' tickets) — Option A is testnet-only.

## Maintenance notes

- This plan is the single source of truth for *why* the branch isn't deployed.
  When a path is chosen, execute it, then mark 007–011's README rows
  "DONE + deployed @ <id>" and append the deploy to `.suiperpower/deploy-context.md`.
- The PR (#70) can merge **independently** of this deploy decision — merging lands
  the code; the chain deploy is a separate authorized step.
