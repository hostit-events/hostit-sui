# Plan 014: Map predict abort codes 7 and 8 in humanizeError so range-market errors read in plain English

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. If `plans/README.md` does not exist, do NOT create it;
> just note that in your final report.
>
> **Drift check (run first)**: from the repo root
> `/Users/dadadave/Dev/HostIT/sui-ticket`, run:
> `git diff --stat 957206b..HEAD -- web/lib/moveErrors.ts web/lib/__tests__/moveErrors.test.ts sources/predict.move`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: —

## Why this matters

The `predict` Move module defines eight abort codes, but the frontend's
error-humanizer (`web/lib/moveErrors.ts`) only maps codes 1–6. Two real,
UI-reachable failures — `E_BAD_CUTOFFS` (7) when creating a range market and
`E_BAD_BUCKET` (8) when betting on a bucket — fall through to the generic
fallback and surface as `"Transaction rejected on-chain (predict code 7)."`,
which tells a user nothing actionable. Adding the two missing messages closes
the mapping to match the contract so every directly-signed predict abort reads
in plain English.

**Scope-of-effect caveat (read this — it bounds what "fixed" means here):** this
fix only takes effect on the **direct-signing** path (`useSignAndExecute`),
where the SDK surfaces a real `MoveAbort(...)` string that `humanizeError`
parses. On the **default gasless / Enoki-sponsored** path (`ENOKI_ENABLED`,
which is the production default), an on-chain abort during Enoki's dry-run does
*not* arrive as a `MoveAbort` string — it matches the `/enoki|dry_run_failed/`
branch (`moveErrors.ts:92-93`) and collapses to
`"Couldn't sponsor this transaction — please retry."`, bypassing the MAP
entirely. So codes 7/8 (and indeed all the predict codes) only render their
friendly text once that separate sponsored-path humanizer gap is also fixed.
That gap is a **deliberately deferred, out-of-scope follow-up** (see Maintenance
notes); do NOT attempt it in this plan. This plan is still worth doing on its
own: it makes the mapping correct and complete, it is what the deferred
sponsored-path fix will build on, and it covers the direct-signing path today.

## Current state

Files involved:

- `web/lib/moveErrors.ts` — the `MoveAbort` → human-text mapping. The `predict`
  sub-map (lines 59–66) defines codes 1–6 only; `humanizeError` (lines 77–95)
  parses the module name + code out of the abort string, looks them up in the
  `MAP`, and falls back to a generic string when the code is missing.
- `sources/predict.move` — defines `E_BAD_CUTOFFS = 7` and `E_BAD_BUCKET = 8`
  (lines 46–48) and asserts them in two public entry functions.
- `web/lib/__tests__/moveErrors.test.ts` — the existing vitest pattern for this
  module (pure string transforms, no wallet/network).

### `web/lib/moveErrors.ts:59-66` — the `predict` map today (codes 7/8 absent)

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

### `web/lib/moveErrors.ts:77-94` — the parser + generic fallback an unmapped code hits

```ts
export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const modM = raw.match(/Identifier\(\\?"(\w+)\\?"\)/);
  const codeM = raw.match(/\}\s*,\s*(\d+)\)/);
  if (modM && codeM) {
    const msg = MAP[modM[1]]?.[Number(codeM[1])];
    if (msg) return msg;
    return `Transaction rejected on-chain (${modM[1]} code ${codeM[1]}).`;
  }
  // ...
  if (/\/api\/sponsor|dry_run_failed|enoki/i.test(raw))
    return "Couldn’t sponsor this transaction — please retry.";
  return raw.length > 220 ? raw.slice(0, 220) + "…" : raw;
}
```

So a `predict` code 7 abort returns `"Transaction rejected on-chain (predict code 7)."` today.

### `sources/predict.move:45-48` — the two codes this plan maps

```move
/// `cutoffs` empty or not strictly increasing.
const E_BAD_CUTOFFS: u64 = 7;
/// `bucket` index out of range (`>= len(pools)`).
const E_BAD_BUCKET: u64 = 8;
```

### `sources/predict.move:458-465` — `create_range_market` asserts code 7 (UI-reachable)

```move
    let n = vector::length(&cutoffs);
    assert!(n > 0, E_BAD_CUTOFFS);
    // Strictly increasing.
    let mut i = 1;
    while (i < n) {
        assert!(*vector::borrow(&cutoffs, i - 1) < *vector::borrow(&cutoffs, i), E_BAD_CUTOFFS);
        i = i + 1;
    };
```

### `sources/predict.move:523-526` — `bet_bucket` asserts code 8 (UI-reachable)

```move
    assert!(!market.settled, E_ALREADY_SETTLED);
    let now = clock::timestamp_ms(clock);
    assert!(now < market.expiry_ms, E_STILL_OPEN);
    assert!(bucket < vector::length(&market.pools), E_BAD_BUCKET);
```

### UI-reachability proof (why these two codes can actually surface)

Both Move functions are called from the frontend via tx constructors that route
through `humanizeError` on failure:

- `web/lib/predict.ts:252` `export function createRangeMarketTx(...)` →
  `target: targetLatest("predict", "create_range_market")` — invoked by the
  "create range market" CTA at `web/components/screens/EventMarketsScreen.tsx:682`
  (`onClick={() => run(createRangeMarketTx(...))}`).
- `web/lib/predict.ts:287` `export function betBucketTx(...)` → calls
  `predict::bet_bucket` — invoked from the bucket picker in the same screen.
- The screen's `run(tx)` helper (defined at `EventMarketsScreen.tsx:627`, with a
  sibling at `:244`) ends in `catch (e: unknown) { toast.error(humanizeError(e)); }`
  (`EventMarketsScreen.tsx:642`, `:259`).

### Test pattern to mirror — `web/lib/__tests__/moveErrors.test.ts:1-29`

```ts
import { describe, expect, it } from "vitest";
import { humanizeError } from "../moveErrors";

describe("humanizeError", () => {
  it("maps a known MoveAbort module+code to its human message", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("market") }, function: 0, instruction: 10 }, 4) in command 0';
    expect(humanizeError(new Error(raw))).toBe("Sold out.");
  });
  // ...
  it("falls back to a generic on-chain message for an unmapped code in a known module", () => {
    const raw =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0xabc, name: Identifier("market") }, function: 0, instruction: 1 }, 99) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "Transaction rejected on-chain (market code 99).",
    );
  });
});
```

The abort-string shape the tests use is exactly what the SDK surfaces:
`MoveAbort(MoveLocation { module: ModuleId { address: 0x..., name: Identifier("<module>") }, function: <n>, instruction: <n> }, <code>) in command 0`.

### Repo conventions that apply here

- Per `CLAUDE.md`: **bun only** — never npm/pnpm. Run frontend commands from
  `web/`. `bunx tsc --noEmit` is the **primary** verification gate.
- Per `CLAUDE.md`: when adding Move error codes to the contract, the mapping in
  `humanizeError` (`web/lib/moveErrors.ts`) must be kept in sync. This plan does
  the sync direction (codes already exist in Move; map them in TS).
- Message-copy style: the existing predict messages are short, sentence-case,
  one sentence, and explain the *cause* in user terms (e.g. "This market is
  already settled."). Match that register. Use a curly apostrophe (`'`) only if
  the surrounding entries do — note the existing predict entries use a **straight**
  apostrophe (`can't`, `hasn't`), so use a straight apostrophe in your new copy
  for consistency with that sub-map.

## Commands you will need

| Purpose            | Command (run from)                                  | Expected on success            |
|--------------------|-----------------------------------------------------|--------------------------------|
| Install deps       | `bun install` (in `web/`)                           | exit 0                         |
| Typecheck (gate)   | `bunx tsc --noEmit` (in `web/`)                     | exit 0, no errors printed      |
| Run this test file | `bun run test moveErrors` (in `web/`)               | all tests pass, incl. 2 new    |
| Lint               | `bun run lint` (in `web/`)                          | exit 0                         |

(`bun run test` is vitest; passing `moveErrors` filters to the matching file.
All four commands are run from `/Users/dadadave/Dev/HostIT/sui-ticket/web`.)

## Scope

**In scope** (the only files you should modify):
- `web/lib/moveErrors.ts` — add the two map entries.
- `web/lib/__tests__/moveErrors.test.ts` — add two assertions.

**Out of scope** (do NOT touch, even though they look related):
- `sources/predict.move` — the codes already exist; no Move change is needed.
  Do not edit Move; do not run a deploy/upgrade.
- The Enoki sponsored-path branch in `humanizeError` (`moveErrors.ts:92-93`,
  the `/enoki|dry_run_failed/` regex) — fixing it so dry-run aborts reach the
  MAP is the deferred follow-up; **leave it as-is**. Do not change the parser,
  the other module sub-maps, or any unrelated copy.
- `web/lib/config.ts`, `web/lib/predict.ts`, any screen/component — no on-chain
  IDs, targets, or UI wiring change for this plan.

## Git workflow

- Branch: `advisor/014-humanize-predict-codes` (create from `main`).
- One commit is fine for this change. Conventional-commit message style (matches
  `git log`, e.g. `feat(forum): organizer admin ...`). Suggested message:
  `fix(predict): map abort codes 7/8 (bad cutoffs, bad bucket) in humanizeError`.
- Do NOT push or open a PR. The operator handles that.

## Steps

### Step 1: Add predict codes 7 and 8 to the MAP

In `web/lib/moveErrors.ts`, extend the `predict` sub-map (currently
`web/lib/moveErrors.ts:59-66`) by adding entries `7` and `8` after the existing
`6`. Use this exact copy (sentence-case, straight apostrophe, matching the
sub-map's register):

```ts
  predict: {
    1: "This market is already settled.",
    2: "Betting is still open — you can't settle until the deadline (doors) passes.",
    3: "This market is still open — betting hasn't closed yet.",
    4: "This event doesn't match the market's event.",
    5: "This market isn't settled yet — nothing to claim.",
    6: "You have no winning stake to claim here.",
    7: "Bucket cutoffs must be non-empty and strictly increasing.",
    8: "That bucket doesn't exist for this market.",
  },
```

Do not change keys 1–6 or any other sub-map.

**Verify**: from `web/`, `bunx tsc --noEmit` → exit 0, no errors. Then
`grep -n '7: "Bucket cutoffs' lib/moveErrors.ts` → prints one line; and
`grep -n "8: \"That bucket doesn't exist" lib/moveErrors.ts` → prints one line.

### Step 2: Add two vitest assertions pinning codes 7 and 8

In `web/lib/__tests__/moveErrors.test.ts`, add two `it(...)` cases inside the
existing `describe("humanizeError", ...)` block, modeled on the
`"maps a known MoveAbort module+code"` test (the abort-string shape must match
that file exactly — `name: Identifier("predict")` and the trailing
`}, <code>) in command 0`). Add:

```ts
  it("maps predict code 7 (bad cutoffs) to its human message", () => {
    const raw =
      'MoveAbort(MoveLocation { address: 0xabc, name: Identifier("predict") }, function: 5, instruction: 1 }, 7) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "Bucket cutoffs must be non-empty and strictly increasing.",
    );
  });

  it("maps predict code 8 (bad bucket) to its human message", () => {
    const raw =
      'MoveAbort(MoveLocation { address: 0xabc, name: Identifier("predict") }, function: 6, instruction: 3 }, 8) in command 0';
    expect(humanizeError(new Error(raw))).toBe(
      "That bucket doesn't exist for this market.",
    );
  });
```

Note: the `function`/`instruction` numbers in the raw string are arbitrary — the
parser keys only off the module name and the trailing code, so any integers are
fine. Keep the structure identical to the existing passing tests so the two
regexes in `humanizeError` (`/Identifier\(\\?"(\w+)\\?"\)/` and
`/\}\s*,\s*(\d+)\)/`) both match.

**Verify**: from `web/`, `bun run test moveErrors` → all tests in
`moveErrors.test.ts` pass, including the 2 new ones (test count goes from 7 to 9).

### Step 3: Full gate + lint

**Verify**: from `web/`:
- `bunx tsc --noEmit` → exit 0, no errors.
- `bun run lint` → exit 0 (no new warnings/errors introduced by these files).
- `git status --porcelain` → shows only `web/lib/moveErrors.ts` and
  `web/lib/__tests__/moveErrors.test.ts` modified (plus this plan file). No other
  paths.

## Test plan

- **File**: `web/lib/__tests__/moveErrors.test.ts` (extend; do not create new).
- **New cases** (2):
  1. predict code 7 → `"Bucket cutoffs must be non-empty and strictly increasing."`
  2. predict code 8 → `"That bucket doesn't exist for this market."`
- **Structural pattern**: model the new cases on the existing
  `"maps a known MoveAbort module+code to its human message"` test
  (`moveErrors.test.ts:7-13`) — same raw-string shape, swap module to `predict`
  and the code to 7 / 8.
- **Regression guard**: the existing
  `"falls back to a generic on-chain message for an unmapped code"` test still
  passes (it uses `market` code 99, not predict 7/8, so it is unaffected). Do not
  weaken it.
- **Verification**: from `web/`, `bun run test moveErrors` → all pass; 2 new
  tests present and green.

## Done criteria

Machine-checkable. ALL must hold (commands run from `/Users/dadadave/Dev/HostIT/sui-ticket/web` unless noted):

- [ ] `grep -n '7: "Bucket cutoffs must be non-empty and strictly increasing."' lib/moveErrors.ts` → exactly one match
- [ ] `grep -n "8: \"That bucket doesn't exist for this market.\"" lib/moveErrors.ts` → exactly one match
- [ ] `bunx tsc --noEmit` → exits 0, no errors
- [ ] `bun run test moveErrors` → exits 0; `moveErrors.test.ts` reports 9 passing tests (7 original + 2 new)
- [ ] `bun run lint` → exits 0
- [ ] From repo root: `git status --porcelain` shows only `web/lib/moveErrors.ts`, `web/lib/__tests__/moveErrors.test.ts` (and `plans/014-humanize-predict-codes.md`) changed — nothing else
- [ ] `plans/README.md` status row for plan 014 updated to DONE (only if that file exists; if it does not, report that instead)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `web/lib/moveErrors.ts` or `sources/predict.move`
  changed since `957206b` AND the "Current state" excerpts no longer match the
  live code — in particular: if the `predict` sub-map already contains keys 7/8
  (someone fixed it), or if `E_BAD_CUTOFFS`/`E_BAD_BUCKET` are no longer 7/8 in
  `predict.move`. Report the actual values; do not guess a remapping.
- `bunx tsc --noEmit` or `bun run lint` fails after your edit and the failure is
  not an obvious syntax slip in the two lines you added (it should be a no-op for
  types/lint — these are plain string literals in an existing record).
- A new test does not produce the expected string after a reasonable fix attempt
  — most likely cause is a malformed raw abort string whose module/code regexes
  don't both match; compare character-for-character against the existing passing
  test before changing anything else.
- The fix appears to require editing any file outside the in-scope list
  (e.g. you feel tempted to touch the Enoki branch or `predict.move`) — that
  means scope has shifted; stop and report.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Reviewer focus**: confirm the two new strings exactly match the contract's
  semantics — code 7 = empty or non-strictly-increasing `cutoffs` in
  `create_range_market`; code 8 = bucket index `>= len(pools)` in `bet_bucket`
  (`sources/predict.move:46-48`). Confirm copy register matches the rest of the
  `predict` sub-map (short, sentence-case, straight apostrophe).
- **Deferred, explicitly out of scope — the bigger win this unlocks**: on the
  default gasless path (`ENOKI_ENABLED`, production default), on-chain aborts
  surface as Enoki dry-run failures and hit the `/enoki|dry_run_failed/` branch
  (`web/lib/moveErrors.ts:92-93`), collapsing to "please retry" *before* the MAP
  is consulted — so users on the sponsored path will NOT see these (or any)
  predict messages until that path is taught to extract the underlying
  `MoveAbort` module+code from Enoki's error payload and route it through the
  same MAP. That is a separate follow-up (own plan); it depends on this mapping
  being correct, which is what this plan delivers. Do not bundle it here.
- **Keeping the MAP in sync going forward**: any future `predict` (or other
  module) abort code added to `sources/*.move` must get a matching `MAP` entry
  here and ideally a pinning test — this is the same sync obligation called out
  in `CLAUDE.md`. The `MoveAbort` parser keys on module name + trailing code, so
  the only data needed per code is `<module>`, `<code number>`, and the message.
