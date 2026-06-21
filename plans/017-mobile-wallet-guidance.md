# Plan 017: Make the wallet screen's empty-state guidance mobile-accurate and useful

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists; if it does not exist, do NOT create
> it — just note in your final report that the index is absent.
>
> **Drift check (run first)**:
> ```bash
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 9b169c0..HEAD -- web/components/screens/WalletScreen.tsx web/components/Header.tsx web/components/MobileTabBar.tsx web/components/AuthControl.tsx
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **NOTE ON THE PLANNED-AT SHA (read this):** This plan was authored against the
> live working tree, which at authoring time was at commit `957206b`
> ("feat(forum): organizer admin …"), NOT `9b169c0`. The line numbers and
> excerpts below were copied from that live tree. If `git rev-parse --short HEAD`
> does not print `957206b`, run the drift check above against whatever the
> current `HEAD` is and re-verify the excerpts before editing. The `plans/`
> directory is untracked, so `git diff` will not show this plan file itself.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (UX copy / no behavior change)
- **Planned at**: commit `9b169c0`, 2026-06-20
- **Issue**: (none)

## Why this matters

The wallet screen tells a disconnected visitor to "Connect your Sui wallet using
the button in the top bar" (`WalletScreen.tsx:62`). On mobile there is **no top
bar**: the `Header` is `hidden … md:block` (`Header.tsx:20`) and the real mobile
entry is the bottom `MobileTabBar`, where the sign-in path lives under the
**Account** tab (`MobileTabBar.tsx:16`, route `/settings`). So a phone user is
told to tap a control that does not exist on their screen — the single most
common dead-end for a new mobile attendee on a permissionless ticketing app.
The authenticated empty-tickets state (`WalletScreen.tsx:213-218`) is also thin:
it only says "Tickets you buy or claim show up here. Discover events." with no
hint of how ticketing works. This plan makes the disconnected copy correct on
both viewports and adds a one-line "how tickets work" explainer to the empty
state. It is **copy/markup only** — no new on-chain calls, no submit logic, no
role gating.

## Current state

Files in scope and their roles:

- `web/components/screens/WalletScreen.tsx` — the wallet/tickets screen. Has a
  disconnected branch (lines 50-68) and an authenticated empty-tickets branch
  (lines 213-218). This is the **only** file this plan edits for behavior.
- `web/components/Header.tsx` — the top app bar; hosts `<AuthControl />`. It is
  desktop-only (`md:block`). Read-only context.
- `web/components/MobileTabBar.tsx` — the mobile bottom nav; the "Account" tab
  routes to `/settings`. Read-only context.
- `web/components/AuthControl.tsx` — the actual connect / "Sign in" control.
  Read-only context (do not move or import it into the wallet screen).
- `web/components/__tests__/TxLink.test.tsx` — the structural pattern for a
  presentational component test (React Testing Library + jsdom). Read-only;
  copy its shape into the new test in Step 3.

### The disconnected branch — the bug (`WalletScreen.tsx:50-68`)

```tsx
  if (!addr) {
    return (
      <div className="space-y-8 screen-in">
        <header className="relative">
          <div className="glow" style={{ width: 360, height: 360, background: "rgba(0,124,250,.4)", top: -150, right: -60, opacity: 0.22 }} />
          <h1 className="page-title" style={{ fontSize: 34 }}>Your tickets &amp; collectibles</h1>
          <p className="page-sub">Connect a wallet to see your tickets, POAPs and saved events.</p>
        </header>
        <Card className="flex flex-col items-center text-center gap-3" style={{ padding: 40 }}>
          <span style={{ color: "var(--hi-blue)" }}><Icon icon="solar:wallet-bold" size={44} /></span>
          <div className="font-semibold" style={{ fontSize: 18 }}>No wallet connected</div>
          <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>
            Connect your Sui wallet using the button in the top bar to access your wallet. In the meantime you can{" "}
            <Link href="/discover" style={{ color: "var(--hi-blue)" }}>discover events</Link>.
          </p>
        </Card>
      </div>
    );
  }
```

The load-bearing problem is the literal phrase **"using the button in the top
bar"** — wrong on mobile.

### The authenticated empty-tickets branch (`WalletScreen.tsx:213-218`)

```tsx
          ) : tickets.length === 0 ? (
            <EmptyState
              icon="ion:ticket"
              title="No tickets yet"
              body={<>Tickets you buy or claim show up here.{" "}<Link href="/discover" style={{ color: "var(--hi-blue)" }}>Discover events</Link>.</>}
            />
          ) : (
```

`EmptyState` is a local helper (`WalletScreen.tsx:261-269`) — a centered card
with an icon, title, and `body: React.ReactNode`:

```tsx
function EmptyState({ icon, title, body }: { icon: string; title: string; body: React.ReactNode }) {
  return (
    <Card className="flex flex-col items-center text-center gap-2" style={{ padding: 40 }} role="status" aria-live="polite">
      <span style={{ color: "var(--fg3)" }}><Icon icon={icon} size={38} /></span>
      <div className="font-semibold" style={{ fontSize: 16 }}>{title}</div>
      <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>{body}</p>
    </Card>
  );
}
```

### Why "top bar" is wrong on mobile — `Header.tsx:20`

```tsx
    <header className="sticky top-0 z-50 hidden border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:block">
```

`hidden … md:block` ⇒ the Header (and the `<AuthControl />` it renders at
`Header.tsx:62`) is **not rendered below the `md` breakpoint**.

### The real mobile entry — `MobileTabBar.tsx:11-24`

```tsx
const TABS = [
  { href: "/discover", label: "Discover", icon: "ic:round-explore" },
  { href: "/wallet", label: "Tickets", icon: "ion:ticket" },
  { href: "/create", label: "Create", icon: "ic:round-add", fab: true },
  { href: "/dashboard", label: "Dashboard", icon: "material-symbols-light:analytics-rounded" },
  { href: "/settings", label: "Account", icon: "ic:round-person" },
] as const;

export function MobileTabBar() {
  // ...
  return (
    <nav className="mtabbar md:hidden" aria-label="Primary">
```

`md:hidden` ⇒ the bottom bar exists **only on mobile**. Its sign-in path is the
**Account** tab, route `/settings`. (Confirmed: `.mtabbar`/`.mtab-fab` styles
exist in `web/app/globals.css:302+`.)

### The sign-in control itself — `AuthControl.tsx:31-77` (read-only context)

`AuthControl` is what renders either dapp-kit's `ConnectButton` or a "Sign in"
link to `/auth` depending on `ENOKI_ENABLED`. It currently lives only inside the
Header. **Do not import or relocate `AuthControl` into `WalletScreen`** — that
control imports a `dynamic(..., { ssr: false })` web component and is positioned
for the header; relocating it is out of scope and would risk SSR/positioning
regressions. The fix is copy that points users at the existing entry points
(Account tab on mobile, top bar on desktop), not a new inline auth button.

### Conventions this plan must honor

- **Permissionless model (project rule):** there is no issuer/buyer role split.
  The new copy must not imply a role, gate, or "apply to host" step — anyone can
  hold or host. Keep language neutral ("buy or claim a ticket", "host your own
  event").
- **Styling:** match the surrounding screen — plain JSX with `className` +
  inline `style` using the CSS custom-property tokens already in this file
  (`var(--hi-blue)` for links, `var(--fg2)`/`var(--fg3)` for muted text). Do
  **not** introduce new Tailwind utility classes the file doesn't already use,
  and do not add a transform/filter to any landing root (irrelevant here, but a
  documented global gotcha).
- **No new network/chain reads.** The disconnected branch must stay a pure,
  static render (it has no `account`, so it must not call wallet/query hooks).
- **Test pattern:** model the new component test after
  `web/components/__tests__/TxLink.test.tsx` (RTL `render` + `screen` queries,
  `describe`/`it` from `vitest`). DOM env is configured
  (`web/vitest.config.ts` → `environment: "jsdom"`, `setupFiles:
  ["./vitest.setup.ts"]`). Mocking a `@/lib/*` module is an established pattern
  — see `web/lib/__tests__/drafts.test.ts:15` (`vi.mock("../seal", …)`).

## Commands you will need

Run all of these from `/Users/dadadave/Dev/HostIT/sui-ticket/web` (the Next.js
tree), **not** the repo root. Package manager is **bun only** — never npm/pnpm.

| Purpose            | Command                                          | Expected on success            |
|--------------------|--------------------------------------------------|--------------------------------|
| Install (if needed)| `bun install`                                    | exit 0                         |
| Typecheck (PRIMARY)| `bunx tsc --noEmit`                              | exit 0, no output              |
| Lint               | `bun run lint`                                   | exit 0                         |
| Unit tests         | `bun run test`                                   | all files pass                 |
| One test file      | `bun run test WalletScreen`                      | the new test file passes       |

**Hard gotcha:** never run `bun run build` while `bun run dev` is running — they
share `.next/` and the production build corrupts the dev bundle. This plan does
**not** require either; verify with `bunx tsc --noEmit` + `bun run test`.

## Suggested executor toolkit

- This is small, static JSX. No skills are required. If a `web-design-guidelines`
  or `frontend-design` skill is available you may consult it for copy tone, but
  the target shapes below are sufficient on their own.

## Scope

**In scope** (the only files you may modify):
- `web/components/screens/WalletScreen.tsx` — edit the two copy blocks.
- `web/components/screens/__tests__/WalletScreen.test.tsx` — **create** (new
  test file; create the `__tests__` dir under `web/components/screens/`).

**Out of scope** (do NOT touch):
- `web/components/Header.tsx`, `web/components/MobileTabBar.tsx`,
  `web/components/AuthControl.tsx` — read-only context for this plan.
- Relocating/importing `AuthControl` into the wallet screen — explicitly out;
  see "AuthControl … read-only context" above.
- Adding any chain query (e.g. a "featured free event" fetched via
  `useEventList`) to the disconnected branch — deferred to v2; see
  "Maintenance notes". The disconnected branch must stay network-free.
- `web/lib/config.ts`, `web/lib/moveErrors.ts`, and any Move source — no new
  IDs, targets, error codes, or contract changes are involved.

## Git workflow

- Branch off the current branch:
  `git -C /Users/dadadave/Dev/HostIT/sui-ticket checkout -b advisor/017-mobile-wallet-guidance`
- Conventional-commit message, e.g.:
  `fix(wallet): mobile-accurate empty-state guidance + how-tickets-work line`
  (matches repo style, e.g. `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
- Commit the screen edit and the new test together (or in two commits). Do
  **NOT** push or open a PR — the operator will handle that.

## Steps

### Step 1: Make the disconnected copy viewport-accurate

In `web/components/screens/WalletScreen.tsx`, replace **only** the inner copy of
the disconnected `<Card>` (lines 60-64) so it no longer claims a "top bar"
exists on mobile. Keep the surrounding `<Card>`, icon span, and the
`"No wallet connected"` heading exactly as they are.

Replace this block:

```tsx
          <div className="font-semibold" style={{ fontSize: 18 }}>No wallet connected</div>
          <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>
            Connect your Sui wallet using the button in the top bar to access your wallet. In the meantime you can{" "}
            <Link href="/discover" style={{ color: "var(--hi-blue)" }}>discover events</Link>.
          </p>
```

with copy that names both entry points without asserting one exists everywhere.
Target shape (wording may be polished, but it MUST: (a) reference the **Account**
tab for mobile, (b) not say "top bar" without qualifying it as desktop, and
(c) keep the `/discover` link):

```tsx
          <div className="font-semibold" style={{ fontSize: 18 }}>No wallet connected</div>
          <p className="text-sm" style={{ color: "var(--fg2)", maxWidth: 380 }}>
            Sign in to see your tickets and collectibles. On mobile, tap{" "}
            <span className="font-medium" style={{ color: "var(--fg1)" }}>Account</span>{" "}
            in the bottom bar; on desktop, use the Sign in button in the top bar. Or just{" "}
            <Link href="/discover" style={{ color: "var(--hi-blue)" }}>browse events</Link>{" "}
            first.
          </p>
```

Notes:
- `var(--fg1)` is already used elsewhere in this file (e.g. line 291), so it is a
  valid token — no new CSS needed.
- Do not add a `<Link href="/settings">` here: the `/settings` page is the
  account hub, but `/auth` is the dedicated sign-in route when Enoki is on
  (`AuthControl.tsx:71-73`). Pointing the user at the persistent **Account tab
  label** (which is always visible on mobile) is robust regardless of
  `ENOKI_ENABLED`. Plain text for "Account" (not a link) avoids coupling this
  copy to either route.

**Verify**:
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && grep -n "in the top bar to access your wallet" components/screens/WalletScreen.tsx
```
→ **no output** (exit 1) — the old wrong phrase is gone.

```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && grep -n "Account" components/screens/WalletScreen.tsx
```
→ at least one match in the disconnected branch (the new copy references the
Account tab).

### Step 2: Enrich the authenticated empty-tickets state with a "how tickets work" line

In the same file, update the empty-tickets `EmptyState` (lines 213-218). Keep
`icon="ion:ticket"` and `title="No tickets yet"`; expand `body` to add one
plain "how tickets work" sentence and keep the `/discover` link. Stay neutral on
roles (anyone can buy/claim OR host).

Replace:

```tsx
            <EmptyState
              icon="ion:ticket"
              title="No tickets yet"
              body={<>Tickets you buy or claim show up here.{" "}<Link href="/discover" style={{ color: "var(--hi-blue)" }}>Discover events</Link>.</>}
            />
```

with the target shape (wording may be polished; it MUST keep the `/discover`
link and add a one-line explainer):

```tsx
            <EmptyState
              icon="ion:ticket"
              title="No tickets yet"
              body={
                <>
                  Buy or claim a ticket and it lands in your wallet as an on-chain
                  pass you scan at the door.{" "}
                  <Link href="/discover" style={{ color: "var(--hi-blue)" }}>Discover events</Link>{" "}
                  to get your first one.
                </>
              }
            />
```

Do not add a second CTA, image, or chain query — one explainer line plus the
existing link is the whole change.

**Verify**:
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && grep -n "scan at the door" components/screens/WalletScreen.tsx
```
→ one match (the new explainer line is present).

### Step 3: Add a presentational test for the disconnected branch

`WalletScreen`'s disconnected branch is chosen by `useCurrentAccount()`
(`WalletScreen.tsx:47`), which is exported from `@/lib/hooks`
(`web/lib/hooks.ts:24`). To render the disconnected branch deterministically
(no wallet provider, no network), **mock `@/lib/hooks`** so `useCurrentAccount`
returns `null` and the query/sponsor hooks are inert stubs (the disconnected
branch never calls them, but the mock must export every name `WalletScreen`
imports from `@/lib/hooks`: `useCurrentAccount`, `useSignAndExecute`,
`useSponsorAndExecute`, `useSuiQuery`).

Create `web/components/screens/__tests__/WalletScreen.test.tsx`, modeled on
`web/components/__tests__/TxLink.test.tsx` and using the `vi.mock` pattern from
`web/lib/__tests__/drafts.test.ts`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Render the disconnected branch deterministically: no wallet, no network.
// WalletScreen's disconnected path is gated on useCurrentAccount() === null.
vi.mock("@/lib/hooks", () => ({
  useCurrentAccount: () => null,
  useSignAndExecute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSponsorAndExecute: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSuiQuery: () => ({ data: undefined, isLoading: false, error: null, refetch: vi.fn() }),
}));

import { WalletScreen } from "../WalletScreen";

describe("WalletScreen (disconnected)", () => {
  it("points mobile users at the Account tab, not a phantom top bar", () => {
    render(<WalletScreen />);
    // Heading still renders.
    expect(screen.getByText("No wallet connected")).toBeInTheDocument();
    // The new mobile-accurate copy mentions the Account entry point.
    expect(screen.getByText("Account")).toBeInTheDocument();
    // Regression guard: the old, mobile-wrong instruction is gone.
    expect(
      screen.queryByText(/button in the top bar to access your wallet/i),
    ).toBeNull();
    // The discover escape hatch is still a link.
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("/discover");
  });
});
```

Adjust ONLY if the verify step reveals a problem:
- If a `getByText`/`getByRole` query fails because your Step 1 wording differs,
  align the assertion to your actual copy — but keep the regression guard
  (`queryByText(/button in the top bar.../i)` → `null`) and the Account
  assertion intact, since those encode the bug being fixed.
- If `getByRole("link")` throws "multiple elements" (because your copy added a
  second link), switch to `screen.getAllByRole("link")` and assert one of them
  has an href containing `/discover`.

**Verify**:
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test WalletScreen
```
→ the new test file runs and **passes** (1 test).

### Step 4: Full gate — typecheck, lint, all tests

**Verify**:
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit && bun run lint && bun run test
```
→ `tsc` exits 0 (no output); lint exits 0; vitest reports all files passing
(the prior count of test files plus the one new file).

## Test plan

- New file: `web/components/screens/__tests__/WalletScreen.test.tsx`, covering:
  - **happy path** — the disconnected branch renders the "No wallet connected"
    card.
  - **the bug this plan fixes (regression guard)** — the old phrase
    "button in the top bar to access your wallet" is **absent**, and the new
    "Account" entry-point reference is **present**.
  - **escape hatch intact** — a link to `/discover` is rendered.
- Structural pattern: model after `web/components/__tests__/TxLink.test.tsx`
  (RTL render + `screen` queries) using the `vi.mock("@/lib/...")` technique
  from `web/lib/__tests__/drafts.test.ts:15`.
- Verification: `bun run test` → all pass, including the 1 new test.

## Done criteria

Machine-checkable. ALL must hold (run from `web/`):

- [ ] `bunx tsc --noEmit` exits 0 with no output.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0; `web/components/screens/__tests__/WalletScreen.test.tsx` exists and passes.
- [ ] `grep -n "in the top bar to access your wallet" web/components/screens/WalletScreen.tsx` returns **no matches** (run from repo root, or drop `web/` when in `web/`).
- [ ] `grep -n "Account" web/components/screens/WalletScreen.tsx` returns at least one match (the mobile entry-point reference).
- [ ] `grep -n "scan at the door" web/components/screens/WalletScreen.tsx` returns one match (the empty-state explainer).
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows changes ONLY to `web/components/screens/WalletScreen.tsx` and the new `web/components/screens/__tests__/WalletScreen.test.tsx` (plus the branch). No other files modified.
- [ ] `plans/README.md` status row updated **if that file exists**; if it does not exist, this box is N/A — note its absence in your report.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `web/components/screens/WalletScreen.tsx` changed since
  this plan was written and the excerpts in "Current state" (especially the
  disconnected `<p>` at lines 60-64 and the empty-state `EmptyState` at lines
  213-218) no longer match the live file.
- `Header.tsx` no longer carries `hidden … md:block` (line 20) **or**
  `MobileTabBar.tsx` no longer has `md:hidden` (line 24) or no longer labels the
  `/settings` tab "Account" (line 16) — the premise of the fix (Header hidden on
  mobile; bottom bar's account entry) would be invalid, and the new copy could
  be wrong. Re-derive the correct mobile entry point and report it before
  editing copy.
- A verification command fails twice after a reasonable fix attempt (e.g. the
  test can't render `WalletScreen` because mocking `@/lib/hooks` is insufficient
  — report the actual error; do NOT start importing real wallet providers or add
  network setup to make it pass).
- The change appears to require editing any out-of-scope file (Header,
  MobileTabBar, AuthControl, config, or Move sources).
- You find the assumption "the disconnected branch makes no network/chain call"
  is false in the live code (it would mean the screen drifted and the test mock
  may be incomplete).

## Maintenance notes

For whoever owns this screen next:

- **Reviewer focus:** confirm the new disconnected copy reads correctly on a
  ~375px-wide viewport (no "top bar" implied as universal) and that the
  permissionless tone holds (no role/apply-to-host language). This is copy-only;
  there should be zero behavior or network change in the diff.
- **Deferred (v2), intentionally out of scope here:** surfacing a real
  *featured / free event* in the empty/disconnected states. That needs either a
  curated event id (none exists today) or a chain query (`useEventList` in
  `web/lib/events.ts`) added to the logged-out branch — which would break the
  "disconnected branch makes no network call" property and raise risk above
  LOW. If/when added, do it behind the authenticated path or via a static
  curated id in `web/lib/config.ts`, and update the Step 3 test mock so the
  query hook returns a deterministic event.
- **If the mobile nav changes** (e.g. the Account tab is renamed or sign-in
  moves), update the disconnected copy in `WalletScreen.tsx` and the
  `getByText("Account")` assertion in the test together.
- **Coupling:** the copy deliberately references the persistent **Account tab
  label** rather than a route, so it survives `ENOKI_ENABLED` toggling
  (`/auth` vs wallet ConnectButton). Keep it that way unless the tab label
  itself changes.
