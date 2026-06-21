# Plan 008: Four small Move correctness fixes (overflow guard, zero-bet reject, signer-remove emit, settle_range comment)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, do NOT create it —
> just note that in your report.)
>
> **Drift check (run first)**:
> ```bash
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- \
>   sources/event.move sources/market.move sources/predict.move \
>   tests/hostit_ticket_tests.move tests/predict_tests.move tests/predict_range_tests.move \
>   web/lib/moveErrors.ts
> ```
> If any in-scope file changed since this plan was written (`957206b`), compare
> the "Current state" excerpts against the live code before proceeding. On any
> mismatch with an excerpt below, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20

## Why this matters

These are four small, independent Move correctness defects, each cheap to fix and each individually testable. Three are real on-chain bugs: (1) a near-`u64::MAX` ticket price makes every `buy<T>` of that coin abort with an arithmetic overflow instead of a clean error, silently bricking sales for that coin; (2) a zero-value bet creates a dead `Table` entry and emits a phantom `Bet`/`RangeBet` event — gas-sponsored through the Enoki allowlist — that can never be claimed (`claim` asserts `stake > 0`); (3) `remove_checkin_signer` emits a `CheckinSignerRemoved` confirmation **even when the supplied pubkey was never registered**, so a typo fires a false "key revoked" signal while a compromised key stays live. The fourth (4) is a documentation bug: the `settle_range` doc comment says settlement opens at `expiry_ms`, but the code correctly gates on `settle_after_ms` (the `end_ms` snapshot); a future maintainer "fixing" the code to match the comment would reintroduce a settled bug that a regression test already guards. Fixing all four removes foot-guns with near-zero blast radius.

## Current state

All four live in the Move package at the repo root (`/Users/dadadave/Dev/HostIT/sui-ticket`). Edition is `2024.beta`; error constants are named `E_FOO` and live at the top of each module. Test modules are `#[test_only] module hostit_ticket::*_tests` and reference another module's error const by its **fully-qualified path** (e.g. `hostit_ticket::predict::E_NO_STAKE`) inside `#[expected_failure(abort_code = ...)]` — this works because the test module is in the same `hostit_ticket` package. (Confirmed: there are 55 such cross-module `::E_` references in `tests/`.)

### Finding 1 — `set_price` has no ceiling; `buy<T>` computes `total` in unguarded u64

`sources/event.move:277-292` — `set_price<T>` only asserts `price > 0`, no upper bound:

```move
public fun set_price<T>(cap: &OrganizerCap, event: &mut Event, price: u64) {
    assert_organizer(cap, event);
    assert!(!event.is_free, E_EVENT_IS_FREE);
    assert!(price > 0, E_ZERO_PRICE);
    // ... stores price in a PriceKey<T> dynamic field ...
}
```

`sources/market.move:96-102` — fee is computed safely in u128, but `total = price + hostit` is an **unguarded u64 addition**, then split:

```move
    let price = event::get_price<T>(event);
    let hostit = (((price as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
    let total = price + hostit;

    let mut payment = payment;
    assert!(coin::value(&payment) >= total, E_INSUFFICIENT_PAYMENT);
    let total_coin = coin::split(&mut payment, total, ctx);
```

If `price` is near `u64::MAX`, `price + hostit` overflows u64 and **every** `buy<T>` of that coin aborts with a VM arithmetic error (not a clean Move abort). `BPS_DENOM: u128 = 10_000` is defined at `sources/market.move:25`. Existing market error consts run `E_IS_FREE_EVENT = 1` … `E_NO_BALANCE = 15` (`sources/market.move:29-43`) — so the next free code is **16**.

The repo already uses the "compute in u128, then cap" pattern elsewhere (`hub` has an `E_*` "Value too high" guard — see `web/lib/moveErrors.ts:58` `hub: { ... 3: "Value too high." }`). Mirror that style.

### Finding 2 — zero-value bets accepted in both predict bet paths

`sources/predict.move:283-313` — `place_bet` (the shared YES/NO path) reads `amt = coin::value(&stake)` and writes the table + emits `Bet` with **no `amt > 0` guard**:

```move
fun place_bet<T>(
    market: &mut SelloutMarket<T>,
    stake: Coin<T>,
    yes: bool,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now < market.expiry_ms, E_STILL_OPEN);

    let amt = coin::value(&stake);
    let bal = coin::into_balance(stake);
    // ... upsert_stake(...) ; sui_event::emit(Bet { ... amount: amt }) ...
}
```

`sources/predict.move:516-542` — `bet_bucket` (range markets) has the same gap:

```move
public fun bet_bucket<T>(
    market: &mut RangeMarket<T>,
    bucket: u64,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now < market.expiry_ms, E_STILL_OPEN);
    assert!(bucket < vector::length(&market.pools), E_BAD_BUCKET);

    let amt = coin::value(&stake);
    let bal = coin::into_balance(stake);
    // ... upsert_stake(...) ; sui_event::emit(RangeBet { ... amount: amt }) ...
}
```

`claim` later asserts `stake > 0` at `sources/predict.move:248` (`assert!(stake > 0, E_NO_STAKE)`), so a 0-stake entry is dead weight that can never be claimed but still emitted a phantom event. Existing predict error consts (`sources/predict.move:38-48`) are:

```move
const E_ALREADY_SETTLED: u64 = 1;
const E_NOT_EXPIRED: u64 = 2;
const E_STILL_OPEN: u64 = 3;
const E_WRONG_EVENT: u64 = 4;
const E_NOT_SETTLED: u64 = 5;
const E_NO_STAKE: u64 = 6;
const E_BAD_CUTOFFS: u64 = 7;
const E_BAD_BUCKET: u64 = 8;
```

So the next free predict code is **9**. NOTE: `web/lib/moveErrors.ts:59-66` currently maps predict only `1`–`6` (it predates `E_BAD_CUTOFFS`/`E_BAD_BUCKET`); you will add the mapping for the new code `9`.

### Finding 3 — `remove_checkin_signer` emits the "removed" event unconditionally

`sources/event.move:363-369`:

```move
public fun remove_checkin_signer(cap: &OrganizerCap, event: &mut Event, pubkey: vector<u8>) {
    assert_organizer(cap, event);
    if (vec_set::contains(&event.checkin_signers, &pubkey)) {
        vec_set::remove(&mut event.checkin_signers, &pubkey);
    };
    event::emit(CheckinSignerRemoved { event_seq: event.event_seq, pubkey });
}
```

The `vec_set::remove` is correctly guarded, but `event::emit(CheckinSignerRemoved ...)` fires regardless — a wrong/typo'd pubkey produces a false "removed" confirmation. Compare the sibling `add_checkin_signer` at `sources/event.move:351-361`, which validates the key shape and only mutates inside the `if`:

```move
public fun add_checkin_signer(cap: &OrganizerCap, event: &mut Event, pubkey: vector<u8>) {
    assert_organizer(cap, event);
    assert!(pubkey.length() == 32, E_INVALID_SIGNER_KEY);
    assert!(pubkey != ZERO_PUBKEY, E_INVALID_SIGNER_KEY);
    if (!vec_set::contains(&event.checkin_signers, &pubkey)) {
        vec_set::insert(&mut event.checkin_signers, pubkey);
    };
    event::emit(CheckinSignerAdded { event_seq: event.event_seq, pubkey });
}
```

**Chosen fix = assert-the-key-exists** (abort when removing an unregistered key), NOT "move the emit inside the if". Rationale: Move's `test_scenario` cannot easily assert that an event was *not* emitted, so the moved-emit variant is not cleanly testable; an `assert!` gives a deterministic `#[expected_failure(abort_code = ...)]` test. This also matches the module's "reject malformed input" posture in `add_checkin_signer`. Existing event error consts (`sources/event.move:32-44`) run `E_EMPTY_NAME = 1` … `E_INVALID_SIGNER_KEY = 14`, so the next free event code is **15**.

`event_seq` is a `public fun` (`sources/event.move:402`) and `is_checkin_signer` is `public(package)` (`sources/event.move:376`), so a same-package test can read membership directly if needed.

### Finding 4 — `settle_range` doc comment contradicts the (correct) code

`sources/predict.move:546-548` (the doc comment) vs `sources/predict.move:558` (the code):

```move
/// Resolve the market by reading the canonical `Event`. Permissionless: anyone
/// can settle once `now >= expiry_ms`. The winning bucket is the first `i` in
/// `0..N-1` with `minted < cutoffs[i]`, else the last bucket `N`.
public fun settle_range<T>( ... ) {
    assert!(object::id(event) == market.event_id, E_WRONG_EVENT);
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now >= market.settle_after_ms, E_NOT_EXPIRED);   // <-- settle_after_ms, NOT expiry_ms
```

`settle_after_ms` is the `end_ms` snapshot set at creation (`sources/predict.move:470` `let settle_after_ms = event::end_ms(event);`), whereas `expiry_ms` is the `start_ms` snapshot (betting deadline, `sources/predict.move:469`). The code is **correct** and matches `SelloutMarket::settle`, whose comment already says the right thing (`sources/predict.move:179-181`: "anyone can settle once `now >= settle_after_ms` (= `end_ms` snapshot at creation)"). The regression test `tests/predict_range_tests.move:389-403` (`settle_range_after_start_before_end_aborts`, `#[expected_failure(abort_code = ... E_NOT_EXPIRED)]`) and the door-sales test at `tests/predict_range_tests.move:405-435` guard exactly this behavior. **Fix the comment only — change no code.**

### Test-style exemplars (mirror these)

- Move test harness filters **by test function name**: `sui move test set_price_zero` runs `set_price_zero_fails`. (Verified: `sui move test set_price_zero` → `[ PASS ] ... set_price_zero_fails`, `Total tests: 1`.)
- Negative test pattern (event const): `tests/hostit_ticket_tests.move:441-449`
  ```move
  #[test, expected_failure(abort_code = hostit_ticket::event::E_ZERO_PRICE)]
  fun set_price_zero_fails() {
      let (mut sc, mut clock) = begin();
      clock.set_for_testing(CREATE_NOW);
      let cap = create_event(&mut sc, &clock, 100, 5, false, false);
      sc.next_tx(ORG);
      let mut ev = sc.take_shared<Event>();
      event::set_price<SUI>(&cap, &mut ev, 0);   // aborts E_ZERO_PRICE
      ts::return_shared(ev);
      destroy(cap);
      clock.destroy_for_testing();
      sc.end();
  }
  ```
- Happy-path buy + the helpers/consts you reuse for Step 1's test: `tests/hostit_ticket_tests.move:191-227` (`set_price_and_buy`). Helpers in that module: `create_event(sc, clock, max_tickets, max_per_user, is_free, is_refundable)` (`:50-77`), `mint(amount, sc): Coin<SUI>` (`:79-81`), `begin()`, `s()`. Consts: `PRICE = 1_000_000` (`:32`), `HOSTIT_FEE = 30_000` (`:33`), `BUY_NOW = 50_000_000` (`:28`), `CREATE_NOW` (`:24`). `ORG`/`BUYER` addresses at `:18-20`.
- Signer-key test pattern + a valid non-zero 32-byte pubkey literal: `tests/hostit_ticket_tests.move:986-996` uses `let pubkey = x"0100000000000000000000000000000000000000000000000000000000000000";` and `event::add_checkin_signer(&cap, &mut ev, pubkey)`. The bad-key negative test is `add_signer_bad_key_fails` at `:1345-1357`.
- Predict (sellout) test module helpers: `tests/predict_tests.move` — `place_yes(sc, clock, who, amount)` (`:93-99`), `place_no(...)` (`:101-107`), `open_market(sc, clock, who)` (`:70-75`), `create_event(sc, clock, max_tickets)` (`:47-67`), `begin()` (`:36-41`). Bet-window negative test pattern: `bet_after_expiry_aborts` (`:305-321`), const `BET_NOW = 50_000_000` (`:28`).
- Predict (range) test module helpers: `tests/predict_range_tests.move` — `place_bet(sc, clock, who, bucket, amount)` (`:93-99`), `open_market(sc, clock, who, cutoffs)` (`:71-76`), `create_event(sc, clock, max_tickets)` (`:48-68`). Bad-bucket negative test: `bet_invalid_bucket_aborts` (`:279-295`).
- `web/lib/moveErrors.ts` mapping shape — the per-module `Record<number, string>` in `MAP` (`web/lib/moveErrors.ts:5-75`): each module key holds `{ <code>: "<human message>" }`. The `event`, `market`, `predict` blocks are at `:33-48`, `:16-32`, `:59-66`.

## Commands you will need

Run Move commands from the **repo root** `/Users/dadadave/Dev/HostIT/sui-ticket`. Run frontend commands from `/Users/dadadave/Dev/HostIT/sui-ticket/web`. Package manager is **bun only** — never npm/pnpm.

| Purpose | Command | Expected on success |
|---|---|---|
| Move build | `sui move build` | ends with `BUILDING hostit_ticket`, no error |
| Run one Move test | `sui move test <name-substring>` | `Test result: OK. Total tests: N; passed: N; failed: 0` |
| Run all Move tests | `sui move test` | `Test result: OK.`, `failed: 0` |
| Frontend typecheck (primary gate) | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` | exit 0, no output |
| Frontend lint | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` | exit 0 |
| Frontend unit tests | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` | all pass |

(All four verified during recon: `sui move build` and `sui move test set_price_zero` / `set_price_zero` both succeeded at `957206b`.)

NOTE: The first lines of every `sui move` invocation print a `[NOTE] Dependencies on Sui, MoveStdlib, ...` warning and `INCLUDING DEPENDENCY` lines — that is normal, not an error.

## Suggested executor toolkit

- Skill `suiper:review-move` or `suiper:debug-move` if you get stuck on a Move compile error.
- No browser/E2E layer exists; do not attempt one. Do NOT run `bun run build` (it corrupts the dev `.next/` bundle). `bunx tsc --noEmit` is the frontend gate.

## Scope

**In scope** (the only files you may modify):
- `sources/event.move` — Steps 3 (and its const)
- `sources/market.move` — Step 1 (overflow guard + const)
- `sources/predict.move` — Step 2 (zero-bet guards + const) and Step 4 (comment only)
- `tests/hostit_ticket_tests.move` — new tests for Step 1 and Step 3
- `tests/predict_tests.move` — new test for Step 2 (sellout path)
- `tests/predict_range_tests.move` — new test for Step 2 (range path)
- `web/lib/moveErrors.ts` — new human-message mappings for the 3 new error codes (Steps 1–3)
- `plans/README.md` — status row, **only if it already exists** (it does not at planning time; do not create it)

**Out of scope** (do NOT touch, even though they look related):
- `sources/checkin.move`, `sources/access.move`, `sources/poap.move`, `sources/forum.move`, `sources/hub.move`, `sources/ticket.move` — unrelated to these four fixes.
- `web/lib/config.ts` and `SPONSORED_TARGETS` — you are NOT adding or removing entry functions, only error codes, so the sponsor allowlist is unaffected. Do not edit it.
- `Move.toml`, `published-at`, any deploy/upgrade step — this plan does **not** deploy. On-chain upgrades require separate explicit per-deploy authorization (see CLAUDE.md) and are out of scope here.
- `Finding 4` is a comment-only change — do NOT alter the `assert!(now >= market.settle_after_ms, ...)` line or any other `settle_range` logic.
- Do not rename or renumber any existing `E_*` constant — only append new ones at the next free number.

## Git workflow

- Branch off `main`: `git checkout -b advisor/008-move-quick-correctness`
- Commit per step (4 commits) or per logical unit. Conventional-commit style (matches repo `git log`, e.g. `fix(market): guard buy total against u64 overflow`). Example messages:
  - `fix(market): cap buy total in u128 to avoid u64 overflow abort`
  - `fix(predict): reject zero-value bets in place_bet and bet_bucket`
  - `fix(event): abort remove_checkin_signer on unregistered key`
  - `docs(predict): correct settle_range comment to settle_after_ms`
- End each commit message body with the repo's trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Do **NOT** push or open a PR. (Repo flow is issue → branch → PR, and `gh` may hang; leave PR creation to the operator.)

## Steps

Do the steps in order. Each is independent and self-verifying; the build stays green between steps.

### Step 1: Guard `buy<T>` total against u64 overflow (market)

1. In `sources/market.move`, add a new error const after `E_NO_BALANCE: u64 = 15;` (around `sources/market.move:43`):
   ```move
   const E_PRICE_OVERFLOW: u64 = 16;
   ```
   Add a u128 ceiling const near `BPS_DENOM` (around `sources/market.move:25`):
   ```move
   const U64_MAX: u128 = 18446744073709551615;
   ```
2. In `buy<T>` (`sources/market.move:96-102`), replace the unguarded u64 `total` with a u128 computation that is asserted in range **before** the `coin::split`. Target shape:
   ```move
   let price = event::get_price<T>(event);
   let hostit = (((price as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
   let total_u128 = (price as u128) + (hostit as u128);
   assert!(total_u128 <= U64_MAX, E_PRICE_OVERFLOW);
   let total = total_u128 as u64;

   let mut payment = payment;
   assert!(coin::value(&payment) >= total, E_INSUFFICIENT_PAYMENT);
   let total_coin = coin::split(&mut payment, total, ctx);
   ```
   Leave everything after `coin::split` unchanged.
3. In `web/lib/moveErrors.ts`, add to the `market` block (`web/lib/moveErrors.ts:16-32`) a new line:
   ```ts
   16: "This ticket price is too high to process (would overflow). Set a lower price.",
   ```
4. Add a regression test to `tests/hostit_ticket_tests.move`. Mirror `set_price_and_buy` (`:191-227`) but set a price that makes `price + hostit` exceed `u64::MAX`. Because `set_price` has no ceiling, set `price = 18446744073709551615` (u64::MAX); then `hostit > 0`, so `buy` must abort `E_PRICE_OVERFLOW`. Place it near the pricing tests (after `set_price_wrong_cap_fails`, ~`:467`):
   ```move
   #[test, expected_failure(abort_code = hostit_ticket::market::E_PRICE_OVERFLOW)]
   fun buy_price_overflow_fails() {
       let (mut sc, mut clock) = begin();
       clock.set_for_testing(CREATE_NOW);
       let cap = create_event(&mut sc, &clock, 100, 5, false, false);
       sc.next_tx(ORG);
       let mut ev = sc.take_shared<Event>();
       event::set_price<SUI>(&cap, &mut ev, 18446744073709551615); // u64::MAX; price + 3% fee overflows u64
       ts::return_shared(ev);

       clock.set_for_testing(BUY_NOW);
       sc.next_tx(BUYER);
       let mut hub = sc.take_shared<Hub>();
       let mut ev = sc.take_shared<Event>();
       let pay = mint(18446744073709551615, &mut sc); // enough that the overflow guard, not E_INSUFFICIENT_PAYMENT, fires first
       market::buy<SUI>(&mut ev, &mut hub, pay, BUYER, &clock, sc.ctx());
       ts::return_shared(hub);
       ts::return_shared(ev);
       destroy(cap);
       clock.destroy_for_testing();
       sc.end();
   }
   ```
   IMPORTANT: the overflow `assert!` must come **before** the `E_INSUFFICIENT_PAYMENT` assert in `buy<T>` (it does in the target shape above), so this test reaches the overflow check. If your test instead aborts with `market` code 7 (`E_INSUFFICIENT_PAYMENT`), your ordering is wrong — fix the order in `buy<T>`, do not weaken the test.

**Verify**:
- `sui move build` → ends with `BUILDING hostit_ticket`, no error.
- `sui move test buy_price_overflow_fails` → `Test result: OK. Total tests: 1; passed: 1; failed: 0`.
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0, no output.

### Step 2: Reject zero-value bets in both predict paths (predict)

1. In `sources/predict.move`, add a new error const after `E_BAD_BUCKET: u64 = 8;` (around `sources/predict.move:48`):
   ```move
   const E_ZERO_BET: u64 = 9;
   ```
2. In `place_bet` (`sources/predict.move:283-313`), add the guard immediately after `let amt = coin::value(&stake);` and **before** `coin::into_balance`:
   ```move
   let amt = coin::value(&stake);
   assert!(amt > 0, E_ZERO_BET);
   let bal = coin::into_balance(stake);
   ```
3. In `bet_bucket` (`sources/predict.move:516-542`), add the same guard immediately after `let amt = coin::value(&stake);` and before `coin::into_balance`:
   ```move
   let amt = coin::value(&stake);
   assert!(amt > 0, E_ZERO_BET);
   let bal = coin::into_balance(stake);
   ```
4. In `web/lib/moveErrors.ts`, add to the `predict` block (`web/lib/moveErrors.ts:59-66`) a new line:
   ```ts
   9: "Your bet amount must be greater than zero.",
   ```
   (Code `9`, not `7`/`8` — `7`/`8` are `E_BAD_CUTOFFS`/`E_BAD_BUCKET` in the Move source even though they are not yet in this map; leave them unmapped, this plan only adds `9`.)
5. Add a regression test to `tests/predict_tests.move` (sellout path). Mirror `bet_after_expiry_aborts` (`:305-321`) but bet 0 inside the open window:
   ```move
   #[test, expected_failure(abort_code = hostit_ticket::predict::E_ZERO_BET)]
   fun zero_bet_aborts() {
       let (mut sc, mut clock) = begin();
       clock.set_for_testing(CREATE_NOW);
       let cap = create_event(&mut sc, &clock, MAX_TICKETS);
       open_market(&mut sc, &clock, ALICE);
       clock.set_for_testing(BET_NOW); // betting open
       place_yes(&mut sc, &clock, ALICE, 0); // zero stake -> abort
       destroy(cap);
       clock.destroy_for_testing();
       sc.end();
   }
   ```
6. Add a regression test to `tests/predict_range_tests.move` (range path). Mirror `bet_invalid_bucket_aborts` (`:279-295`) but bet 0 into a valid bucket:
   ```move
   #[test, expected_failure(abort_code = hostit_ticket::predict::E_ZERO_BET)]
   fun zero_bet_bucket_aborts() {
       let (mut sc, mut clock) = begin();
       clock.set_for_testing(CREATE_NOW);
       let cap = create_event(&mut sc, &clock, MAX_TICKETS);
       open_market(&mut sc, &clock, ALICE, vector[100, 500]);
       clock.set_for_testing(BET_NOW);
       place_bet(&mut sc, &clock, ALICE, 0, 0); // bucket 0, zero stake -> abort
       destroy(cap);
       clock.destroy_for_testing();
       sc.end();
   }
   ```

**Verify**:
- `sui move build` → ends with `BUILDING hostit_ticket`, no error.
- `sui move test zero_bet` → runs both `zero_bet_aborts` and `zero_bet_bucket_aborts`; expect `Test result: OK. Total tests: 2; passed: 2; failed: 0`.
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0.

### Step 3: Abort `remove_checkin_signer` when the key was never registered (event)

1. In `sources/event.move`, add a new error const after `E_INVALID_SIGNER_KEY: u64 = 14;` (around `sources/event.move:44`):
   ```move
   const E_SIGNER_NOT_FOUND: u64 = 15;
   ```
2. Rewrite `remove_checkin_signer` (`sources/event.move:363-369`) to abort when the key is absent, so the `CheckinSignerRemoved` event only fires on a real removal. Target shape:
   ```move
   public fun remove_checkin_signer(cap: &OrganizerCap, event: &mut Event, pubkey: vector<u8>) {
       assert_organizer(cap, event);
       assert!(vec_set::contains(&event.checkin_signers, &pubkey), E_SIGNER_NOT_FOUND);
       vec_set::remove(&mut event.checkin_signers, &pubkey);
       event::emit(CheckinSignerRemoved { event_seq: event.event_seq, pubkey });
   }
   ```
3. In `web/lib/moveErrors.ts`, add to the `event` block (`web/lib/moveErrors.ts:33-48`) a new line:
   ```ts
   15: "That key isn't a registered check-in signer — nothing to remove.",
   ```
4. Add two tests to `tests/hostit_ticket_tests.move`. Use the valid non-zero 32-byte pubkey literal pattern from `:993`. Place them near `add_signer_bad_key_fails` (~`:1345`):
   - A happy-path removal (proves the normal remove still works) — uses `event::is_checkin_signer`, which is `public(package)` and callable from this same-package test module:
     ```move
     #[test]
     fun add_then_remove_signer_ok() {
         let (mut sc, mut clock) = begin();
         clock.set_for_testing(CREATE_NOW);
         let cap = create_event(&mut sc, &clock, 100, 5, true, false);
         let pubkey = x"0100000000000000000000000000000000000000000000000000000000000000";
         sc.next_tx(ORG);
         let mut ev = sc.take_shared<Event>();
         event::add_checkin_signer(&cap, &mut ev, pubkey);
         assert!(event::is_checkin_signer(&ev, &pubkey), 0);
         event::remove_checkin_signer(&cap, &mut ev, pubkey);
         assert!(!event::is_checkin_signer(&ev, &pubkey), 1);
         ts::return_shared(ev);
         destroy(cap);
         clock.destroy_for_testing();
         sc.end();
     }
     ```
     If `event::is_checkin_signer` is not callable from the test (compile error about visibility), drop both `assert!` lines that call it and keep the add/remove calls — the test then just proves remove of a registered key does not abort.
   - The bug-fix regression (removing an unregistered key now aborts):
     ```move
     #[test, expected_failure(abort_code = hostit_ticket::event::E_SIGNER_NOT_FOUND)]
     fun remove_unregistered_signer_fails() {
         let (mut sc, mut clock) = begin();
         clock.set_for_testing(CREATE_NOW);
         let cap = create_event(&mut sc, &clock, 100, 5, true, false);
         let pubkey = x"0100000000000000000000000000000000000000000000000000000000000000";
         sc.next_tx(ORG);
         let mut ev = sc.take_shared<Event>();
         event::remove_checkin_signer(&cap, &mut ev, pubkey); // never added -> abort
         ts::return_shared(ev);
         destroy(cap);
         clock.destroy_for_testing();
         sc.end();
     }
     ```

**Verify**:
- `sui move build` → ends with `BUILDING hostit_ticket`, no error.
- `sui move test remove_unregistered_signer_fails` → `Total tests: 1; passed: 1; failed: 0`.
- `sui move test add_then_remove_signer_ok` → `Total tests: 1; passed: 1; failed: 0`.
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0.

### Step 4: Correct the `settle_range` doc comment (predict, comment only)

1. In `sources/predict.move`, edit ONLY the doc comment at `sources/predict.move:546-548`. Replace the phrase `once \`now >= expiry_ms\`` with the accurate gate. Target comment:
   ```move
   /// Resolve the market by reading the canonical `Event`. Permissionless: anyone
   /// can settle once `now >= settle_after_ms` (= `end_ms` snapshot at creation),
   /// so door sales during the event are counted. The winning bucket is the first
   /// `i` in `0..N-1` with `minted < cutoffs[i]`, else the last bucket `N`.
   ```
   Do NOT change the `assert!(now >= market.settle_after_ms, E_NOT_EXPIRED);` line or any other code. This brings the comment in line with `SelloutMarket::settle`'s comment (`sources/predict.move:179-181`).
2. No new test (comment-only). The existing guard tests must still pass.

**Verify**:
- `sui move build` → ends with `BUILDING hostit_ticket`, no error.
- `sui move test settle_range_after_start_before_end_aborts` → `Total tests: 1; passed: 1; failed: 0` (the regression test that the comment must not contradict).
- `git -C /Users/dadadave/Dev/HostIT/sui-ticket diff sources/predict.move` shows changes ONLY inside the Step 2 guards and the Step 4 comment — no change to any `assert!(now >= ...)` line.

## Test plan

New tests, by file:
- `tests/hostit_ticket_tests.move`: `buy_price_overflow_fails` (Step 1), `add_then_remove_signer_ok` + `remove_unregistered_signer_fails` (Step 3). Model after `set_price_and_buy` (`:191`) and `add_signer_bad_key_fails` (`:1345`).
- `tests/predict_tests.move`: `zero_bet_aborts` (Step 2 sellout). Model after `bet_after_expiry_aborts` (`:305`).
- `tests/predict_range_tests.move`: `zero_bet_bucket_aborts` (Step 2 range). Model after `bet_invalid_bucket_aborts` (`:279`).

Cases covered: the exact regression for each bug (overflow abort instead of VM crash; zero-stake rejection on both bet paths; unregistered-key removal abort) plus one happy-path (signer add→remove) to prove the fix did not break the normal path.

Full verification (run after all four steps):
- `sui move test` → `Test result: OK.`, `failed: 0`, and the total test count is the pre-change count **+ 5** (1 + 2 + 2 across the three files). Record the count before you start (`sui move test 2>&1 | tail -1`).
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0.
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` → exit 0.
- `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` → all pass (the `moveErrors` edits are additive; existing vitest suites should be unaffected).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `sui move build` (from repo root) ends with `BUILDING hostit_ticket` and no error.
- [ ] `sui move test` → `Test result: OK.` with `failed: 0`, and `Total tests` increased by exactly 5 vs. the pre-change baseline.
- [ ] `sui move test buy_price_overflow_fails` passes (1/1).
- [ ] `sui move test zero_bet` passes (2/2: `zero_bet_aborts`, `zero_bet_bucket_aborts`).
- [ ] `sui move test remove_unregistered_signer_fails` passes (1/1) and `sui move test add_then_remove_signer_ok` passes (1/1).
- [ ] `grep -n "E_PRICE_OVERFLOW" sources/market.move` returns the const def + its use in `buy<T>` (2 matches).
- [ ] `grep -n "E_ZERO_BET" sources/predict.move` returns 3 matches (const def + `place_bet` + `bet_bucket`).
- [ ] `grep -n "E_SIGNER_NOT_FOUND" sources/event.move` returns 2 matches (const def + `remove_checkin_signer`).
- [ ] `grep -n "settle once .now >= expiry_ms" sources/predict.move` returns NO matches (the stale comment is gone); `grep -n "settle_after_ms" sources/predict.move` still shows the `settle_range` assert untouched.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` exits 0.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` exits 0 and `bun run test` all pass.
- [ ] `grep -n "16:" web/lib/moveErrors.ts` (market block), the predict `9:` line, and the event `15:` line are present (3 new mappings).
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows ONLY the in-scope files modified (and `plans/README.md` only if it already existed): `sources/event.move`, `sources/market.move`, `sources/predict.move`, `tests/hostit_ticket_tests.move`, `tests/predict_tests.move`, `tests/predict_range_tests.move`, `web/lib/moveErrors.ts`.
- [ ] `plans/README.md` row for plan 008 updated to DONE — only if that file exists.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `957206b`, OR any "Current state" excerpt does not match the live code (e.g. `buy<T>` already computes `total` in u128, or `remove_checkin_signer` already asserts, or a `settle_range` gate now reads `expiry_ms` instead of `settle_after_ms`). Report the mismatch — some of these fixes may already be partially applied.
- The next free error number you find does not match what this plan states (market 16, predict 9, event 15) — i.e. a const at that number already exists. Do NOT reuse or renumber; report the collision.
- `buy_price_overflow_fails` aborts with `market` code `7` (`E_INSUFFICIENT_PAYMENT`) instead of `16` — your assert ordering in `buy<T>` is wrong; fix the order so the overflow guard precedes the payment check. If it still fails after that fix, stop and report.
- `event::is_checkin_signer` cannot be called from the test module (visibility error) AND removing those two assert lines (per Step 3's fallback) does not resolve it — stop and report.
- Any verification command fails twice after a reasonable fix attempt.
- A fix appears to require touching an out-of-scope file (especially `web/lib/config.ts` / `SPONSORED_TARGETS`, `Move.toml`, or any other `sources/*.move`).
- Anything suggests an on-chain deploy/upgrade is needed — this plan never deploys; report and stop.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **No deploy is performed by this plan.** These Move changes only take effect on-chain after a package upgrade, which is a separate, explicitly-authorized step (see CLAUDE.md "Deploys are package upgrades (gated)"). Until then, `web/lib/moveErrors.ts` will map codes that the *deployed* package does not yet emit — harmless (the map is keyed by module+code and only consulted on a real abort), but the new human messages won't surface until after the upgrade. Note this in the PR.
- The new error numbers (market 16, predict 9, event 15) are now reserved. Any future const in those modules must continue from the next free number.
- When the package is next upgraded and `PACKAGE_ID_LATEST` rolls in `web/lib/config.ts`, no `predict` *type-origin* pin changes are needed here — this plan adds no new struct, only a function-level guard and an error const.
- Reviewer should scrutinize: (a) the u128 overflow assert in `buy<T>` precedes `coin::split` and `E_INSUFFICIENT_PAYMENT` (ordering is load-bearing for the test and the UX); (b) `remove_checkin_signer` now aborts rather than silently no-ops — confirm no frontend caller relied on the old idempotent (no-abort) behavior. Check `web/` for callers of `remove_checkin_signer`: `grep -rn "remove_checkin_signer\|removeCheckinSigner\|removeSigner" web/` — if a screen calls it expecting a silent no-op on a stale key, it should now surface the new `event` code 15 via `humanizeError` (which this plan wires up). This caller audit is part of PR review, not this plan's edits.
- Deferred out of this plan (intentionally): capping `price` inside `set_price` itself (the overflow is fixed at the `buy` site instead, which is where the unsafe arithmetic actually was; a `set_price` ceiling is a reasonable v2 hardening but would need its own error-code decision and would change `set_price`'s test surface).
