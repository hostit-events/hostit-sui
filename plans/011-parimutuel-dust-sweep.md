# Plan 011: Recover locked rounding dust from settled prediction markets

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` IF that file exists; if it does not exist yet, do NOT
> create it (a reviewer owns the index) — just note in your final report that
> you finished.
>
> **Drift check (run first)**:
> `git diff --stat 957206b..HEAD -- sources/predict.move tests/predict_tests.move tests/predict_range_tests.move web/lib/moveErrors.ts web/lib/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20

> **Planning-time drift note (read this).** The task brief named planned-at SHA
> `9b169c0` and "clean working tree", but the live repo at planning time was at
> `957206b` ("feat(forum): organizer admin — read, post-as-organizer,
> moderate [#37]") with `plans/` present but untracked. The excerpts below were
> copied from the live files at `957206b`, so the SHA stamped above is `957206b`.
> If `git log --oneline -1` does not show `957206b` (or a descendant that leaves
> `sources/predict.move` byte-identical), run the drift check and treat any
> mismatch in the excerpts as a STOP condition.

## Why this matters

The `predict` module pays parimutuel winners with **floor division**
(`floor(stake * losing_total / winning_total)`). The flooring leaves sub-unit
residue in the losing pool(s) after all winners have claimed. Both market
objects — `SelloutMarket<T>` and `RangeMarket<T>` — are `key`-only shared
objects with **no delete, drain, or sweep function**, so that residue is
**permanently unrecoverable**: nobody can ever withdraw it and the object can
never be destroyed. Per market the dust is negligible (a few smallest-units of
the collateral coin), but it is a genuine *unrecoverable-funds* invariant break
that accumulates across every market the platform ever settles. This plan adds
a **permissionless, safe sweep** that recovers the dust once a market is fully
claimed, plus a Move test proving every pool reaches **exactly 0** for a
rounding-residue case — turning "dust is stranded forever" into "dust is
recoverable, and the no-locked-funds invariant is test-enforced".

## Current state

Files involved (all live at `957206b`):

- `sources/predict.move` — the Move module. Contains `SelloutMarket<T>` (line
  57), `RangeMarket<T>` (line 399), the floor-division payouts in `claim`
  (lines 253–257) and `claim_range` (lines 611–657, floor at 640–641), the
  error constants (lines 38–48), and the internal helpers. **This is where the
  fix lands.**
- `tests/predict_tests.move` — `SelloutMarket` test suite. Test helpers and the
  `*_pool_value == 0` assertion style live here.
- `tests/predict_range_tests.move` — `RangeMarket` test suite. Same helper
  shape (`open_market`, `place_bet`, `settle`, `claim_amount`).
- `web/lib/moveErrors.ts` — `humanizeError`; the `predict:` error-code map
  (lines 59–66) must gain any new error code introduced here.
- `web/lib/config.ts` — single source of truth for Move targets and the Enoki
  `SPONSORED_TARGETS` allowlist (lines 114–139). A new sponsored entry fn is
  added here (one place).
- `web/lib/predict.ts` — PTB constructors (one per Move entry fn). A new entry
  fn gets a matching constructor here.
- `web/lib/__tests__/predict.test.ts` — vitest smoke tests for the PTB
  constructors and odds math.
- `web/lib/__tests__/sponsoredTargets.test.ts` — pins the
  PACKAGE_ID-vs-PACKAGE_ID_LATEST origin invariant for `SPONSORED_TARGETS`.

### The dust source — `SelloutMarket::claim` (sources/predict.move:250–268)

```move
    // Pro-rata share of the losing pool. `winning_total > 0` is guaranteed
    // because this caller had stake > 0 on the winning side. If `losing_total`
    // is 0 (one-sided market), winners just reclaim their own stake.
    let loser_share = if (losing_total > 0) {
        (((stake as u128) * (losing_total as u128)) / (winning_total as u128)) as u64
    } else {
        0
    };

    // Pull `stake` from the winning pool and `loser_share` from the losing pool,
    // then merge and hand the caller a single coin.
    let (winning_pool_mut, losing_pool_mut) = winning_losing_pools_mut(market);
    let mut payout_bal = balance::split(winning_pool_mut, stake);
    if (loser_share > 0) {
        balance::join(&mut payout_bal, balance::split(losing_pool_mut, loser_share));
    };

    coin::from_balance(payout_bal, ctx)
```

The `/` is integer floor division. Summed over all winners, the `loser_share`
draws are `<= losing_total`, so the losing pool ends at `losing_total - sum >= 0`
— a small positive residue that no code path can remove.

### The dust source — `RangeMarket::claim_range` (sources/predict.move:631–657)

```move
        if (loser_share > 0) {
            let mut remaining = loser_share;
            let buckets = vector::length(&market.pools);
            let mut b = 0;
            while (b < buckets && remaining > 0) {
                if (b != wb) {
                    let orig = *vector::borrow(&market.totals, b);
                    if (orig > 0) {
                        // Pro-rata of THIS losing bucket by original weight.
                        let want = (((loser_share as u128) * (orig as u128))
                            / (losing_total as u128)) as u64;
                        let pool_val = balance::value(vector::borrow(&market.pools, b));
                        // Clamp to remaining budget and to what's actually left.
                        let mut take = if (want > remaining) { remaining } else { want };
                        if (take > pool_val) { take = pool_val };
                        ...
```

The code comment at line 630 already concedes: *"only sub-unit rounding dust can
remain."* This plan recovers that dust.

### Structs are `key`-only (no `store`) — sources/predict.move:57 and :399

```move
public struct SelloutMarket<phantom T> has key {
```
```move
public struct RangeMarket<phantom T> has key {
```

Because there is no `store` ability and no `object::delete` call anywhere
(verified: `grep -n "object::delete\|public_transfer\|sweep\|drain" sources/predict.move`
returns nothing), the markets can be neither destroyed nor wrapped. The only
way to get the dust out is a new function that `balance::split`s the remaining
pool value into a coin.

### Stake tables are emptied on claim — the "fully claimed" signal

Each market stores per-bettor stake in `Table<address, u64>` and **removes** a
bettor's entry the moment they claim:

`SelloutMarket` has `yes_stakes` / `no_stakes` (sources/predict.move:76–79).
`remove_winning_stake` / `remove_stake_for` call `table::remove` (lines
274–280, 327–333). `RangeMarket` has `stakes: vector<Table<address, u64>>`
(line 415); `remove_bucket_stake` calls `table::remove` (lines 684–691).

There is **no distinct-bettor counter field** on either struct (verified: no
`table::length` use and no `num_*`/`count` field in `sources/predict.move`).
The Sui stdlib *does* expose `sui::table::length(&t): u64`, and an emptied table
has length 0. **This is the safe, cheap "everyone has claimed" predicate**: a
table reaches length 0 exactly when every entry that was ever added has been
removed by a claim. Use `table::length(...) == 0` for the sweep gate — do NOT
add a hand-maintained counter (more state to keep consistent, more bug surface).

> WHY length-0 is safe and does not strand a winner: a winner's stake entry is
> only removed inside `claim`/`claim_range`. So while any winner is unclaimed,
> their table is non-empty and the gate fails. Once all tables are empty, every
> bettor who could ever claim already has — the only thing left is dust the
> pro-rata math floored away. (In the refund branch — winning side/bucket empty
> — every bettor reclaims from every table they touched, so those tables also
> reach length 0 only after everyone refunds.)

### Existing "pools fully drained" assertion style — tests/predict_tests.move:166–170

```move
    // Pools fully drained.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 5);
    assert!(predict::no_pool_value(&mkt) == 0, 6);
    ts::return_shared(mkt);
```

The range suite uses the same idiom with `predict::range_pool_value(&mkt, i)`
(tests/predict_range_tests.move:164–169). New tests must reuse these getters.
NOTE: in the *existing* tests the chosen stakes divide evenly, so the pools
already hit 0 with no dust. The new test must pick stakes that **do not** divide
evenly so a non-zero residue exists *before* the sweep and 0 *after*.

### Existing predict error map — web/lib/moveErrors.ts:59–66

```ts
  predict: {
    1: "This market is already settled.",
    2: "Betting is still open — you can't settle until the deadline (doors) passes.",
    3: "This market is still open — betting hasn't closed yet.",
    4: "This event doesn't match the market's event.",
    5: "This market isn't settled yet — nothing to claim.",
    6: "You have no winning stake to claim here.",
  },
```

Codes map 1:1 to the Move constants `E_ALREADY_SETTLED=1 … E_BAD_BUCKET=8`
(sources/predict.move:38–48). Codes 7 and 8 (`E_BAD_CUTOFFS`, `E_BAD_BUCKET`)
are intentionally absent from this map today (they're create/bet-time guards the
UI prevents). Any NEW error code you add in Move must get a matching entry here.

### Enoki sponsor allowlist — web/lib/config.ts:131–139

```ts
  `${PACKAGE_ID_LATEST}::predict::create_sellout_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_yes`,
  `${PACKAGE_ID_LATEST}::predict::bet_no`,
  `${PACKAGE_ID_LATEST}::predict::settle`,
  `${PACKAGE_ID_LATEST}::predict::claim`,
  `${PACKAGE_ID_LATEST}::predict::create_range_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_bucket`,
  `${PACKAGE_ID_LATEST}::predict::settle_range`,
  `${PACKAGE_ID_LATEST}::predict::claim_range`,
```

All predict entry fns use `PACKAGE_ID_LATEST` (predict was introduced in an
upgrade). A new predict entry fn must be added here with `PACKAGE_ID_LATEST`.

### PTB-constructor convention — web/lib/predict.ts:142–151 (`claimTx`)

```ts
export function claimTx(args: ClaimArgs): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: targetLatest("predict", "claim"),
    typeArguments: [args.coinType],
    arguments: [tx.object(args.marketId)],
  });
  tx.transferObjects([coin], args.recipient);
  return tx;
}
```

`targetLatest` and `CLOCK_ID` are imported from `./config`
(web/lib/predict.ts:39). A sweep that returns a coin should follow this exact
shape (move call → `transferObjects` to a recipient).

### Frontend PTB smoke-test shape — web/lib/__tests__/predict.test.ts:53–63

```ts
describe("createSelloutMarketTx", () => {
  it("builds a Transaction (the PTB constructor wires a move call without a wallet)", () => {
    const tx = createSelloutMarketTx(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
      "0x2::sui::SUI",
    );
    expect(tx).toBeInstanceOf(Transaction);
    // The built command list contains exactly the create move call.
    const data = tx.getData();
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0].$kind).toBe("MoveCall");
  });
});
```

A new sweep constructor that does move-call + `transferObjects` produces
**2** commands (`data.commands` has length 2: one `MoveCall`, one
`TransferObjects`). Assert accordingly.

### Conventions that bind this work

- Move edition is `2024.beta` (Move.toml:4); error constants are named
  `E_FOO` (sources/predict.move:38–48). Match that naming.
- **Permissionless model**: do NOT gate the sweep behind any cap, organizer, or
  sender check. Anyone may call it; the only gate is the on-chain
  fully-claimed predicate. (CLAUDE.md: "no issuer/buyer role split — never add a
  role gate".)
- Package manager is **bun only** in `web/` — never npm/pnpm.
- **Never run `bun run build` while `bun run dev` is running** — it corrupts
  `.next`. Use `bunx tsc --noEmit` to verify the frontend, not a prod build.

## Commands you will need

| Purpose                     | Command (run from)                                  | Expected on success |
|-----------------------------|-----------------------------------------------------|---------------------|
| Build Move package          | `sui move build` (repo root)                        | `BUILDING hostit_ticket` then exit 0, no errors |
| Run all Move tests          | `sui move test` (repo root)                         | `Test result: OK. Total tests: N; passed: N; failed: 0` |
| Run predict Move tests only | `sui move test predict` (repo root)                 | all matched tests pass, `failed: 0` |
| Frontend typecheck (gate)   | `bunx tsc --noEmit` (in `web/`)                     | exit 0, no output |
| Frontend lint               | `bun run lint` (in `web/`)                          | exit 0 |
| Frontend unit tests         | `bun run test` (in `web/`)                          | all pass (vitest) |
| Frontend predict tests only | `bunx vitest run lib/__tests__/predict.test.ts` (in `web/`) | all pass |

(Verified at planning time: `sui` is on PATH; `web/package.json` defines
`"lint": "eslint ."` and `"test": "vitest run"`.)

## Suggested executor toolkit

- If a `suiper:build-with-move` or `suiper:debug-move` skill is available in
  your environment, you may use it while editing `sources/predict.move`.
- Reference: the existing claim/refund logic in `sources/predict.move` is the
  canonical pattern for `balance::split` → `coin::from_balance`. Reuse it.

## Scope

**In scope** (the only files you should modify):
- `sources/predict.move` — add the sweep entry fn(s) + supporting read getters.
- `tests/predict_tests.move` — add the dust-residue + sweep tests (SelloutMarket).
- `tests/predict_range_tests.move` — add the dust-residue + sweep tests (RangeMarket).
- `web/lib/predict.ts` — add the sweep PTB constructor(s).
- `web/lib/config.ts` — add the new sweep target(s) to `SPONSORED_TARGETS`.
- `web/lib/moveErrors.ts` — add the `predict:` map entry for any new error code.
- `web/lib/__tests__/predict.test.ts` — add a smoke test for the new constructor.

**Out of scope** (do NOT touch, even though they look related):
- **Deploying / upgrading the on-chain package.** This fix is a Move *package
  upgrade* (`sui client upgrade`), which CLAUDE.md says is **gated behind
  explicit, per-deploy user authorization**. DO NOT run `sui client upgrade` or
  `sui client publish`, and do NOT change `Move.toml`, `Published.toml`, or
  `PACKAGE_ID_LATEST`/`PREDICT_*_PKG` in `config.ts`. This plan delivers
  code + tests only; deployment is a separate, human-authorized step. (Because
  the package is not deployed here, `SPONSORED_TARGETS` will reference a
  not-yet-on-chain function — that's fine; the allowlist is just strings until
  the upgrade ships. The sweep constructor will only work end-to-end after the
  upgrade lands.)
- The existing `claim` / `claim_range` payout math — do NOT change the
  per-claim floor division (changing it risks over-paying or under-paying
  winners and reopening already-audited behavior). The dust is removed by a
  *separate* post-claim sweep, not by reworking the per-winner split.
- `web/lib/markets.ts` / event discovery — the sweep does not need a new
  discovery hook for v1 (it's an opportunistic maintenance call).
- Any UI screen under `web/components/screens/` — wiring a "sweep dust" button
  is an explicit v2 follow-up (see Maintenance notes), not part of this plan.

## Git workflow

- Branch: `advisor/011-parimutuel-dust-sweep` (create from current HEAD).
- Commit per logical unit; conventional-commit style (matches repo `git log`,
  e.g. `feat(forum): organizer admin …`). Suggested commits:
  - `feat(predict): permissionless dust sweep for fully-claimed markets`
  - `test(predict): assert pools reach exactly 0 after sweep on rounding residue`
  - `chore(web): wire sweep PTB constructor + sponsor allowlist`
- Do NOT push or open a PR (the repo flow is issue → branch → PR, and `gh` may
  hang). Leave the branch local for the operator to review.

## Steps

### Step 1: Add a fully-claimed predicate + sweep to `SelloutMarket`

In `sources/predict.move`, in the `SelloutMarket` section (after the existing
`claim` / internal helpers, before the `// === Reads ===` block around line
346), add:

1. A new error constant near the others (lines 38–48), e.g.
   `const E_NOT_FULLY_CLAIMED: u64 = 9;` (next free code — 1..8 are taken).
   Add a doc comment in the existing style.

2. A public read getter for "is every bettor claimed", used by both the sweep
   and tests:
   ```move
   /// True once every bettor on both sides has claimed/refunded (both stake
   /// tables are empty). Only residual rounding dust can remain in the pools.
   public fun is_fully_claimed<T>(market: &SelloutMarket<T>): bool {
       market.settled
           && table::length(&market.yes_stakes) == 0
           && table::length(&market.no_stakes) == 0
   }
   ```

3. A permissionless sweep entry fn that returns the combined leftover balance as
   a coin (mirror `claim`'s `balance::split` → `coin::from_balance` shape):
   ```move
   /// Permissionless: recover residual rounding dust from a FULLY-CLAIMED,
   /// settled market. Aborts (`E_NOT_FULLY_CLAIMED`) while any bettor still has
   /// an unclaimed stake, so this can never strand a winner. Returns whatever
   /// balance remains in both pools merged into one coin (often a few
   /// smallest-units; may be 0 if the math happened to divide evenly).
   public fun sweep_dust<T>(
       market: &mut SelloutMarket<T>,
       ctx: &mut TxContext,
   ): Coin<T> {
       assert!(market.settled, E_NOT_SETTLED);
       assert!(
           table::length(&market.yes_stakes) == 0
               && table::length(&market.no_stakes) == 0,
           E_NOT_FULLY_CLAIMED,
       );
       let mut dust = balance::zero<T>();
       balance::join(&mut dust, balance::withdraw_all(&mut market.yes_pool));
       balance::join(&mut dust, balance::withdraw_all(&mut market.no_pool));
       coin::from_balance(dust, ctx)
   }
   ```
   Use `balance::withdraw_all` (drains a `&mut Balance<T>` to a `Balance<T>`) so
   both pools end at exactly 0 regardless of the residue size. Do NOT
   `assert!(value > 0)` — a 0-dust sweep should succeed and return an empty coin
   (an empty `Coin<T>` is legal; the caller can destroy or merge it).

> If `balance::withdraw_all` is not the exact stdlib name in this framework rev,
> the equivalent is `balance::split(&mut p, balance::value(&p))`. Build (Step 7)
> will tell you which compiles; if neither resolves, that is a STOP condition.

**Verify**: `sui move build` → exit 0, `BUILDING hostit_ticket`, no errors.

### Step 2: Add the same predicate + sweep to `RangeMarket`

In the `RangeMarket` section of `sources/predict.move` (after `claim_range` /
its internal helpers, before `// === Reads (range) ===` around line 705), add a
parallel pair. The range market stores pools/stakes as **vectors** of length
`N+1`, so iterate all buckets:

```move
/// True once every bettor in every bucket has claimed/refunded (all stake
/// tables empty). Only residual rounding dust can remain in the pools.
public fun range_is_fully_claimed<T>(market: &RangeMarket<T>): bool {
    if (!market.settled) return false;
    let n = vector::length(&market.stakes);
    let mut i = 0;
    while (i < n) {
        if (table::length(vector::borrow(&market.stakes, i)) != 0) return false;
        i = i + 1;
    };
    true
}

/// Permissionless: recover residual rounding dust from a FULLY-CLAIMED, settled
/// range market. Aborts (`E_NOT_FULLY_CLAIMED`) while any bettor still has an
/// unclaimed stake in any bucket. Merges every bucket pool's leftover into one
/// coin (may be 0).
public fun sweep_range_dust<T>(
    market: &mut RangeMarket<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(market.settled, E_NOT_SETTLED);
    assert!(range_is_fully_claimed(market), E_NOT_FULLY_CLAIMED);
    let mut dust = balance::zero<T>();
    let buckets = vector::length(&market.pools);
    let mut b = 0;
    while (b < buckets) {
        balance::join(
            &mut dust,
            balance::withdraw_all(vector::borrow_mut(&mut market.pools, b)),
        );
        b = b + 1;
    };
    coin::from_balance(dust, ctx)
}
```

Reuse the **same** `E_NOT_FULLY_CLAIMED` constant from Step 1 (one constant
shared by both markets). Note `range_is_fully_claimed` borrows immutably, so it
can be called from inside `sweep_range_dust` before the `&mut` borrow of
`market.pools` begins.

**Verify**: `sui move build` → exit 0, no errors.

### Step 3: Add the SelloutMarket dust-residue + sweep test

In `tests/predict_tests.move`, add a test that creates a market whose pro-rata
split does NOT divide evenly, so dust remains after all winners claim, then
sweeps it to 0. Reuse the existing helpers (`create_event`, `open_market`,
`place_yes`, `place_no`, `mint_tickets`, `settle`, `claim_amount`).

Worked example that leaves dust (use these exact stakes):
- YES: ALICE 10, BOB 10 → `total_yes = 20`. NO: CAROL 7 → `total_no = 7`.
- Event sells out → YES wins. `losing_total = 7`, `winning_total = 20`.
- ALICE share: `floor(10*7/20) = floor(3.5) = 3`; payout `10 + 3 = 13`.
- BOB share: `floor(10*7/20) = 3`; payout `10 + 3 = 13`.
- Distributed from NO pool: `3 + 3 = 6`; NO pool residue **= 7 − 6 = 1** (dust).
- After both claim: `yes_pool_value == 0` (each took back exactly their 10),
  `no_pool_value == 1`. Then `sweep_dust` returns a coin of value **1** and both
  pools are **0**.

Test skeleton (add a `sweep_amount` helper mirroring `claim_amount`):

```move
/// Sweep dust as `who`, returning the swept amount (coin destroyed).
fun sweep_amount(sc: &mut Scenario, who: address): u64 {
    sc.next_tx(who);
    let mut mkt = sc.take_shared<SelloutMarket<USD>>();
    let out = predict::sweep_dust<USD>(&mut mkt, sc.ctx());
    let v = coin::value(&out);
    destroy(out);
    ts::return_shared(mkt);
    v
}

// Rounding dust: 10/10 YES vs 7 NO -> each YES winner floors to +3, leaving 1
// unit locked in the NO pool. The sweep recovers it so every pool ends at 0.
#[test]
fun dust_is_swept_to_zero() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);
    place_yes(&mut sc, &clock, BOB, 10);
    place_no(&mut sc, &clock, CAROL, 7);
    mint_tickets(&mut sc, &mut clock, MAX_TICKETS); // YES wins
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);

    assert!(claim_amount(&mut sc, ALICE) == 13, 0);
    assert!(claim_amount(&mut sc, BOB) == 13, 1);

    // Dust stranded before sweep: NO pool holds the floored remainder.
    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 2);
    assert!(predict::no_pool_value(&mkt) == 1, 3);
    assert!(predict::is_fully_claimed(&mkt), 4);
    ts::return_shared(mkt);

    // Permissionless sweep recovers exactly the 1 unit of dust.
    assert!(sweep_amount(&mut sc, CAROL) == 1, 5);

    sc.next_tx(ADMIN);
    let mkt = sc.take_shared<SelloutMarket<USD>>();
    assert!(predict::yes_pool_value(&mkt) == 0, 6);
    assert!(predict::no_pool_value(&mkt) == 0, 7); // EXACTLY 0 after sweep
    ts::return_shared(mkt);

    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
```

Also add a guard test that sweeping **before** everyone has claimed aborts:

```move
#[test, expected_failure(abort_code = hostit_ticket::predict::E_NOT_FULLY_CLAIMED)]
fun sweep_before_fully_claimed_aborts() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, MAX_TICKETS);
    open_market(&mut sc, &clock, ALICE);
    clock.set_for_testing(BET_NOW);
    place_yes(&mut sc, &clock, ALICE, 10);
    place_yes(&mut sc, &clock, BOB, 10);
    place_no(&mut sc, &clock, CAROL, 7);
    mint_tickets(&mut sc, &mut clock, MAX_TICKETS);
    clock.set_for_testing(SETTLE_NOW);
    settle(&mut sc, &clock);
    let _ = claim_amount(&mut sc, ALICE); // ALICE claims, BOB has NOT
    let _ = sweep_amount(&mut sc, CAROL); // BOB still owed -> abort
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
```

**Verify**: `sui move test predict_tests` → all tests pass, `failed: 0`
(includes `dust_is_swept_to_zero` and `sweep_before_fully_claimed_aborts`).

### Step 4: Add the RangeMarket dust-residue + sweep test

In `tests/predict_range_tests.move`, add the analogous pair using
`predict::sweep_range_dust` / `predict::range_is_fully_claimed` /
`predict::range_pool_value`. Reuse `open_market`, `place_bet`, `settle`,
`claim_amount`, `mint_tickets`.

Worked example that leaves dust (cutoffs `[100, 500]` → 3 buckets):
- Bucket 1 (winning, minted=250): ALICE 10, BOB 10 → `totals[1]=20`.
- Losing buckets: CAROL bucket 0 = 7 → `losing_total = 7`.
- ALICE share `floor(10*7/20)=3` → 13; BOB `floor(10*7/20)=3` → 13.
- Bucket 0 pool residue after both claims **= 7 − 6 = 1**.
- After sweep all three bucket pools = 0; swept coin value = 1.

Add a `sweep_amount` helper that takes `RangeMarket<USD>` and calls
`predict::sweep_range_dust`. Assert pre-sweep `range_pool_value(&mkt, 0) == 1`
and post-sweep all buckets `== 0`. Add a `sweep_range_before_fully_claimed_aborts`
guard (claim only ALICE, then sweep → `E_NOT_FULLY_CLAIMED`).

**Verify**: `sui move test predict_range_tests` → all pass, `failed: 0`.

### Step 5: Map the new Move error code in the frontend

In `web/lib/moveErrors.ts`, add the `E_NOT_FULLY_CLAIMED` code (the integer you
chose in Step 1, e.g. `9`) to the `predict:` map (lines 59–66):

```ts
  predict: {
    1: "This market is already settled.",
    2: "Betting is still open — you can't settle until the deadline (doors) passes.",
    3: "This market is still open — betting hasn't closed yet.",
    4: "This event doesn't match the market's event.",
    5: "This market isn't settled yet — nothing to claim.",
    6: "You have no winning stake to claim here.",
    9: "This market still has unclaimed winnings — dust can only be swept after everyone has claimed.",
  },
```

(Use the exact code number from Step 1; if you used 7, account for the fact that
7/8 already mean `E_BAD_CUTOFFS`/`E_BAD_BUCKET` in Move — do NOT collide. 9 is
the safe next value.)

**Verify**: `bunx tsc --noEmit` (in `web/`) → exit 0.

### Step 6: Add the sweep PTB constructor + sponsor allowlist + frontend test

1. In `web/lib/predict.ts`, add a `sweepDustTx` and a `sweepRangeDustTx`
   mirroring `claimTx` (web/lib/predict.ts:142–151) — move call returning a
   coin, transferred to `recipient`:
   ```ts
   export interface SweepArgs {
     marketId: string;
     coinType: string;
     /** Where the swept dust coin is sent. Defaults to the tx sender in the PTB. */
     recipient: string;
   }

   /** Permissionless: recover residual rounding dust from a fully-claimed
    * SelloutMarket. Aborts on-chain (predict code 9) until everyone has claimed. */
   export function sweepDustTx(args: SweepArgs): Transaction {
     const tx = new Transaction();
     const coin = tx.moveCall({
       target: targetLatest("predict", "sweep_dust"),
       typeArguments: [args.coinType],
       arguments: [tx.object(args.marketId)],
     });
     tx.transferObjects([coin], args.recipient);
     return tx;
   }

   /** Same, for a fully-claimed RangeMarket. */
   export function sweepRangeDustTx(args: SweepArgs): Transaction {
     const tx = new Transaction();
     const coin = tx.moveCall({
       target: targetLatest("predict", "sweep_range_dust"),
       typeArguments: [args.coinType],
       arguments: [tx.object(args.marketId)],
     });
     tx.transferObjects([coin], args.recipient);
     return tx;
   }
   ```

2. In `web/lib/config.ts`, add both targets to `SPONSORED_TARGETS` (after line
   139, alongside the other predict entries), using `PACKAGE_ID_LATEST`:
   ```ts
   `${PACKAGE_ID_LATEST}::predict::sweep_dust`,
   `${PACKAGE_ID_LATEST}::predict::sweep_range_dust`,
   ```

3. In `web/lib/__tests__/predict.test.ts`, add a smoke test mirroring the
   `createSelloutMarketTx` block (lines 53–63), but a sweep constructor does
   move-call + transferObjects, so assert **2** commands:
   ```ts
   describe("sweepDustTx", () => {
     it("builds a 2-command Transaction (move call + transfer)", () => {
       const tx = sweepDustTx({
         marketId: "0x0000000000000000000000000000000000000000000000000000000000000abc",
         coinType: "0x2::sui::SUI",
         recipient: "0x0000000000000000000000000000000000000000000000000000000000000def",
       });
       expect(tx).toBeInstanceOf(Transaction);
       const data = tx.getData();
       expect(data.commands).toHaveLength(2);
       expect(data.commands[0].$kind).toBe("MoveCall");
       expect(data.commands[1].$kind).toBe("TransferObjects");
     });
   });
   ```
   Add `sweepDustTx` to the import at the top of the test file.

**Verify**:
- `bunx tsc --noEmit` (in `web/`) → exit 0.
- `bun run lint` (in `web/`) → exit 0.
- `bunx vitest run lib/__tests__/predict.test.ts lib/__tests__/sponsoredTargets.test.ts`
  (in `web/`) → all pass (the sponsoredTargets invariant test must still pass —
  the two new targets use `PACKAGE_ID_LATEST`, which it requires for
  `::predict::` targets).

### Step 7: Full verification sweep

Run the whole gate, both trees.

**Verify**:
- `sui move build` (root) → exit 0, no errors.
- `sui move test` (root) → `Test result: OK`, `failed: 0`.
- `bunx tsc --noEmit` (web) → exit 0.
- `bun run lint` (web) → exit 0.
- `bun run test` (web) → all pass.

## Test plan

New Move tests:
- `tests/predict_tests.move`:
  - `dust_is_swept_to_zero` — happy path: rounding residue of 1 unit exists
    after all winners claim (`no_pool_value == 1`), `sweep_dust` recovers it,
    both pools end **exactly 0**, swept coin value `== 1`.
  - `sweep_before_fully_claimed_aborts` — `#[expected_failure(abort_code = …::E_NOT_FULLY_CLAIMED)]`:
    sweeping while a winner is unclaimed aborts (proves no winner is stranded).
  - Model after the existing `yes_wins_prorata` (tests/predict_tests.move:135)
    and the `*_pool_value == 0` assertion idiom (lines 166–170).
- `tests/predict_range_tests.move`:
  - `range_dust_is_swept_to_zero` — analogous, bucket-pool residue → 0 after
    `sweep_range_dust`.
  - `sweep_range_before_fully_claimed_aborts` — analogous abort guard.
  - Model after `multi_bucket_prorata` (tests/predict_range_tests.move:133) and
    its `range_pool_value(&mkt, i) == 0` idiom (lines 164–169).

New frontend test:
- `web/lib/__tests__/predict.test.ts`: `sweepDustTx` builds a 2-command
  Transaction (MoveCall + TransferObjects). Model after the `createSelloutMarketTx`
  block (lines 53–63).

Verification: `sui move test predict` → all predict tests pass including the 4
new ones; `bun run test` (web) → all pass including the new smoke test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `sui move build` (root) exits 0 with no errors.
- [ ] `sui move test` (root) prints `Test result: OK` with `failed: 0`.
- [ ] `grep -n "public fun sweep_dust\|public fun sweep_range_dust\|public fun is_fully_claimed\|public fun range_is_fully_claimed\|E_NOT_FULLY_CLAIMED" sources/predict.move` returns all five symbols.
- [ ] `grep -n "dust_is_swept_to_zero\|sweep_before_fully_claimed_aborts" tests/predict_tests.move` returns both test names.
- [ ] `grep -n "sweep_range_dust\|sweep_range_before_fully_claimed_aborts" tests/predict_range_tests.move` returns the sweep test names.
- [ ] `bunx tsc --noEmit` (in `web/`) exits 0.
- [ ] `bun run lint` (in `web/`) exits 0.
- [ ] `bun run test` (in `web/`) passes, including the new `sweepDustTx` smoke test.
- [ ] `grep -n "sweep_dust\|sweep_range_dust" web/lib/config.ts` shows both on `SPONSORED_TARGETS` with `PACKAGE_ID_LATEST`.
- [ ] `grep -n "sweep" web/lib/predict.ts` shows `sweepDustTx` and `sweepRangeDustTx`.
- [ ] `grep -n "9:" web/lib/moveErrors.ts` (or the chosen code) shows the new `predict:` map entry.
- [ ] `git status --porcelain` shows ONLY the seven in-scope files modified (plus this plan file already present); no `Move.toml`, `Published.toml`, or `PACKAGE_ID_LATEST` change.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `sources/predict.move`, the predict test files,
  `web/lib/config.ts`, or `web/lib/moveErrors.ts` changed since `957206b` and
  the "Current state" excerpts no longer match the live code (e.g. the
  `claim`/`claim_range` floor math was already reworked, or a sweep already
  exists). The fix may be unnecessary or must be redesigned.
- Neither `balance::withdraw_all(&mut p)` nor
  `balance::split(&mut p, balance::value(&p))` compiles for draining a pool, or
  `table::length(&t)` is not available in this framework rev — the chosen
  "fully claimed" predicate cannot be expressed; report and stop.
- `is_fully_claimed`/`range_is_fully_claimed` returns true while a known winner
  has not yet claimed in any test you write (i.e. the dust test's pre-sweep
  assertions don't hold). This means the predicate is unsafe — do NOT ship a
  sweep that could strand a winner; report.
- Any verification command fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (especially
  `Move.toml`, `Published.toml`, or a `PACKAGE_ID_*` constant) — that signals
  this drifted into a deploy task, which requires explicit user authorization.
- You are tempted to run `sui client upgrade` / `sui client publish` — DO NOT.
  Deployment is a separate, human-authorized step (CLAUDE.md). Report that the
  code is ready for a gated upgrade instead.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **This is a Move package upgrade.** The new entry fns do not exist on-chain
  until someone runs the gated `sui client upgrade` (per CLAUDE.md /
  `.suiperpower/deploy-context.md`) and then rolls `PACKAGE_ID_LATEST` in
  `web/lib/config.ts` to the new version. Until then, `sweepDustTx` will fail
  on-chain ("function does not exist"). The `SPONSORED_TARGETS` entries are
  harmless strings until the upgrade ships.
- A reviewer should scrutinize the **fully-claimed predicate** above all: it is
  the only thing standing between "recover dust" and "let anyone drain an
  unclaimed winner's funds." Confirm `table::length == 0` is checked for *every*
  stake table (both YES/NO for sellout; all `N+1` buckets for range) and that
  the refund branch (winning side/bucket empty) also drives tables to length 0.
- The sweep sends dust to the **caller/recipient** (permissionless, matching the
  module's no-role-gate design). If product later wants dust to accrue to the
  Hub treasury instead, that's a deliberate policy change — it would couple
  `predict` to `hub` and is intentionally deferred here.
- **Deferred to v2 (not in this plan):** a "Sweep dust" affordance in the
  prediction-market UI (a screen under `web/components/screens/`) that calls
  `sweepDustTx`/`sweepRangeDustTx` via the standard run/send helper
  (`useSponsorAndExecute` when `ENOKI_ENABLED` else `useSignAndExecute`,
  surfacing the digest with `<TxLink>` and errors via `humanizeError`). Left out
  because v1 dust recovery is an opportunistic maintenance call, not a
  user-facing flow.
- If a future upgrade changes how stakes are stored (e.g. consolidating the
  `RangeMarket` per-bucket tables), the `range_is_fully_claimed` iteration must
  be revisited so the gate stays exhaustive.
