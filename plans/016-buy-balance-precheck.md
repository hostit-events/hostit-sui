# Plan 016: Pre-check the buyer's coin balance on the event Buy panel and show a faucet hint instead of letting a zero-balance tap fail

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (create it if missing — see "Maintenance notes" for the
> table shape) — unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**: from the repo root
> `git diff --stat 957206b..HEAD -- web/components/screens/EventPageScreen.tsx web/components/screens/EventMarketsScreen.tsx web/lib/config.ts web/lib/hooks.ts`
> If either screen file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (UX)
- **Planned at**: commit `957206b`, 2026-06-20

> Note: the plan was authored against working-tree commit `957206b` (live `HEAD`
> at authoring time). If your `git rev-parse HEAD` reports a different SHA, that
> is fine **as long as the drift check above reports no changes** to the
> in-scope files; if it does report changes, follow the STOP condition.

## Why this matters

A fresh zkLogin user lands on an event with a priced ticket, holds 0 of the
required coin (e.g. 0 USDC), and the **Buy** button is fully enabled. They tap
it, approve, wait for the round-trip, and only then get a red error toast
("You don't have enough of that coin — get testnet USDC from a faucet") — the
insufficient-coin case is humanized **only after the transaction fails**
(`web/lib/moveErrors.ts:90-91`). That is a dead end with no forward action.

The prediction-markets section on the **same page** already does this right:
it queries the wallet's coin balance up front, disables the bet buttons when
the balance is zero, and renders an inline faucet hint (`NoUsdcHint`). This
plan brings the identical, proven pattern to the ticket Buy panel: query the
buyer's balance for the selected priced coin, and when it cannot cover the
purchase, disable Buy and show an inline hint with a faucet link. No on-chain
change, no new dependency — just a pre-flight read and a disabled state that
matches an existing one.

## Current state

Files involved:

- `web/components/screens/EventPageScreen.tsx` — the event detail page; renders
  the sticky **Tickets** panel with the Buy/Claim buttons. **This is the file
  you change.**
- `web/components/screens/EventMarketsScreen.tsx` — the prediction-markets
  section (rendered *inside* EventPageScreen). **Reference only** — it already
  implements the balance-query + faucet-hint pattern you will mirror. You will
  read it; you do **not** edit it (see Scope).
- `web/lib/config.ts` — coin metadata + formatting helpers (read-only).
- `web/lib/hooks.ts` — `useSuiQuery` wrapper (read-only).
- `web/lib/moveErrors.ts` — post-failure humanization (read-only; the toast you
  are pre-empting).

### The Buy button has no balance pre-check (the bug)

`web/components/screens/EventPageScreen.tsx:163` — `canAct` is the only gate,
and it knows nothing about the wallet's balance:

```ts
const canAct = Boolean(addr) && !soldOut && windowOpen;
```

`web/components/screens/EventPageScreen.tsx:415-451` — each priced Buy button is
disabled only on `!canAct || isPending`. The total shown already includes the
3% fee via `totalWithFee(BigInt(p.price))`, but nothing checks the wallet holds
that much:

```tsx
{prices.map((p) => {
  const ci = coinInfo(p.coinType);
  const total = totalWithFee(BigInt(p.price));
  const buying = isPending && pendingCoin === p.coinType;
  return (
    <Tooltip key={p.coinType}>
      <TooltipTrigger asChild>
        <Button
          className="w-full"
          disabled={!canAct || isPending}
          onClick={() =>
            run(
              buyTx({
                eventId: id,
                coinType: p.coinType,
                priceUnits: BigInt(p.price),
                recipient: addr!,
                sponsored: ENOKI_ENABLED,
              }),
              p.coinType,
            )
          }
        >
          <Icon icon="ion:ticket" size={16} />
          {buying
            ? "Buying…"
            : canAct
              ? `Buy · ${fmtAmount(total, ci.decimals)} ${ci.symbol}`
              : statusLabel()}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Total incl. 3% fee: {fmtAmount(total, ci.decimals)} {ci.symbol}
      </TooltipContent>
    </Tooltip>
  );
})}
```

`web/lib/moveErrors.ts:90-91` — the only place insufficiency is surfaced today,
and it fires **after** the failed submit:

```ts
  if (/no valid coins|coinwithbalance|insufficient.*coin/i.test(raw))
    return "You don’t have enough of that coin — get testnet USDC from a faucet.";
```

`prices` is `PriceOption[]` where each entry is `{ coinType: string; price: string }`
(`web/lib/events.ts:26-28`). An event may list **more than one** priced coin
(the config registers both SUI and USDC — see below), so the pre-check must be
**per coin**, not a single global "USDC == 0" flag.

The relevant imports already present at the top of `EventPageScreen.tsx`
(`:1-31`) include `useSuiQuery`, `useCurrentAccount`, `coinInfo`, `fmtAmount`,
`totalWithFee`, `Button`, `Tooltip*`, `Badge`. You will **add** `CoinBalance`
and `GetBalanceParams` to the existing type-only import from
`@mysten/sui/jsonRpc` (`:31`):

```ts
import type { GetObjectParams, SuiObjectResponse } from "@mysten/sui/jsonRpc";
```

### The pattern to mirror (markets section — already shipped)

`web/components/screens/EventMarketsScreen.tsx:139-154` — the inline faucet hint
component (currently **module-private**, not exported, and **USDC-specific**):

```tsx
function NoUsdcHint() {
  return (
    <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
      You have 0 USDC.{" "}
      <a
        href="https://faucet.circle.com/"
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--hi-blue)", textDecoration: "underline" }}
      >
        Get testnet USDC
      </a>{" "}
      to place a bet.
    </div>
  );
}
```

`web/components/screens/EventMarketsScreen.tsx:213-221` — the balance query +
zero check, using the `useSuiQuery` `getBalance` overload:

```tsx
  // Connected wallet's USDC balance — gates the bet buttons (see NoUsdcHint).
  const balanceQ = useSuiQuery<"getBalance", GetBalanceParams, CoinBalance>(
    "getBalance",
    { owner: addr ?? "", coinType: USDC_COIN_TYPE },
    { enabled: Boolean(addr), staleTime: 15_000 },
  );
  const usdcZero = Boolean(addr) && balanceQ.data
    ? BigInt(balanceQ.data.totalBalance) <= 0n
    : false;
```

`web/components/screens/EventMarketsScreen.tsx:386-388, 433` — how it is wired
into a button + the hint render:

```tsx
              <Button
                className="flex-1"
                disabled={!addr || isPending || usdcZero || parseUsdcUnits(amount) === null}
...
            {usdcZero && <NoUsdcHint />}
```

`web/components/screens/EventMarketsScreen.tsx:59-68` — the type-only import that
already brings in `CoinBalance` and `GetBalanceParams` (copy the two you need
into EventPageScreen's equivalent import):

```ts
import type {
  CoinBalance,
  DynamicFieldName,
  GetBalanceParams,
  GetDynamicFieldObjectParams,
  GetObjectParams,
  PaginatedEvents,
  QueryEventsParams,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
```

### Supporting helpers (read-only, confirmed shapes)

- `web/lib/hooks.ts:104` — `export function useSuiQuery<TFn extends string, TArgs, TResult>(fn, args, options?)`.
  Use it exactly as the markets code does.
- `web/lib/config.ts:191-208` — coin metadata:
  ```ts
  export const USDC_COIN_TYPE = process.env.NEXT_PUBLIC_USDC_COIN_TYPE ?? ... ;
  // CoinInfo = { symbol: string; type: string; decimals: number }
  const COINS = [
    { symbol: "SUI", type: SUI_COIN_TYPE, decimals: 9 },
    { symbol: "USDC", type: USDC_COIN_TYPE, decimals: 6 },
  ];
  export function coinInfo(type: string): CoinInfo {
    return COINS.find((c) => c.type === type) ?? { symbol: "?", type, decimals: 9 };
  }
  ```
  So an event can be priced in **SUI or USDC** (or both). The faucet for USDC is
  `https://faucet.circle.com/` (as in `NoUsdcHint`); SUI testnet has no single
  canonical browser faucet wired in this repo, so for any non-USDC coin link to
  the Sui testnet faucet docs page `https://docs.sui.io/guides/developer/getting-started/get-coins`.
- `totalWithFee(BigInt(p.price))` (imported in EventPageScreen from `@/lib/ticketing`)
  is the amount the wallet must actually hold for that coin. Compare balance
  against **this**, not the bare `p.price`.

### Conventions this plan must honor

- **Permissionless model** — no role gate. This is purely a balance/affordance
  hint; do **not** add any issuer/buyer distinction. (CLAUDE.md, project memory.)
- **Reuse the existing submit flow** — do not touch the `run(tx, coinKey)`
  helper (`EventPageScreen.tsx:179-195`); you only gate the button's `disabled`
  and add a hint. The `humanizeError` toast stays as the safety net for races.
- **Styling** — match the existing hint style already used on this page:
  `className="text-[11px]"` with `style={{ color: "var(--fg3)" }}` and link
  color `var(--hi-blue)` (identical to `NoUsdcHint` and to the existing fee/
  connect-wallet hints at `EventPageScreen.tsx:452-467`). shadcn + Tailwind v4
  tokens; no new CSS.
- **bun only** — never `npm`/`pnpm`. Never run `bun run build` while a dev
  server is running (corrupts `.next/`); verify with `bunx tsc --noEmit`.

## Commands you will need

All frontend commands run **from `web/`**. (`cd web` once per shell, or prefix.)

| Purpose          | Command (from `web/`)                                      | Expected on success                |
|------------------|------------------------------------------------------------|------------------------------------|
| Install (if cold)| `bun install`                                              | exit 0                             |
| Typecheck (gate) | `bunx tsc --noEmit`                                         | exit 0, no output                  |
| Lint             | `bun run lint`                                             | exit 0, no errors                  |
| Unit tests       | `bun run test`                                             | all pass                           |
| Targeted test    | `bun run test EventPageScreen`                             | the new test file passes           |

(Exact commands from this repo's `web/package.json` and CLAUDE.md.)

## Scope

**In scope** (the only files you may modify):
- `web/components/screens/EventPageScreen.tsx` — add the balance pre-check + hint.
- `web/components/screens/__tests__/EventPageScreen.balance.test.ts` (create) —
  a tiny pure-logic unit test for the affordability check (see Test plan).
- `plans/README.md` — status row only (create if missing).

**Out of scope** (do NOT touch, even though they look related):
- `web/components/screens/EventMarketsScreen.tsx` — the reference implementation.
  Do **not** refactor `NoUsdcHint` out of it, do **not** export it, do **not**
  "DRY up" the two screens. Mirroring a ~12-line hint is intended here; a shared
  extraction is a separate, larger change and risks the markets section. If you
  feel you must edit this file, that is a STOP condition.
- `web/lib/moveErrors.ts` — the post-failure toast stays as the race safety net.
- `web/lib/config.ts`, `web/lib/hooks.ts`, `web/lib/ticketing.ts` — read-only.
- The free-claim button (`EventPageScreen.tsx:402-410`) — claiming a free ticket
  needs no priced-coin balance; leave it exactly as is.
- Any change to gas/SUI-for-gas messaging — gas is sponsored when
  `ENOKI_ENABLED`; this plan is about the *payment* coin only.

## Git workflow

- Branch from the current default branch: `git checkout -b advisor/016-buy-balance-precheck`
- Conventional-commit message, e.g.:
  `feat(event): pre-check buyer coin balance and show faucet hint on Buy`
  (matches repo style — recent log shows `feat(...)`, `chore(...)` subjects.)
- Commit the screen change + test together, or in two commits (logic, then test).
- Do **NOT** push or open a PR. (Repo flow is issue → branch → PR and the
  operator opens it; `gh` CLI may hang.)

## Steps

### Step 1: Confirm the live code matches and the gates are green before changing anything

From `web/`:

```
bunx tsc --noEmit && bun run lint
```

Open `web/components/screens/EventPageScreen.tsx` and confirm lines `163`
(`canAct`) and `415-451` (the `prices.map` Buy buttons) match the "Current
state" excerpts above.

**Verify**: `bunx tsc --noEmit` → exit 0, no output; `bun run lint` → exit 0.
If either fails on the untouched tree, that is a STOP condition (the baseline is
already broken — report it, don't build on it).

### Step 2: Add a pure affordability helper at module scope in EventPageScreen.tsx

Add a small, side-effect-free helper near the existing `fmtDate`/`fmtTime`
helpers (top of the file, `EventPageScreen.tsx:33-43`). It decides whether a
balance covers a required amount; keep it pure so it is unit-testable:

```ts
// True when `balance` (smallest units) can cover `required` (smallest units,
// already fee-inclusive). `balance === undefined` means "not loaded yet" → we
// do NOT block the button on an unknown balance (avoid a flash-disabled CTA on
// a slow RPC); we only disable once we've confirmed the wallet is short.
function canAfford(balance: bigint | undefined, required: bigint): boolean {
  if (balance === undefined) return true;
  return balance >= required;
}
```

Also add a coin-aware faucet hint component (mirror of `NoUsdcHint`, generalized
to the coin symbol). Place it next to the other small components
(`GoodToKnow`, `EventPageScreen.tsx:45-56`):

```tsx
// Inline "you can't afford this" hint shown under a Buy button when the wallet's
// balance of the selected coin can't cover the fee-inclusive total. Mirrors the
// markets section's NoUsdcHint, generalized to the priced coin (USDC → Circle
// faucet; anything else → Sui testnet coins guide).
function InsufficientCoinHint({ symbol }: { symbol: string }) {
  const isUsdc = symbol === "USDC";
  return (
    <div className="text-[11px]" style={{ color: "var(--fg3)" }}>
      Not enough {symbol} to buy this ticket.{" "}
      <a
        href={isUsdc ? "https://faucet.circle.com/" : "https://docs.sui.io/guides/developer/getting-started/get-coins"}
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--hi-blue)", textDecoration: "underline" }}
      >
        Get testnet {symbol}
      </a>
      .
    </div>
  );
}
```

**Verify**: `bunx tsc --noEmit` (from `web/`) → exit 0. (Helpers compile; they
are not used yet, so no behavior change.)

> If `tsc` warns these are unused, that is expected at this step — proceed to
> Step 3 which uses them. (The repo's `tsc` config does not error on temporarily
> unused module-scope functions; `bun run lint` is the unused-vars gate and you
> run it at Step 4, after they're wired.)

### Step 3: Query per-coin balances and gate each Buy button + render the hint

Inside the `EventPageScreen` component, **after** `const prices = pricesBySeq.get(eventSeq) ?? [];`
(`EventPageScreen.tsx:166`), add a single multi-coin balance query. Sui's
`getBalance` is one-coin-per-call, so query the **distinct** coin types the
event prices in. The simplest faithful approach that matches the markets pattern
is to query each priced coin with its own `useSuiQuery` call — but hooks cannot
be called in a loop. Use `getAllBalances` instead (one call, all coins), which
`useSuiQuery` supports generically:

```tsx
  // Pre-flight: the connected wallet's balances across all coins, so a priced
  // Buy button can be disabled (with a faucet hint) when the wallet can't cover
  // the fee-inclusive total. Mirrors the markets section's getBalance gate, but
  // uses getAllBalances so multiple priced coins are covered in one call.
  const balancesQ = useSuiQuery<"getAllBalances", GetAllBalancesParams, CoinBalance[]>(
    "getAllBalances",
    { owner: addr ?? "" },
    { enabled: Boolean(addr), staleTime: 15_000 },
  );
  const balanceByCoin = new Map<string, bigint>(
    (balancesQ.data ?? []).map((b) => [b.coinType, BigInt(b.totalBalance)]),
  );
```

Add the two needed types to the existing `@mysten/sui/jsonRpc` type import
(`EventPageScreen.tsx:31`):

```ts
import type {
  CoinBalance,
  GetAllBalancesParams,
  GetObjectParams,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
```

Then, inside the `prices.map((p) => { ... })` block (`:415`), compute
affordability per coin and use it to gate the button and render the hint. The
button currently returns a `<Tooltip>…</Tooltip>`; wrap it so the hint can sit
beneath it. Target shape:

```tsx
{prices.map((p) => {
  const ci = coinInfo(p.coinType);
  const total = totalWithFee(BigInt(p.price));
  const buying = isPending && pendingCoin === p.coinType;
  // undefined while balances load → don't block (canAfford treats it as ok).
  const bal = balancesQ.data ? (balanceByCoin.get(p.coinType) ?? 0n) : undefined;
  const affordable = canAfford(bal, total);
  return (
    <div key={p.coinType} className="space-y-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="w-full"
            disabled={!canAct || isPending || !affordable}
            onClick={() =>
              run(
                buyTx({
                  eventId: id,
                  coinType: p.coinType,
                  priceUnits: BigInt(p.price),
                  recipient: addr!,
                  sponsored: ENOKI_ENABLED,
                }),
                p.coinType,
              )
            }
          >
            <Icon icon="ion:ticket" size={16} />
            {buying
              ? "Buying…"
              : canAct
                ? `Buy · ${fmtAmount(total, ci.decimals)} ${ci.symbol}`
                : statusLabel()}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Total incl. 3% fee: {fmtAmount(total, ci.decimals)} {ci.symbol}
        </TooltipContent>
      </Tooltip>
      {canAct && !affordable && <InsufficientCoinHint symbol={ci.symbol} />}
    </div>
  );
})}
```

Notes the executor must respect:
- The `key` moves from `<Tooltip key={p.coinType}>` to the new wrapping
  `<div key={p.coinType}>`. Do not leave a `key` on both and do not drop it.
- Only show the hint when `canAct && !affordable` — i.e. the sale is otherwise
  buyable and the *only* blocker is balance. When `!canAct`, the button already
  shows `statusLabel()` ("Sold out" / "Sale not open yet" / "Connect wallet to
  buy" / "Event ended"); don't stack a balance hint on top of those.
- Do not change the free-claim branch (`isFree ? <Button …Claim… />`) or the
  `prices.length === 0` "Price not set by organizer" branch.

**Verify**: `bunx tsc --noEmit` (from `web/`) → exit 0, no output.

### Step 4: Lint

**Verify**: `bun run lint` (from `web/`) → exit 0, no errors. (Confirms no
unused imports/vars — both new helpers and both new types are now referenced.)

### Step 5: Add a unit test for the affordability logic

So the gate is regression-protected without a browser, extract the decision into
a test. The component itself is heavy to render, so test the **pure** helper.
Because `canAfford` is module-private (not exported), the lightest faithful
option is to **export it** for testing. Add `export` to the helper from Step 2:

```ts
export function canAfford(balance: bigint | undefined, required: bigint): boolean {
```

Create `web/components/screens/__tests__/EventPageScreen.balance.test.ts`,
modeled structurally on the existing pure-logic tests (e.g. the assertions style
in `web/lib/__tests__/predict.test.ts`). It must cover: balance below required
(blocked), exactly equal (allowed), above (allowed), and undefined/loading
(allowed — don't flash-disable):

```ts
import { describe, expect, it } from "vitest";
import { canAfford } from "@/components/screens/EventPageScreen";

describe("canAfford (Buy balance pre-check)", () => {
  it("blocks when balance is below the fee-inclusive total", () => {
    expect(canAfford(0n, 1_030_000n)).toBe(false);
    expect(canAfford(1_029_999n, 1_030_000n)).toBe(false);
  });
  it("allows when balance exactly covers the total", () => {
    expect(canAfford(1_030_000n, 1_030_000n)).toBe(true);
  });
  it("allows when balance exceeds the total", () => {
    expect(canAfford(5_000_000n, 1_030_000n)).toBe(true);
  });
  it("does not block while the balance is still loading (undefined)", () => {
    expect(canAfford(undefined, 1_030_000n)).toBe(true);
  });
});
```

If importing from a `"use client"` component file breaks the vitest run (e.g. it
pulls in browser-only deps at import time), STOP and report rather than mocking
half the module — note it so the reviewer can decide whether to move `canAfford`
into `web/lib/`. (It is a candidate for `lib/` but moving it is out of scope
here.)

**Verify**: `bun run test EventPageScreen` (from `web/`) → the new test file
runs and all 4 cases pass.

### Step 6: Full gate sweep

**Verify** (all from `web/`):
- `bunx tsc --noEmit` → exit 0, no output.
- `bun run lint` → exit 0.
- `bun run test` → all pass, including the 4 new `canAfford` cases.
- `git status --porcelain` → shows only `web/components/screens/EventPageScreen.tsx`,
  the new `web/components/screens/__tests__/EventPageScreen.balance.test.ts`, and
  (optionally) `plans/README.md`. Nothing else.

## Test plan

- **New test file**: `web/components/screens/__tests__/EventPageScreen.balance.test.ts`,
  covering the `canAfford` helper: below-total (the bug this plan fixes →
  blocked), exactly-equal (allowed), above (allowed), undefined/loading
  (allowed, no flash-disable). 4 cases.
- **Structural pattern to model after**: `web/lib/__tests__/predict.test.ts`
  (vitest `describe`/`it`/`expect`; pure-function assertions). Confirm it exists
  and mirror its imports/style: `bun run test predict` should already pass on the
  untouched tree.
- **Why no component/E2E test**: the repo has no browser E2E layer (CLAUDE.md);
  frontend correctness is `bunx tsc --noEmit` + `bun run lint` + vitest unit
  tests over pure logic. A full render test of this client screen would require
  mocking dapp-kit hooks and is out of scope.
- **Verification**: `bun run test` → all pass, including the 4 new cases.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `bunx tsc --noEmit` exits 0 with no output.
- [ ] `bun run lint` exits 0 with no errors.
- [ ] `bun run test` exits 0; `web/components/screens/__tests__/EventPageScreen.balance.test.ts`
      exists and its 4 `canAfford` cases pass.
- [ ] `grep -n "GetAllBalancesParams" web/components/screens/EventPageScreen.tsx`
      returns a match (the balance query was added).
- [ ] `grep -n "InsufficientCoinHint" web/components/screens/EventPageScreen.tsx`
      returns at least two matches (definition + use).
- [ ] `grep -n "!affordable" web/components/screens/EventPageScreen.tsx` returns
      a match (the Buy button is gated on affordability).
- [ ] `git diff --name-only` (from repo root) lists **only**
      `web/components/screens/EventPageScreen.tsx`,
      `web/components/screens/__tests__/EventPageScreen.balance.test.ts`, and
      optionally `plans/README.md` — and **not** `web/components/screens/EventMarketsScreen.tsx`.
- [ ] `plans/README.md` status row for plan 016 is updated to DONE (or the
      reviewer owns the index).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check reports changes to `EventPageScreen.tsx` or
  `EventMarketsScreen.tsx`, or the excerpts in "Current state" (esp.
  `EventPageScreen.tsx:163` `canAct` and the `prices.map` block at `:415-451`)
  do not match the live code.
- `bunx tsc --noEmit` errors that `getAllBalances`, `GetAllBalancesParams`, or
  `CoinBalance` is not a valid `useSuiQuery` method/type. (The markets file uses
  `getBalance`/`GetBalanceParams`; if `getAllBalances` is unavailable in this SDK
  version, **fall back** to per-coin behavior by querying only the FIRST priced
  coin with the exact `getBalance`/`GetBalanceParams`/`CoinBalance` pattern from
  `EventMarketsScreen.tsx:214-221` and gating only that coin's button — then
  note in your report that multi-coin coverage was reduced to the first coin.)
- The new unit test cannot import `canAfford` from the `"use client"` component
  without dragging in browser-only modules (see Step 5 note).
- Any step's verification fails twice after a reasonable fix attempt.
- Fixing this appears to require editing `EventMarketsScreen.tsx`,
  `moveErrors.ts`, or any other out-of-scope file.
- You discover the assumption "an event can be priced in coins other than USDC"
  changes the faucet-link requirement in a way the plan doesn't cover (e.g. a
  third coin is registered in `config.ts COINS`); report the new coin rather
  than guessing a faucet URL.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **What a reviewer should scrutinize**: (1) the hint only shows when balance is
  the *sole* blocker (`canAct && !affordable`), never stacked on sold-out/closed
  states; (2) a slow/failed balance RPC does **not** flash-disable Buy
  (`canAfford(undefined, …) === true`); (3) the comparison is against
  `totalWithFee(price)`, not the bare price — otherwise a wallet holding exactly
  the ticket price but not the 3% fee would still hit the post-submit error.
- **Future interaction**: if a third payment coin is ever added to
  `config.ts COINS`, the faucet branch in `InsufficientCoinHint` (USDC vs.
  "everything else → Sui coins guide") may need a dedicated link for that coin.
- **Deferred (intentionally)**: factoring the duplicated faucet-hint UI out of
  `EventMarketsScreen` (`NoUsdcHint`) and `EventPageScreen`
  (`InsufficientCoinHint`) into one shared `components/` element. Left out here
  to keep this change small and avoid touching the markets section; worth a
  follow-up once a second consumer is confirmed stable. Also deferred: moving
  `canAfford` into `web/lib/` so it can be unit-tested without importing a
  client component (do this if Step 5 hits the STOP condition).
- **No Move / config / sponsor-allowlist impact**: this is read-only on-chain
  (`getAllBalances`/`getBalance` are RPC reads) and adds no new Move call, so
  `SPONSORED_TARGETS` and `moveErrors.ts` need no changes.

---

### `plans/README.md` row to add (create the file with this table if it does not exist)

```markdown
# Implementation Plans

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 016  | Pre-check buyer coin balance + faucet hint on Buy | P2 | S | — | TODO |
```

Set Status to `DONE` when the Done criteria all hold.
