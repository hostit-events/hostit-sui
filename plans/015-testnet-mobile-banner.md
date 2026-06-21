# Plan 015: Show a persistent testnet indicator that is visible on mobile

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, skip that — do
> NOT create it; just report completion.)
>
> **Drift check (run first)**:
> `git diff --stat 957206b..HEAD -- web/app/(app)/layout.tsx web/components/Footer.tsx web/components/Header.tsx web/components/MobileTabBar.tsx web/lib/config.ts web/app/globals.css`
> If any in-scope or referenced file changed since this plan was written,
> compare the "Current state" excerpts below against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (UX safety / honest signaling)
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: (none)

> Note for the executor: this plan was authored against the live working tree at
> commit `957206b` (clean except for the untracked `plans/` directory). If the
> drift-check command above reports an unknown revision `957206b`, run
> `git log --oneline -3` and confirm the excerpts in "Current state" still match
> the live files before proceeding; if they do, continue — the SHA label is only
> a provenance marker.

## Why this matters

The app defaults to Sui **testnet** (`web/lib/config.ts:12` — `NETWORK` falls
back to `"testnet"`, and the default USDC coin at `:191-193` is the *testnet*
Circle USDC), so every ticket purchase and payout moves **test coins, not real
money**. But the only place that surfaces the network is the desktop footer
(`web/components/Footer.tsx:13`, `net {NETWORK}`), and the entire footer is
`hidden … md:block` — desktop-only. The header (`web/components/Header.tsx:20`)
is also `md:block` and shows no network at all. The mobile bottom navigation
(`web/components/MobileTabBar.tsx`) shows none either.

Net effect: a phone user sees **no signal** that funds are test coins, while the
landing copy reads like a production product ("Sell tickets, host events… on
Sui" — `web/app/layout.tsx:16-17`). A first-time mobile user can reasonably
believe real money moved. This plan adds a small, persistent, **mobile-visible**
banner in the app shell ("Testnet — tickets and payments use test coins") driven
entirely off the existing `NETWORK` constant, so it auto-hides on mainnet with
zero further edits. It is presentational only — no on-chain, transaction, or auth
behavior changes.

## Current state

All paths are absolute-from-repo-root. **The repo has two trees** — a Move
package at the repo root and the Next.js app under `web/`. This plan touches
**only `web/`**; run all commands from `web/`. Package manager is **bun only** —
never `npm`/`pnpm`. Next.js is `^16.2.9`, React `^19.2.7`.

### The network constant (single source of truth — DO NOT change its default)

`web/lib/config.ts:12-16`:

```ts
export const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";
```

`config.ts` has **no `"use client"` directive** and is already imported by both
a client component (`Footer.tsx`) and a server route (`app/api/sponsor/route.ts`),
so a new client component may import `NETWORK` from it directly. The testnet USDC
default that makes this matter is at `web/lib/config.ts:191-193`:

```ts
export const USDC_COIN_TYPE =
  process.env.NEXT_PUBLIC_USDC_COIN_TYPE ??
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
```

### Where the network is shown today (desktop-only)

`web/components/Footer.tsx:1-26` — the footer root is `hidden … md:block`, and
the network text lives inside it:

```tsx
import { NETWORK, PACKAGE_ID, ENOKI_ENABLED } from "@/lib/config";

export function Footer() {
  return (
    <footer className="mt-10 hidden border-t md:block">
      ...
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
          <span>net {NETWORK}</span>
```

`web/components/Header.tsx:20` — the header root is also desktop-only and shows
no network:

```tsx
<header className="sticky top-0 z-50 hidden border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:block">
```

`web/components/MobileTabBar.tsx:24` — the only mobile chrome is the bottom tab
bar (`md:hidden`), which shows nav icons, not network:

```tsx
<nav className="mtabbar md:hidden" aria-label="Primary">
```

### The app shell that wraps BOTH mobile and desktop (the insertion point)

`web/app/(app)/layout.tsx` (full file, 15 lines):

```tsx
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MobileTabBar } from "@/components/MobileTabBar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex flex-1 flex-col bg-background text-foreground">
      <Header />
      {/* pb-24 on mobile clears the fixed bottom tab bar */}
      <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 pt-8 pb-24 md:pb-8">{children}</main>
      <Footer />
      <MobileTabBar />
    </div>
  );
}
```

This layout is the **route group** `app/(app)/` shell — it renders for every app
route (`discover`, `event`, `create`, `manage`, `wallet`, `dashboard`, `checkin`,
`door`, `forum`, `settings`, `auth`) and on every breakpoint. The **landing page**
is a *separate* zone (`web/app/layout.tsx` → `LandingV2`); it is OUT of scope
(see Scope). Placing the banner as the first child of `.app-shell` (above
`<Header />`) makes it the first thing both a mobile and a desktop user see, and
it does **not** collide with the fixed bottom `MobileTabBar` (`z-index: 60`,
`bottom: 0`) — the banner sits in normal top-of-page flow.

Note `<main>` already reserves `pb-24` on mobile for the fixed bottom bar; a
banner added in normal flow at the top needs no spacer and changes no existing
spacing math.

### Styling convention to match (shadcn + Tailwind v4 tokens)

This app styles with Tailwind v4 design tokens via shadcn (`bg-background`,
`text-foreground`, `text-muted-foreground`, `border`, `border-t`, `bg-accent`).
The footer's network line uses `font-mono text-xs`. There is **no** existing
"banner"/"alert" primitive in `web/components/ui/` to reuse for this; build a
plain `<div>` with token classes. A warning-tinted look is acceptable using
Tailwind's built-in amber utilities (`bg-amber-500/10 text-amber-200/90
border-amber-500/20`) — these are standard Tailwind classes already available in
this v4 setup; do not invent new CSS-variable tokens or edit `globals.css`.

### Existing presentational-component pattern to mirror

`web/components/TxLink.tsx:1-48` is the closest small presentational component
(named export, typed props, token-based `className`). Mirror its shape: a named
function export, no default export.

### Component test pattern to mirror

`web/components/__tests__/TxLink.test.tsx` (full file):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TxLink } from "../TxLink";

describe("TxLink", () => {
  const digest = "ABCDEFGHIJ1234567890";

  it("renders an external explorer link with the shortened digest", () => {
    render(<TxLink digest={digest} />);
    const link = screen.getByRole("link");
    expect(link).toHaveTextContent("tx ABCDEFGHIJ…");
    ...
  });
});
```

Vitest is configured (`web/vitest.config.ts`) with `environment: "jsdom"`,
`globals: true`, `include: ["**/*.{test,spec}.{ts,tsx}"]`, and the `@` → project
root alias. `web/vitest.setup.ts` registers `@testing-library/jest-dom` matchers
(`toBeInTheDocument`, `toHaveTextContent`). `bun run test` runs `vitest run`.

**Testing the `NETWORK` branch:** `NETWORK` is a module-level `const` evaluated
at import time from `process.env.NEXT_PUBLIC_SUI_NETWORK`, so it is **not**
reassignable at runtime. To assert both the testnet-shown and mainnet-hidden
branches deterministically, the test must use Vitest's module mocking to stub
`@/lib/config` per case. Use `vi.resetModules()` + `vi.doMock("@/lib/config", …)`
and a **dynamic** `await import(...)` of the component AFTER the mock, so the
component picks up the mocked `NETWORK`. See Step 3 for the exact shape.

## Commands you will need

| Purpose         | Command (run from `web/`)        | Expected on success            |
|-----------------|----------------------------------|--------------------------------|
| Install deps    | `bun install`                    | exit 0                         |
| Typecheck (GATE)| `bunx tsc --noEmit`              | exit 0, no errors              |
| Lint            | `bun run lint`                   | exit 0, no errors              |
| Unit tests      | `bun run test`                   | all pass (incl. new file)      |
| One test file   | `bunx vitest run components/__tests__/TestnetBanner.test.tsx` | new tests pass |

**Critical dev gotcha:** do **NOT** run `bun run build` while `bun run dev` is
running — they share `.next/` and the production build corrupts the dev client
bundle. The verification gate for this plan is `bunx tsc --noEmit` (plus lint +
test) — **do not use `bun run build` to verify.**

## Suggested executor toolkit

- If a `shadcn` skill is available, you may consult it for token conventions —
  but do **not** add a new shadcn UI primitive for this; a plain token-styled
  `<div>` is the intended scope.
- Reference docs: none needed beyond this plan.

## Scope

**In scope** (the only files you may create or modify):
- `web/components/TestnetBanner.tsx` (create) — the banner component.
- `web/app/(app)/layout.tsx` (modify) — render the banner as the first child of
  `.app-shell`.
- `web/components/__tests__/TestnetBanner.test.tsx` (create) — unit test.
- `plans/README.md` (update status row) **only if it already exists** — do not
  create it.

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/config.ts` — `NETWORK` is the single source of truth; **read** it,
  never change its default or shape. No new error codes are introduced, so
  `web/lib/moveErrors.ts` is untouched.
- `web/components/Footer.tsx` / `web/components/Header.tsx` — leave the existing
  desktop `net {NETWORK}` line as-is; this plan adds a mobile-visible signal, it
  does not refactor the desktop one. (Removing the footer line is a separate
  judgment call; do not.)
- `web/components/MobileTabBar.tsx` — do not cram network state into the bottom
  nav; the banner is the agreed surface.
- `web/app/layout.tsx` / `web/components/LandingV2.tsx` — the landing zone. The
  task notes an *optional* landing demo badge; it is **deferred** here to keep
  this plan narrow and avoid the documented landing CSS pitfall (no
  `transform`/`filter`/`will-change` on the `.lv` root — it breaks the landing's
  `position: fixed`/`sticky`). See Maintenance notes.
- `web/app/globals.css` — no new CSS; use Tailwind utility classes only.
- Any on-chain / `lib/*Tx` / submit-flow code — there is no transaction here.

## Git workflow

- Branch: `advisor/015-testnet-mobile-banner` (create off the current branch;
  do not work on a long-lived shared branch).
- Conventional-commit messages, matching repo style. Recent example from
  `git log --oneline`: `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`.
  Suggested message for this plan:
  `feat(ui): persistent testnet banner visible on mobile`.
- One commit for the whole change is fine (it is small and cohesive).
- Do **NOT** push or open a PR. (Repo flow is issue → branch → PR and the `gh`
  CLI may hang; leave PR creation to the operator.)

## Steps

### Step 1: Create the `TestnetBanner` component

Create `web/components/TestnetBanner.tsx`. Requirements:

- Mark it `"use client"` (it imports the `NETWORK` constant and renders chrome in
  a client tree; matching the other client components in the shell).
- Named export `TestnetBanner` (no default export), mirroring `TxLink.tsx`.
- Import `NETWORK` from `@/lib/config`.
- **Render nothing on mainnet**: `if (NETWORK === "mainnet") return null;`. This
  is what makes the banner auto-disappear in production with no further edits.
- Otherwise render a single non-interactive `<div>` with `role="status"` and the
  text: `Testnet — tickets and payments use test coins`. Interpolate the network
  name so devnet/localnet read correctly, e.g. show the label `{NETWORK}` once.
- Style with Tailwind v4 tokens + amber utilities (no new CSS, no `globals.css`
  edit). Keep it compact and full-width so it reads on a narrow phone.

Target shape (the pattern to produce — exact copy is fine):

```tsx
"use client";

import { NETWORK } from "@/lib/config";

/**
 * Persistent, mobile-visible network indicator. The app defaults to Sui testnet
 * (see lib/config.ts NETWORK), so tickets and payments move TEST coins, not real
 * money — but the only existing signal (the footer's `net {NETWORK}`) is
 * desktop-only (`hidden … md:block`). This renders in the app shell on every
 * breakpoint and auto-hides on mainnet, so no edit is needed when the network
 * env flips to production.
 */
export function TestnetBanner() {
  if (NETWORK === "mainnet") return null;
  return (
    <div
      role="status"
      className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-center font-mono text-xs text-amber-200/90"
    >
      <span className="font-semibold uppercase tracking-wide">{NETWORK}</span>
      {" — tickets and payments use test coins"}
    </div>
  );
}
```

**Verify**: `bunx tsc --noEmit` → exit 0, no errors.

### Step 2: Render the banner at the top of the app shell

Edit `web/app/(app)/layout.tsx`:

1. Add the import: `import { TestnetBanner } from "@/components/TestnetBanner";`
   (alongside the existing `Header`/`Footer`/`MobileTabBar` imports).
2. Render `<TestnetBanner />` as the **first child** of the `.app-shell` `<div>`,
   immediately *before* `<Header />`. This makes it the topmost element on both
   mobile (where Header is hidden) and desktop.

Resulting shell (for reference):

```tsx
<div className="app-shell flex flex-1 flex-col bg-background text-foreground">
  <TestnetBanner />
  <Header />
  <main className="flex-1 w-full mx-auto max-w-[1180px] px-5 sm:px-8 pt-8 pb-24 md:pb-8">{children}</main>
  <Footer />
  <MobileTabBar />
</div>
```

Do **not** change `<main>`'s classes — the banner is in normal flow at the top
and needs no extra spacing; the existing `pb-24` (mobile clearance for the fixed
bottom bar) is unrelated and stays.

**Verify**:
- `bunx tsc --noEmit` → exit 0.
- `grep -n "TestnetBanner" "web/app/(app)/layout.tsx"` → 2 matches (import line +
  the `<TestnetBanner />` element). (Run from repo root, or from `web/` as
  `grep -n "TestnetBanner" "app/(app)/layout.tsx"`.)

### Step 3: Add a unit test for both network branches

Create `web/components/__tests__/TestnetBanner.test.tsx`, modeled on
`web/components/__tests__/TxLink.test.tsx` but using module mocking because
`NETWORK` is a module-level const fixed at import time (see "Current state →
Testing the `NETWORK` branch").

Cover exactly these cases:
- **testnet → shown**: with `NETWORK` mocked to `"testnet"`, the component renders
  an element with `role="status"` whose text contains `test coins` and `testnet`.
- **mainnet → hidden**: with `NETWORK` mocked to `"mainnet"`, the component
  renders nothing (`container` is empty / no `role="status"`).

Target shape (uses `vi.resetModules()` + `vi.doMock` + dynamic `import`, so each
case re-evaluates the module against its mocked `NETWORK`):

```tsx
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/config");
});

async function renderWithNetwork(network: string) {
  vi.resetModules();
  vi.doMock("@/lib/config", () => ({ NETWORK: network }));
  const { TestnetBanner } = await import("../TestnetBanner");
  return render(<TestnetBanner />);
}

describe("TestnetBanner", () => {
  it("shows a test-coins warning on testnet", async () => {
    await renderWithNetwork("testnet");
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/test coins/i);
    expect(banner).toHaveTextContent(/testnet/i);
  });

  it("renders nothing on mainnet", async () => {
    const { container } = await renderWithNetwork("mainnet");
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
```

If `vi.doMock` + dynamic import does not pick up the mock (Vitest hoists static
`vi.mock` but `doMock` is dynamic and must precede the dynamic `import` — it does
above), do not switch strategies blindly: re-read this step. If it still fails
after one reasonable fix, treat it as a STOP condition (see below).

**Verify**: `bunx vitest run components/__tests__/TestnetBanner.test.tsx` → 2
passed, 0 failed.

### Step 4: Full verification sweep

Run the three gates from `web/`:

**Verify**:
- `bunx tsc --noEmit` → exit 0, no errors.
- `bun run lint` → exit 0, no errors (no new warnings introduced by the two new
  files).
- `bun run test` → all suites pass, including the 2 new `TestnetBanner` tests,
  and no previously-passing test now fails.

## Test plan

- **New test file**: `web/components/__tests__/TestnetBanner.test.tsx`, modeled
  structurally on `web/components/__tests__/TxLink.test.tsx` (RTL + vitest +
  jsdom). Cases:
  1. **testnet (default-network) → banner shown** with the "test coins" warning —
     the core regression this plan fixes (mobile users get a signal).
  2. **mainnet → banner hidden** — proves it auto-disappears in production and
     never warns real-money users incorrectly.
- **No Move tests** apply (frontend-only change; no `tests/*.move` touched).
- Verification: `bun run test` → all pass, including the 2 new tests.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `web/components/TestnetBanner.tsx` exists and exports `TestnetBanner`:
      `grep -n "export function TestnetBanner" web/components/TestnetBanner.tsx` →
      1 match. (Run from repo root.)
- [ ] The banner is wired into the app shell:
      `grep -c "TestnetBanner" "web/app/(app)/layout.tsx"` → `2`. (Run from repo
      root.)
- [ ] Mainnet auto-hide is implemented:
      `grep -n 'NETWORK === "mainnet"' web/components/TestnetBanner.tsx` → 1
      match. (Run from repo root.)
- [ ] `bunx tsc --noEmit` exits 0 with no errors.
- [ ] `bun run lint` exits 0 with no errors.
- [ ] `bun run test` exits 0; the 2 new `TestnetBanner` tests exist and pass
      (`bunx vitest run components/__tests__/TestnetBanner.test.tsx` → 2 passed).
- [ ] No file outside the in-scope list is modified — verify with
      `git status --porcelain` (only `web/components/TestnetBanner.tsx`,
      `web/app/(app)/layout.tsx`, `web/components/__tests__/TestnetBanner.test.tsx`,
      and possibly `plans/README.md` and the `plans/015-…md` file appear).
- [ ] `web/lib/config.ts` is unchanged:
      `git diff --quiet -- web/lib/config.ts && echo CLEAN` → prints `CLEAN`.
- [ ] `plans/README.md` status row updated **only if that file already exists**.

## STOP conditions

Stop and report back (do not improvise) if:

- **Drift**: the drift-check `git diff --stat` shows any in-scope or referenced
  file changed since `957206b`, AND the "Current state" excerpts no longer match
  the live code — in particular: `web/app/(app)/layout.tsx` no longer has the
  `.app-shell` `<div>` wrapping `<Header />` + `<MobileTabBar />`; or
  `web/lib/config.ts:12` no longer defines `NETWORK` defaulting to `"testnet"`;
  or `config.ts` has gained a `"use client"` directive (which would change how
  the banner must import `NETWORK`).
- A `TestnetBanner` already exists, or the footer/header has already been changed
  to render a mobile network indicator (the finding is already addressed) — report
  instead of duplicating.
- The mainnet-hidden test cannot be made to pass because `NETWORK` cannot be
  mocked per case after one reasonable fix (re-read Step 3 first). Do not delete
  or skip the test to go green; report.
- Any step's verification fails twice after a reasonable fix attempt.
- The change appears to require editing an out-of-scope file (e.g.
  `web/lib/config.ts`, `globals.css`, `Footer.tsx`, `MobileTabBar.tsx`, or the
  landing zone) to satisfy a requirement — report rather than widening scope.
- The assumption "`config.ts` is safely importable by a client component"
  proves false (e.g. importing `NETWORK` into the client banner pulls a
  server-only dependency and Next.js errors at build/typecheck). In that case
  STOP — do not add `"use client"` to `config.ts` or fork the constant.

## Maintenance notes

For the human/agent who owns this after it lands:

- **Mainnet cutover**: when `NEXT_PUBLIC_SUI_NETWORK` is set to `mainnet`, the
  banner renders nothing automatically (`NETWORK === "mainnet"` guard) — no code
  change required. On `devnet`/`localnet` it shows that network's name, which is
  intended.
- **Reviewer focus**: confirm the banner is the *first* child of `.app-shell`
  (above `<Header />`) so it is visible on mobile, that it adds no layout shift to
  the fixed bottom `MobileTabBar` (different stacking context, normal flow), and
  that `web/lib/config.ts` was not modified.
- **Deferred (intentionally out of this plan)**: an optional "testnet / demo"
  badge on the landing page (`LandingV2.tsx`). It was deferred to avoid the
  documented landing-root CSS hazard — never put a CSS `transform`/`filter`/
  `will-change` on the `.lv` landing root, as it breaks the landing's
  `position: fixed`/`sticky` (intro overlay, sticky nav, pinned sections). If
  picked up later, add the badge as a static inline element, not a transformed
  container, and verify the intro overlay + sticky nav still work.
- **Possible follow-up**: the desktop footer still shows `net {NETWORK}`
  (`Footer.tsx:13`); this plan deliberately left it to avoid scope creep. A future
  cleanup could consolidate both signals, but they are not in conflict.
