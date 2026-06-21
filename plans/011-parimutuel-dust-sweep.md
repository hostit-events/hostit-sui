# Plan 011: Recover parimutuel rounding dust by folding it into the final winner's claim

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 8ddafd7..HEAD -- sources/predict.move tests/predict_tests.move tests/predict_range_tests.move`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (fund-touching Move logic — but adversarially verified; see "Why")
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8ddafd7`, 2026-06-21
- **Issue**: —

> **This plan REPLACES the earlier (deferred) 011 design.** The first attempt
> added a permissionless `sweep_dust` gated on a "fully-claimed" predicate. That
> approach was **unsafe and infeasible**, three ways:
> 1. `settled && yes_stakes.empty && no_stakes.empty` is **never true when there
>    are losers** — losers never claim, so the losing-side stake table stays
>    non-empty forever; the sweep could never fire on a market that actually has
>    dust.
> 2. The "obvious" fix (gate on the *winning* table being empty) **drains the pot
>    early in a no-winner market**: when nobody bet the resolved winning side, the
>    winning table is empty *from settlement*, so a sweep would fire before losers
>    are refunded — theft.
> 3. The safe-predicate fix (`had_winners` flag) needs a **new struct field**, but
>    **Sui cannot add fields to an existing struct during a package upgrade** — so
>    it can't ship without breaking existing on-chain markets.
>
> This plan needs **none of that**: it recovers the dust inside the existing
> `claim`/`claim_range` winner branch, with no struct change and no new function.

## Why this matters

Parimutuel payouts floor the loser-pool share: each winner draws
`floor(stake * losing_total / winning_total)` from the losing pool
(`predict.move:255-259, 264-267` for sellout; `:616-662` for range). The sum of
floored shares is `<= losing_total`, so after every winner has claimed, a few
sub-unit tokens are stranded in the losing pool(s). Both `SelloutMarket` and
`RangeMarket` are `key`-only shared objects with no delete/drain path, so that
residue is **permanently locked**. Per market it is economically negligible, but
it is a true unrecoverable-funds invariant break that accumulates across markets.

**The fix, in one sentence:** when the *final* winner claims (the one whose claim
empties the winning-side stake table), give them the **entire remaining losing
pool** instead of just their floored share — so the pools reach exactly 0 and no
dust is ever locked.

**Why this is safe (adversarially verified against the real code, 3 reviewers):**
- `total_yes`/`total_no` (sellout) and `totals[]` (range) are **immutable
  snapshots** — they are only ever *incremented* in `place_bet`/`bet_bucket` and
  never decremented (the comment at `predict.move:74-77` / `:419-420` documents it;
  claim drains the *pools* via `balance::split`, not the totals). So
  `winning_total = (outcome_yes ? total_yes : total_no)` (sellout) /
  `totals[winning_bucket]` (range) is a **per-market constant** for the life of the
  settled market.
- The winner branch is **structurally gated on `winning_total > 0`**: sellout
  hard-`return`s in the no-winner branch (`:232-244`) before the winner code; range
  guards the whole winner block with `if (winning_total > 0) { … } else { refund }`.
  So the dust-fold can **never** run for a no-winner market, and the no-winner
  refund branches (which distribute the whole pot exactly — no flooring, no dust)
  are left untouched.
- Zero bets are rejected (`E_ZERO_BET`, `:297`/`:532`), so a stake table never
  holds a phantom 0 entry → "winning table empty" means exactly "every winner has
  claimed."
- Conservation holds: sum of own-stake draws from the winning pool == `winning_total`
  (→ winning pool 0); sum of non-last floored draws + the last winner's residual
  drain == `losing_total` exactly (→ losing pools 0). The last winner uses a
  drain-remaining (`balance::withdraw_all` / split-the-live-value), which **cannot
  overdraw or abort**.
- **Graceful degradation:** if a winner never claims, the winning table never
  empties, the fold never fires, and funds stay locked **exactly as today** —
  strictly no worse than the status quo.

## Current state

All excerpts are live at commit `8ddafd7` (working tree clean).

### The immutable-snapshot fact this relies on (`sources/predict.move:74-84`)

```move
    /// Running totals = the corresponding pool value (cached for cheap reads /
    /// pro-rata math after pools start draining on claim).
    total_yes: u64,
    total_no: u64,
    /// `bettor -> summed YES stake`. Removed on claim to block double-claim.
    yes_stakes: Table<address, u64>,
    /// `bettor -> summed NO stake`. Removed on claim to block double-claim.
    no_stakes: Table<address, u64>,
    settled: bool,
    outcome_yes: bool,
```
`total_yes`/`total_no` are written only by `+ amt` in `place_bet` (`:302,:306`);
never decremented. (Range `totals[]` likewise: written only at `:536-537`.)

### Sellout `claim` — the WINNER branch to modify (`sources/predict.move:246-270`)

The no-winner branch above it (`:232-244`) ends in `return coin::from_balance(refund, ctx)`,
so the code below runs **only when `winning_total > 0`**:

```move
    // Remove the caller's stake from the WINNING side's table (zero-out first to
    // prevent double-claim). Reading the losing table here is intentionally
    // impossible — losers simply have no entry on the winning side.
    let stake = remove_winning_stake(market, caller);
    assert!(stake > 0, E_NO_STAKE);

    // Pro-rata share of the losing pool. ...
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

### Range `claim_range` — the WINNER branch to modify (`sources/predict.move:609-664`)

This is the `if (winning_total > 0)` arm (the `else` at `:665-682` is the no-winner
refund — leave it untouched):

```move
    if (winning_total > 0) {
        // --- Normal parimutuel payout from the winning bucket. ---
        let stake = remove_bucket_stake(market, wb, caller);
        assert!(stake > 0, E_NO_STAKE);

        // losing_total = sum(totals) - totals[wb].
        let losing_total = sum_totals(market) - winning_total;
        let loser_share = if (losing_total > 0) { ... } else { 0 };

        // Take own stake from the winning pool.
        let mut payout_bal = balance::split(
            vector::borrow_mut(&mut market.pools, wb),
            stake,
        );

        // Draw `loser_share` pro-rata across the losing pools ...
        if (loser_share > 0) {
            let mut remaining = loser_share;
            let buckets = vector::length(&market.pools);
            let mut b = 0;
            while (b < buckets && remaining > 0) {   // <-- NOTE: early-exits on `remaining`
                ...
            };
        };

        coin::from_balance(payout_bal, ctx)
    } else {
        // --- No winners: refund ... ---  (UNTOUCHED)
    }
```
**Critical:** that loop's `&& remaining > 0` means a non-last winner can leave a
losing bucket **completely undrawn** (full original balance, not just dust). The
last winner therefore must sweep **every** `b != wb` bucket fully, not reuse this
loop.

### Conventions

- Move package at the repo root. Error consts are `E_FOO` at the top of the
  module. Tests live in `tests/predict_tests.move` (sellout) and
  `tests/predict_range_tests.move` (range); mirror their existing structure
  (e.g. `yes_wins_prorata`, `multi_bucket_prorata`, `one_sided_winner_reclaims_stake`).
- `sui::balance::withdraw_all(&mut bal)` returns the full balance and **cannot
  abort** (it splits `self.value`, yielding a zero balance if empty).
  `sui::table::is_empty(&tbl)` returns true iff length 0. The module already calls
  `balance::` and `table::` qualified (no new `use` needed; if the build reports an
  unbound function, add the `use` alias the module already imports from).

## Commands you will need

| Purpose   | Command (from repo root)        | Expected on success |
|-----------|---------------------------------|---------------------|
| Build     | `sui move build`                | `BUILDING hostit_ticket`, no errors |
| Test all  | `sui move test`                 | `Test result: OK. Total tests: <N>; passed: <N>; failed: 0` |
| Test subset | `sui move test predict`       | the predict tests pass |

## Scope

**In scope** (the only files you may modify):
- `sources/predict.move` — the two winner branches only.
- `tests/predict_tests.move` — add sellout dust tests.
- `tests/predict_range_tests.move` — add range dust tests.
- `plans/README.md` — your status row.

**Out of scope** (do NOT touch):
- The `SelloutMarket` / `RangeMarket` **struct definitions** — **no new field**.
  The whole point of this design is that none is needed.
- The **no-winner refund branches** (`predict.move:232-244` sellout, `:665-682`
  range) — must remain byte-for-byte unchanged.
- `bet_*`, `settle*`, `create_*`, the read functions, and the internal helpers
  (`remove_winning_stake`, `remove_bucket_stake`, `winning_losing_pools_mut`,
  `sum_totals`, `remove_stake_for`, `upsert_stake`) — do not change their bodies.
- `web/` entirely — there is **no new entry function**, so no PTB constructor,
  `SPONSORED_TARGETS` entry, or `moveErrors` mapping is needed.

## Git workflow

- You are already on branch `advisor/implement-plans`. Commit per the repo's
  conventional-commit style; do NOT push or open a PR.

## Steps

### Step 1: Sellout `claim` — fold dust into the final winner

In the winner branch (`predict.move:246-270`), after `assert!(stake > 0, E_NO_STAKE);`,
determine whether this caller is the final winner **by reading the winning-side
table AFTER the stake removal**, then change only the losing-pool payout.

Target shape:
```move
    let stake = remove_winning_stake(market, caller);
    assert!(stake > 0, E_NO_STAKE);

    // The final winner (whose claim just emptied the winning-side table) absorbs
    // the entire remaining losing pool — their pro-rata share plus the sub-unit
    // rounding dust left by earlier winners' floored draws — so the pool reaches
    // exactly 0 and nothing locks. Safe: this branch runs only when
    // winning_total > 0, and zero bets are rejected, so an empty winning table
    // means every winner has already claimed.
    let is_last_winner = if (market.outcome_yes) {
        table::is_empty(&market.yes_stakes)
    } else {
        table::is_empty(&market.no_stakes)
    };

    let loser_share = if (losing_total > 0) {
        (((stake as u128) * (losing_total as u128)) / (winning_total as u128)) as u64
    } else { 0 };

    let (winning_pool_mut, losing_pool_mut) = winning_losing_pools_mut(market);
    let mut payout_bal = balance::split(winning_pool_mut, stake);
    if (is_last_winner) {
        // Drain whatever remains (own share + accumulated dust; 0 if one-sided).
        balance::join(&mut payout_bal, balance::withdraw_all(losing_pool_mut));
    } else if (loser_share > 0) {
        balance::join(&mut payout_bal, balance::split(losing_pool_mut, loser_share));
    };

    coin::from_balance(payout_bal, ctx)
```

MUSTs (from the adversarial review):
- Compute `is_last_winner` **after** `remove_winning_stake` and **after** the
  `assert!(stake > 0)` (so a non-winner still aborts `E_NO_STAKE` before any drain).
- Read the **winning-side** table only (`yes_stakes` if `outcome_yes`, else
  `no_stakes`) — never the losing-side table.
- `is_last_winner` must be a local `bool` computed **before** `winning_losing_pools_mut`
  takes its mutable borrow (Move borrow checker: don't hold an immutable borrow of
  `market` across the mutable one).
- Apply `withdraw_all` to the **losing** pool only; the winning pool is still
  zeroed by the exact `balance::split(winning_pool_mut, stake)`.

**Verify**: `sui move build` → `BUILDING hostit_ticket`, no errors.

### Step 2: Range `claim_range` — final winner drains every non-winning bucket

In the `if (winning_total > 0)` arm (`:609-664`), after taking own stake from
`pools[wb]`, branch on whether this is the final winning-bucket claimant:

Target shape:
```move
        let stake = remove_bucket_stake(market, wb, caller);
        assert!(stake > 0, E_NO_STAKE);
        let losing_total = sum_totals(market) - winning_total;

        // Final winning-bucket claimant absorbs all remaining losing-bucket funds.
        let is_last_winner = table::is_empty(vector::borrow(&market.stakes, wb));

        let mut payout_bal = balance::split(
            vector::borrow_mut(&mut market.pools, wb),
            stake,
        );

        if (is_last_winner) {
            // Drain EVERY non-winning bucket fully — NOT the floored loop, which
            // can leave a bucket entirely undrawn. Recovers all dust AND any
            // bucket the pro-rata loop never reached.
            let buckets = vector::length(&market.pools);
            let mut b = 0;
            while (b < buckets) {
                if (b != wb) {
                    balance::join(
                        &mut payout_bal,
                        balance::withdraw_all(vector::borrow_mut(&mut market.pools, b)),
                    );
                };
                b = b + 1;
            };
        } else {
            let loser_share = if (losing_total > 0) {
                (((stake as u128) * (losing_total as u128)) / (winning_total as u128)) as u64
            } else { 0 };
            if (loser_share > 0) {
                // ... the EXISTING floored pro-rata loop, verbatim ...
            };
        };

        coin::from_balance(payout_bal, ctx)
```
Keep the existing floored pro-rata loop verbatim inside the `else`. Do not change
the no-winner `else` arm of the outer `if`.

**Verify**: `sui move build` → no errors.

### Step 3: Tests — assert pools reach exactly 0

Add to `tests/predict_tests.move` (mirror `yes_wins_prorata`):
- `dust_folds_to_last_winner`: YES wins with **uneven** winners that force flooring,
  e.g. `total_yes = 1 + 1 + 1`, `total_no = 10`. First two winners get
  `floor(1*10/3) = 3` each; the third (last) gets `1 + withdraw_all(no_pool)` = `1 + 4`.
  Assert each payout amount; and **`yes_pool_value == 0` AND `no_pool_value == 0`**
  after all three claim; total paid == 13.
- `one_sided_winner_no_dust_abort`: YES wins, `total_no = 0`; the sole/last winner's
  `withdraw_all` of the empty losing pool yields 0 and does not abort; payout == own stake.

Add to `tests/predict_range_tests.move` (mirror `multi_bucket_prorata`):
- `range_dust_folds_to_last_winner`: a 3-bucket market, winning bucket with two
  uneven winners and **two** losing buckets (so the pro-rata loop's early-exit can
  skip one). Assert all bucket pools (`range_pool_value` for every bucket) == 0
  after all winners claim, and total paid == the pot.

Confirm the existing no-winner / refund tests (`winning_side_empty_refunds`,
`no_winner_refund`, `double_claim_aborts`, `loser_claim_aborts`,
`one_sided_winner_reclaims_stake`) still pass unchanged.

**Verify**: `sui move test` → `Test result: OK … failed: 0` (count = previous + new).

## Test plan

- New tests above, in the two predict test files, following the existing
  `test_scenario` setup helpers in each file.
- The load-bearing new assertion is **pool value == 0 after all winners claim**
  (today it would be a small non-zero dust). Also assert the last winner's payout
  exceeds their pure floored share by exactly the recovered dust.
- Verification: `sui move test predict` → all predict tests pass including the new ones.

## Done criteria

ALL must hold:
- [ ] `sui move build` exits 0 (`BUILDING hostit_ticket`).
- [ ] `sui move test` → `failed: 0`; the 3 new tests exist and pass.
- [ ] Changes are **only** inside the two winner branches — the struct definitions
      and the two no-winner branches are unchanged.
      `grep -n "had_winners\|fun sweep\|total_yes:" sources/predict.move` shows no
      new struct field and no `sweep`/`had_winners` symbol (only the existing
      `total_yes:` field line).
- [ ] No files under `web/` changed (`git status --porcelain web/` empty).
- [ ] `plans/README.md` row 011 updated.

## STOP conditions

Stop and report (do not improvise) if:
- Implementing the fold appears to require a **new struct field** or touching a
  **no-winner branch** — it does not; if you reach for either, the approach has
  drifted.
- `is_last_winner` would have to be read **before** `remove_winning_stake` /
  `remove_bucket_stake`, or from a **losing-side** table — STOP (both are wrong;
  see MUSTs).
- The Move borrow checker rejects holding the `is_last_winner` read across
  `winning_losing_pools_mut` — restructure so `is_last_winner` is a `bool`
  computed first; if that still fails, STOP and report the exact error.
- Any **existing** predict test starts failing — STOP (the no-winner / refund
  paths must be untouched).
- The "Current state" excerpts don't match the live code (drift) — STOP.

## Maintenance notes

- **Order-dependent dust capture (accepted, not a bug):** the final claimant
  receives the accumulated rounding dust, so the marginal payout depends on claim
  order. It is at most ~`(num_winners − 1)` sub-units (sellout) / small per losing
  bucket (range), is **not** taken from any other winner (each non-last winner
  already got their full floored share), and conservation is preserved. A winner
  could race to claim last for this — economically negligible. Note it in review
  so the order-dependence isn't re-flagged as a finding.
- **Graceful degradation:** if any winner never claims, the winning table never
  empties, the fold never fires, and funds stay locked **exactly as today**. For
  range, because the last winner is the one that sweeps untouched buckets, an
  unclaimed last winner can leave **large** (non-dust) funds locked — identical to
  the current behavior, strictly no worse.
- **Deployment is a gated package upgrade** (`sui client upgrade`) — out of scope
  here and requires explicit per-deploy authorization (CLAUDE.md). Because there
  is **no struct-layout change**, the upgrade is clean and applies to markets
  created *before* the upgrade too (their next `claim` runs the new bytecode).
- **Considered and rejected:** an explicit permissionless `sweep_dust` entry
  function. Rejected because `predict` has no Hub/treasury, so swept dust would
  have no clean recipient (paying the arbitrary sweeper invites griefing and needs
  a new entry fn + `SPONSORED_TARGETS` + PTB + `moveErrors` wiring). Folding into
  the final winner's existing claim recovers the same dust automatically with zero
  new surface.
