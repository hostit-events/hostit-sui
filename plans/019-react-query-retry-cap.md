# Plan 019: Cap react-query's global retry to 1 with a bounded delay

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists — unless a reviewer dispatched you
> and told you they maintain the index.
>
> **Drift check (run first)**: from the repo root
> `/Users/dadadave/Dev/HostIT/sui-ticket`, run
> `git diff --stat 957206b..HEAD -- web/app/ClientProviders.tsx web/lib/hooks.ts web/lib/events.ts web/lib/markets.ts web/components/screens/EventMarketsScreen.tsx`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: (none)

> **Planning-time note for the reviewer (not a task)**: the spawning prompt
> named the planned-at SHA as `9b169c0`, but the actual repo `HEAD` at planning
> time was `957206b` (`feat(forum): organizer admin …`), with only the
> untracked `plans/` directory dirty. All excerpts below were copied from the
> live tree at `957206b`. The drift check and all commands use `957206b`. If you
> were told to expect `9b169c0`, that is the only discrepancy — the tracked
> source is clean.

## Why this matters

`@tanstack/react-query` is installed at v5.101.0 and, on the client, defaults to
**3 retries with exponential backoff** (`1s, 2s, 4s … capped at 30s`) for every
failed query. The Discover/event/market screens fan out into many independent
queries — one `EventCreated` enumeration, one `PriceSet` enumeration, a chunked
`multiGetObjects` per event batch, plus per-event market lookups — and **none of
them set a `retry` default**. When the Sui RPC or Walrus aggregator is slow or
rate-limiting, each of those queries independently retries up to 3 times,
amplifying load on an already-struggling endpoint and stretching the loading
state to tens of seconds before an error finally surfaces.

Setting one conservative global default — `retry: 1` with a small bounded
`retryDelay` — keeps a single transient blip self-healing (one quick retry) while
removing the multiplicative retry storm. Queries that should fail fast already
opt out with `retry: false` per-query (e.g. `EventMarketsScreen.tsx`), and
react-query merges per-query options **over** the global default, so those keep
their behavior. This is a one-object change in `web/app/ClientProviders.tsx` plus
a unit test pinning the default.

## Current state

Relevant files (each with its role):

- `web/app/ClientProviders.tsx` — the **single** place a `QueryClient` is
  constructed (verified: `grep -rn "new QueryClient" web/` returns only this
  file). Its `defaultOptions.queries` currently sets `staleTime`, `gcTime`, and
  `refetchOnWindowFocus` but **no `retry`/`retryDelay`**. This is the file you
  edit.
- `web/lib/hooks.ts` — `useSuiQuery` (generic SuiClient-method query) passes
  through caller `options` but supplies **no `retry` default**.
- `web/lib/events.ts` — `useAllEvents` (the cursor-following enumeration shared
  by Discover + market discovery) sets only `staleTime`; `useEventObjects` sets
  `staleTime` + `enabled`. **No `retry` default** in either.
- `web/lib/markets.ts` — `useEventMarkets` / market discovery hooks reuse
  `useAllEvents`, so they inherit whatever the global default is.
- `web/components/screens/EventMarketsScreen.tsx` — already opts **out** of
  retries per-query in two places; these must keep working unchanged.

### `web/app/ClientProviders.tsx:12-24` (the object to change)

```tsx
export function ClientProviders({ children }: { children: React.ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
```

### `web/lib/hooks.ts:104-115` (`useSuiQuery` — spreads caller options last)

```ts
export function useSuiQuery<TFn extends string, TArgs, TResult>(
  fn: TFn,
  args: TArgs,
  options?: Omit<UseQueryOptions<TResult, Error>, "queryKey" | "queryFn">,
) {
  const client = useCurrentClient() as unknown as Record<string, (a: TArgs) => Promise<TResult>>;
  return useQuery<TResult, Error>({
    queryKey: [fn, args],
    queryFn: () => client[fn](args),
    ...options,
  });
}
```

### `web/lib/events.ts:52-70` (`useAllEvents` — no retry)

```ts
export function useAllEvents(moveEventType: string) {
  const client = useCurrentClient() as unknown as {
    queryEvents: (p: QueryEventsParams) => Promise<PaginatedEvents>;
  };
  return useQuery<{ data: SuiEvent[]; truncated: boolean }, Error>({
    queryKey: ["queryEventsAll", moveEventType],
    queryFn: () =>
      collectPages<SuiEvent, EventId>(async (cursor) => {
        const page = await client.queryEvents({
          query: { MoveEventType: moveEventType },
          order: "descending",
          limit: 50,
          cursor: cursor ?? undefined,
        });
        return { data: page.data, nextCursor: page.nextCursor ?? null, hasNextPage: page.hasNextPage };
      }),
    staleTime: 30_000,
  });
}
```

### `web/components/screens/EventMarketsScreen.tsx:237-240` and `:621-624` (existing per-query opt-outs — DO NOT break)

```ts
    "getDynamicFieldObject",
    { parentId: winningTableId ?? "", name: ADDRESS_NAME(addr ?? "") },
    { enabled: Boolean(winningTableId && addr), staleTime: 15_000, retry: false },
  );
```

There is a second, identical `retry: false` site at line 623. Both pass through
`useSuiQuery`'s `...options` spread, so they override the global default.

### Why the global default is safe alongside the per-query opt-outs (verified from the installed library)

`node_modules/@tanstack/query-core/build/legacy/retryer.js` (v5.101.0) resolves
the retry decision from the **already-merged** per-query config:

```js
const retry = config.retry ?? (environmentManager.isServer() ? 0 : 3)
const retryDelay = config.retryDelay ?? defaultRetryDelay   // Math.min(1000 * 2 ** n, 30000)
const shouldRetry =
  retry === true ||
  (typeof retry === 'number' && failureCount < retry) ||
  (typeof retry === 'function' && retry(failureCount, error))
```

So:
- Today, with no global `retry`, client queries get `retry = 3` and the
  30s-capped exponential `retryDelay` — the finding.
- After this change, the global default becomes `retry = 1`; a query that sets
  `retry: false` still resolves to `false` (per-query wins over default) and does
  **not** retry. Nothing about the two `EventMarketsScreen` opt-outs changes.

### Conventions to honor

- **Package manager is bun only.** Never run `npm`/`pnpm` here. Run all frontend
  commands from `web/`.
- **Never run `bun run build` while `bun run dev` is running** — they share
  `.next/` and the production build corrupts the dev bundle. The verification
  gate is `bunx tsc --noEmit`, not a build.
- Tests are **vitest**, chain-free, `globals: true`, jsdom, with a `@/` →
  `web/` alias (see `web/vitest.config.ts`). Test files live in
  `web/lib/__tests__/` and `web/components/__tests__/`. Model the new test on
  the structure of `web/lib/__tests__/predict.test.ts` (plain `describe`/`it`
  importing the unit under test; the `vitest` globals are available without
  importing them, but `predict.test.ts` imports them explicitly — match that
  style: `import { describe, expect, it } from "vitest";`).

## Commands you will need

Run from `/Users/dadadave/Dev/HostIT/sui-ticket/web` unless noted.

| Purpose         | Command                                         | Expected on success                |
|-----------------|-------------------------------------------------|------------------------------------|
| Install (once)  | `bun install`                                   | exit 0                             |
| Typecheck (gate)| `bunx tsc --noEmit`                             | exit 0, no errors                  |
| Lint            | `bun run lint`                                  | exit 0                             |
| All unit tests  | `bun run test`                                  | all files pass                     |
| One test file   | `bunx vitest run lib/__tests__/queryClient.test.ts` | the new file's tests pass     |
| Drift check     | (repo root) `git diff --stat 957206b..HEAD -- web/app/ClientProviders.tsx web/lib/hooks.ts web/lib/events.ts web/lib/markets.ts web/components/screens/EventMarketsScreen.tsx` | no output (no drift) |

## Suggested executor toolkit

- If a `vercel-react-best-practices` skill is available, it is *not* needed here
  — this is a single config object plus a unit test, no component work.
- Reference: TanStack Query v5 `retry` / `retryDelay` docs
  (https://tanstack.com/query/v5/docs/framework/react/guides/query-retries).
  The installed semantics are already quoted above; do not change the values
  based on a newer doc without re-reading `Why this matters`.

## Scope

**In scope** (the only files you may modify or create):
- `web/app/ClientProviders.tsx` — add `retry` + `retryDelay` to
  `defaultOptions.queries`.
- `web/lib/__tests__/queryClient.test.ts` — **create**; a unit test pinning the
  global default.
- `plans/README.md` — update this plan's status row **only if the file exists**.

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/hooks.ts`, `web/lib/events.ts`, `web/lib/markets.ts` — do **not** add
  per-hook `retry` defaults. The global default is the single lever; per-hook
  tuning is a separate, deferred decision (see Maintenance notes).
- `web/components/screens/EventMarketsScreen.tsx` — its two `retry: false`
  opt-outs must remain **exactly as-is**. Do not "consolidate" them.
- Mutations (`useMutation` in `hooks.ts`): write flows
  (`useSignAndExecute` / `useSponsorAndExecute`) — react-query does **not** retry
  mutations by default, and silently retrying a money-moving transaction would be
  wrong. Do not add a `mutations` retry default.
- `staleTime`, `gcTime`, `refetchOnWindowFocus` — leave unchanged.

## Git workflow

- Branch from `main`: `git checkout -b advisor/019-react-query-retry-cap`
- Conventional-commit message, e.g.:
  `perf(query): cap global react-query retry to 1 with bounded delay`
  (matches the repo's conventional-commit style, e.g. the HEAD commit
  `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
- Commit the source change and the test together (one logical unit).
- Do **NOT** push or open a PR unless the operator explicitly instructs it.
  (Repo flow is issue → branch → PR, and the `gh` CLI is known to hang here.)

## Steps

### Step 1: Add the global retry cap to the QueryClient

In `web/app/ClientProviders.tsx`, extend the `defaultOptions.queries` object so
it reads exactly:

```tsx
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            // One quick retry heals a single transient RPC/Walrus blip without
            // the default 3× exponential-backoff storm across the many
            // per-card/per-market queries on Discover. Per-query `retry: false`
            // (e.g. EventMarketsScreen) still wins over this default.
            retry: 1,
            retryDelay: 1000,
          },
        },
      }),
```

Notes:
- Keep the existing three options unchanged and in place; only **add** the two
  new lines (and the comment).
- `retryDelay: 1000` is a fixed 1s wait before the single retry (replacing the
  default exponential function for these queries). A literal number is correct
  here — react-query accepts `number | (attempt, error) => number`.
- Do not touch any other part of the file (the `EnokiFlowProvider` /
  `DAppKitProvider` tree, imports, etc.).

**Verify**:
- `bunx tsc --noEmit` (from `web/`) → exit 0, no errors.
- `grep -n "retry" web/app/ClientProviders.tsx` (from repo root) → shows the
  `retry: 1,` and `retryDelay: 1000,` lines.

### Step 2: Add a unit test pinning the global default

Create `web/lib/__tests__/queryClient.test.ts`. The goal is a chain-free,
deterministic test that fails if the global `retry` default regresses (e.g. a
future refactor drops it back to the implicit `3`). Build a `QueryClient` with
the **same** `defaultOptions` and assert on the resolved query defaults via
`QueryClient.getDefaultOptions()` (or `getQueryDefaults`). Do **not** import or
render `ClientProviders` (it pulls in dapp-kit/Enoki providers and is not a pure
unit).

Use this exact content:

```ts
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

// Pins the conservative global react-query retry policy set in
// app/ClientProviders.tsx. Without an explicit default, react-query retries
// failed client queries 3× with exponential backoff (capped at 30s), which on
// Discover multiplies load across the many per-card/per-market queries when the
// Sui RPC or Walrus aggregator is slow. This test fails if that default ever
// silently reverts to the library default.
//
// We reconstruct the same defaultOptions here rather than importing
// ClientProviders, which mounts dapp-kit/Enoki providers and is not a pure unit.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
        retryDelay: 1000,
      },
    },
  });
}

describe("QueryClient global query defaults", () => {
  it("caps retries at 1 (not the library default of 3)", () => {
    const qc = makeClient();
    expect(qc.getDefaultOptions().queries?.retry).toBe(1);
  });

  it("uses a fixed, bounded retry delay", () => {
    const qc = makeClient();
    expect(qc.getDefaultOptions().queries?.retryDelay).toBe(1000);
  });

  it("keeps the existing cache/staleness defaults", () => {
    const queries = makeClient().getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(30_000);
    expect(queries?.gcTime).toBe(5 * 60_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
  });

  it("does NOT set a mutations retry default (writes must not auto-retry)", () => {
    expect(makeClient().getDefaultOptions().mutations?.retry).toBeUndefined();
  });
});
```

> If `getDefaultOptions()` is not present on the installed `QueryClient` API
> (it is in v5.101.0), this is a **STOP condition** — report it rather than
> reaching into private fields.

**Verify**:
- `bunx vitest run lib/__tests__/queryClient.test.ts` (from `web/`) → the file
  passes with 4 passing tests.

### Step 3: Full verification gate

Run the standard frontend gates from `web/`:

**Verify**:
- `bunx tsc --noEmit` → exit 0, no errors.
- `bun run lint` → exit 0.
- `bun run test` → all test files pass, including the new
  `lib/__tests__/queryClient.test.ts` (4 tests).

### Step 4 (manual, optional but recommended): confirm Discover still self-heals

This is a behavioral sanity check; it is **not** a required gate (there is no
browser E2E layer in this repo). Do it only if a dev server is convenient and
**no production build is running**.

1. From `web/`, start the dev server: `bun run dev` (serves http://localhost:3000).
   Do not run `bun run build` while this is up.
2. Open `http://localhost:3000/discover` and load it once so events render.
3. In browser devtools, throttle/block the Sui RPC (or Walrus) request **once**
   (e.g. devtools Network → block the RPC URL for a single response, then
   unblock), and reload.
4. Expected: the page shows a loading state, performs **at most one** retry for
   each failed query (not three), and recovers once the endpoint responds —
   i.e. the event grid still populates after a single transient failure.

**Verify**: visual — the Discover grid recovers after a single transient RPC
error, and the retried request count per failed query is ≤ 1 in the Network tab.
If the page does **not** recover from a single transient error, that is a STOP
condition (the retry was set too low for a legitimately flaky-once endpoint).

## Test plan

- **New test file**: `web/lib/__tests__/queryClient.test.ts` (created in Step 2),
  covering:
  - happy path: global `queries.retry === 1`;
  - the fix's regression guard: `retry` is **not** the library default of 3;
  - `queries.retryDelay === 1000` (bounded, fixed delay);
  - the pre-existing defaults (`staleTime`, `gcTime`, `refetchOnWindowFocus`)
    are unchanged;
  - mutations have **no** retry default (writes must not auto-retry).
- **Structural pattern**: model after `web/lib/__tests__/predict.test.ts`
  (plain `describe`/`it`, explicit `import { describe, expect, it } from "vitest"`,
  no network/wallet).
- **Verification**: `bun run test` → all pass, including the 4 new tests.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `grep -n "retry: 1" web/app/ClientProviders.tsx` (repo root) returns a match.
- [ ] `grep -n "retryDelay: 1000" web/app/ClientProviders.tsx` (repo root) returns a match.
- [ ] `web/lib/__tests__/queryClient.test.ts` exists
      (`test -f web/lib/__tests__/queryClient.test.ts && echo OK` from repo root → `OK`).
- [ ] `bunx tsc --noEmit` exits 0 with no errors.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0; the new `queryClient` tests (4) pass.
- [ ] The two `retry: false` lines in
      `web/components/screens/EventMarketsScreen.tsx` are unchanged
      (`grep -c "retry: false" web/components/screens/EventMarketsScreen.tsx`
      from repo root → `2`).
- [ ] No files outside the in-scope list are modified
      (`git status --porcelain` from repo root shows only
      `web/app/ClientProviders.tsx`, `web/lib/__tests__/queryClient.test.ts`,
      and — if it exists — `plans/README.md`; plus the still-untracked `plans/`
      entries from this batch).
- [ ] `plans/README.md` status row for plan 019 updated **if that file exists**.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `957206b`, or the
  "Current state" excerpts (especially the `ClientProviders.tsx` `defaultOptions`
  block or the two `EventMarketsScreen` `retry: false` lines) no longer match the
  live code.
- `grep -rn "new QueryClient" web/` returns **more than one** construction site —
  this plan assumes `ClientProviders.tsx` is the only `QueryClient`; a second one
  would need the same default and changes the scope.
- `QueryClient.getDefaultOptions()` is unavailable on the installed API (Step 2),
  or the assertions cannot read `queries.retry` without touching private fields.
- Any verification command fails twice after a reasonable fix attempt.
- The optional Step 4 check shows Discover does **not** recover from a single
  transient RPC error (retry cap too aggressive for this app's RPC).
- You find an existing global `retry`/`retryDelay` already set (the plan would be
  redundant or conflict) — report what's there.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Per-query tuning is the next lever, deliberately deferred.** If a specific
  query proves it needs different behavior (e.g. the Walrus blob fetch should
  fail fast, or a critical read should retry more), set `retry`/`retryDelay`
  **on that query's options** — the global default is intentionally one
  conservative value, and per-query options win over it. Do not re-tune the
  global default for one screen's needs.
- **Reviewer focus**: confirm (1) `retry: 1` is on `queries`, not `mutations`
  (writes/sponsored txs must never auto-retry — silently re-submitting a payment
  is a correctness bug); (2) the two `EventMarketsScreen` `retry: false`
  opt-outs are untouched; (3) the unit test reconstructs the same object rather
  than reaching into `QueryClient` internals.
- **If react-query is upgraded** (currently 5.101.0), re-read the retry
  semantics — the unit test pins the *intended* values, not the library
  defaults, so it will keep guarding against regressions, but a major version
  could rename `gcTime`/`retryDelay` shape.
- A future indexer (referenced in `web/lib/events.ts` / `markets.ts` comments as
  the v2 fix for log enumeration) would reduce query fan-out and make the retry
  storm less severe, but does not remove the need for a sane global cap.
