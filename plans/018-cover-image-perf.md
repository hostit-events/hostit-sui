# Plan 018: Lazy-load, async-decode, and size the event cover `<img>` in EventPoster

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```bash
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- \
>   web/components/EventPoster.tsx web/lib/walrus.ts web/next.config.ts
> ```
> Expected: **no output** (the three in-scope files are unchanged since this
> plan was written). If any in-scope file is listed, compare the "Current
> state" excerpts below against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `957206b`, 2026-06-20

> **Planning-SHA note (read once):** The task brief said the tree was clean at
> `9b169c0`. The live tree at planning time was actually clean at **`957206b`**
> (one commit ahead: `feat(forum): organizer admin … [#37]`). That commit does
> **not** touch any in-scope file here — `git diff --stat 9b169c0..957206b` on
> the three files below is empty — so every "Current state" excerpt is valid at
> both SHAs. This plan is stamped at the real HEAD `957206b`. Nothing for you to
> do; this is recorded so the SHAs in the drift check line up.

## Why this matters

Every event surface (Discover grid cards, the event hero, wallet ticket strips)
renders its cover photo through one shared component, `EventPoster`. That cover
is a raw `<img>` with **no `loading`, no `decoding`, and no intrinsic
`width`/`height`** (`web/components/EventPoster.tsx:234-244`), and its `src` is
the **original, full-weight Walrus blob** straight off the aggregator with no
resize or CDN step (`web/lib/walrus.ts:42-44`). On the Discover grid that is N
full-resolution images all fetched and synchronously decoded eagerly — they
compete for bandwidth and main-thread decode time on first paint, which hurts
LCP and interactivity, worst on mobile and slow links.

This plan applies the **lowest-effort, lowest-risk rung**: add
`loading="lazy"`, `decoding="async"`, and intrinsic `width`/`height` to that one
`<img>`. Lazy-loading defers off-screen covers so above-the-fold content wins
the network; async decode keeps image decoding off the critical rendering path.
The bigger structural wins (serving a resized/optimized image, or constraining
upload dimensions) are deliberately **deferred** and recorded in "Maintenance
notes" — they require a `next.config.ts` allowlist change and/or an optimizer
and are out of scope here.

## Current state

Files involved:

- `web/components/EventPoster.tsx` — the shared generated-artwork component
  behind every event surface. The real cover photo, when present, overlays the
  generated art as a raw `<img>` at lines 234-244. **This is the only file you
  will modify.**
- `web/lib/walrus.ts` — Walrus HTTP helpers (no SDK). `blobUrl()` (lines 42-44)
  returns the **unoptimized** aggregator URL used as the cover `src`. Read-only
  context; do **not** change it.
- `web/next.config.ts` — `images.remotePatterns` (lines 5-10) allowlists only
  `placehold.co` and `**.suivision.xyz`; the Walrus aggregator host is **absent**.
  Read-only context; this is *why* `next/image` is not an option without a config
  change (explicitly out of scope — see "Scope").

### The exact element to change — `web/components/EventPoster.tsx:233-244`

```tsx
      {/* Real cover image overlays the generated art on top (cover path unchanged). */}
      {coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
```

Notes that make this safe and explain the chosen shape:

- The `<img>` is always positioned **`absolute inset-0 w-full h-full
  object-cover`** inside a `.poster` wrapper whose height is set by each caller
  (see the consumer list below). Because layout already reserves the box via the
  wrapper height and `inset-0`, the intrinsic `width`/`height` attributes here
  do **not** change the rendered size — they are CLS/aspect hints for the
  browser only. Adding them is harmless; the real perf win is
  `loading="lazy"` + `decoding="async"`.
- `alt=""` is intentional: the cover is decorative (the component is
  `aria-hidden`, line 159). **Keep `alt=""` exactly as-is.** This matters for
  the test (see "Test plan"): an empty-alt img has the ARIA role
  `presentation`, so React Testing Library's `getByRole("img")` will **not**
  find it — query it with `container.querySelector("img")` instead.
- The existing `// eslint-disable-next-line @next/next/no-img-element` comment
  must stay; we are intentionally keeping a raw `<img>` (the aggregator host is
  not in the `next/image` allowlist).

### `web/lib/walrus.ts:41-44` — why the src is full-weight (context, do not edit)

```ts
/** Public aggregator URL for a blob (use as an <img src>). */
export function blobUrl(blobId: string): string {
  return `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`;
}
```

### `web/next.config.ts:3-11` — why next/image is blocked here (context, do not edit)

```ts
const config: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "**.suivision.xyz" },
    ],
  },
};
```

### Every consumer of `EventPoster` (for blast-radius awareness — do not edit)

All pass `className="absolute inset-0"` and render inside a `.poster` wrapper
with an explicit height. The cover `<img>` only renders when `coverUrl` is
truthy (so the `glyph={false}` strips below never show it):

- `web/components/EventCard.tsx:96` (skeleton, no cover), `:153` (grid card,
  `coverUrl`, wrapper `height: 150`)
- `web/components/screens/EventPageScreen.tsx:217` (hero, `coverUrl`, wrapper
  `height: 280`)
- `web/components/screens/WalletScreen.tsx:143` (`glyph={false}`, no cover),
  `:282` (no `coverUrl`)
- `web/components/MyTickets.tsx:209` (`glyph={false}`, no cover)

No consumer passes width/height to the `<img>`; none reads it back. The change
is isolated to the one element.

### Repo conventions that apply

- **Component test pattern** — model the new test on
  `web/components/__tests__/TxLink.test.tsx` (the repo's only component test).
  Full file for reference:
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
      expect(link).toHaveAttribute("target", "_blank");
      ...
    });
  });
  ```
  jsdom + `globals: true` + `@testing-library/jest-dom` matchers are configured
  in `web/vitest.config.ts` and `web/vitest.setup.ts` — no per-file setup needed.
  Tests are discovered by glob `**/*.{test,spec}.{ts,tsx}`.
- Package manager is **bun only** in `web/`. Never `npm`/`pnpm`.
- **Never run `bun run build` while `bun run dev` is running** — they share
  `.next/` and a prod build corrupts the dev bundle. The verification gate for
  the frontend is `bunx tsc --noEmit`, **not** `bun run build`.

## Commands you will need

Run all of these from `/Users/dadadave/Dev/HostIT/sui-ticket/web`.

| Purpose         | Command                                            | Expected on success                       |
|-----------------|----------------------------------------------------|-------------------------------------------|
| Install (once)  | `bun install`                                      | exit 0                                     |
| Typecheck (gate)| `bunx tsc --noEmit`                                | exit 0, no output                          |
| Lint            | `bun run lint`                                     | exit 0, no errors on `EventPoster.tsx`     |
| Test (all)      | `bun run test`                                     | all files pass                             |
| Test (filter)   | `bun run test EventPoster`                         | the new test file passes                   |
| Drift check     | see the drift-check block in the header            | empty output                               |

Do **not** run `bun run build` (see conventions above).

## Suggested executor toolkit

- The `vercel-react-best-practices` skill, if available, for confirming the
  `<img>` attribute set — but the target shape is fully specified in Step 1, so
  this is optional.
- No on-chain tooling, no `sui` commands, and no network access are needed.

## Scope

**In scope** (the only files you should modify):
- `web/components/EventPoster.tsx` — add three attributes to the cover `<img>`.
- `web/components/__tests__/EventPoster.cover.test.tsx` (create) — the new
  component test.

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/walrus.ts` — changing `blobUrl()` to point at an optimizer is a
  separate, larger change (deferred; see Maintenance notes).
- `web/next.config.ts` — adding the Walrus aggregator host to
  `images.remotePatterns` so `next/image` can be used is the bigger structural
  fix and is deliberately deferred (it changes the whole image pipeline and risk
  profile). Do not edit it.
- The preview `<img>` in `web/components/screens/CreateEventScreen.tsx:1504-1511`
  — that is a local object-URL upload preview (`coverPreview`), not the live
  Walrus cover; it is a different code path. Leave it unchanged.
- The brand-logo `<img>` tags in `Header.tsx`, `Footer.tsx`, `LandingV2.tsx`,
  `DoorScreen.tsx` — local `/brand/*` assets, unrelated to this finding.
- Do **not** convert the `<img>` to `next/image`, and do **not** remove the
  `eslint-disable @next/next/no-img-element` comment.
- Do **not** change `alt=""`, the `className`, the `onError` handler, the
  `src`, or the `{coverUrl && …}` guard.

## Git workflow

- Branch off `main`: `git checkout -b advisor/018-cover-image-perf`
- One conventional-commit, e.g.:
  `perf(web): lazy-load + async-decode + size event cover image`
  (matches repo style — recent log has `feat(forum): …`, `fix(web): …`,
  `ci: …`).
- Do **not** push and do **not** open a PR (the operator did not request it; the
  repo's real flow is issue → branch → PR and the `gh` CLI may hang).

## Steps

### Step 1: Add `loading`, `decoding`, `width`, and `height` to the cover `<img>`

In `web/components/EventPoster.tsx`, edit **only** the cover `<img>` element
(lines 234-244). Add `loading="lazy"`, `decoding="async"`, and intrinsic
`width={1200} height={630}` (a 1.91:1 social-cover aspect; the rendered size is
unaffected because the element is `absolute inset-0 w-full h-full object-cover`,
so these are CLS/aspect hints only). Keep everything else byte-identical —
`src`, `alt=""`, `className`, the `onError` handler, the eslint-disable comment,
and the `{coverUrl && …}` guard.

Target shape:

```tsx
      {/* Real cover image overlays the generated art on top (cover path unchanged). */}
      {coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          width={1200}
          height={630}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
```

**Verify**:
```bash
# From web/. Confirm exactly these four attributes are now present on the cover img.
grep -nE 'loading="lazy"|decoding="async"|width=\{1200\}|height=\{630\}' \
  components/EventPoster.tsx
```
→ prints four matching lines (one per attribute).
And:
```bash
bunx tsc --noEmit
```
→ exit 0, no output.

### Step 2: Add a component smoke test asserting the cover img attributes

Create `web/components/__tests__/EventPoster.cover.test.tsx`, modeled on
`web/components/__tests__/TxLink.test.tsx`. It must:

1. Render `<EventPoster seed="evt-1" category="music" coverUrl="https://example.test/cover" />`
   and assert the cover `<img>` exists with `loading="lazy"`,
   `decoding="async"`, `width="1200"`, `height="630"`, and the unchanged
   `src`/`object-cover` class.
2. Render `<EventPoster seed="evt-2" />` (no `coverUrl`) and assert **no**
   `<img>` is rendered (guards the `{coverUrl && …}` branch).

**Critical gotcha:** the cover has `alt=""`, so it is ARIA role
`presentation` — `screen.getByRole("img")` will **throw / not find it**. Query
it via `container.querySelector("img")` instead.

Target file:

```tsx
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventPoster } from "../EventPoster";

// Smoke test for the cover-image overlay in EventPoster. The cover <img> is
// decorative (alt="") so it has role="presentation" and is NOT found by
// getByRole("img") — query it directly. Asserts the perf attributes
// (lazy-load, async-decode, intrinsic size) and that no <img> renders without
// a coverUrl.
describe("EventPoster cover image", () => {
  it("renders the cover img with lazy-load, async-decode, and intrinsic size", () => {
    const { container } = render(
      <EventPoster seed="evt-1" category="music" coverUrl="https://example.test/cover" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveAttribute("width", "1200");
    expect(img).toHaveAttribute("height", "630");
    expect(img).toHaveAttribute("src", "https://example.test/cover");
    expect(img).toHaveClass("object-cover");
  });

  it("renders no cover img when coverUrl is absent", () => {
    const { container } = render(<EventPoster seed="evt-2" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
```

**Verify**:
```bash
bun run test EventPoster
```
→ the file `components/__tests__/EventPoster.cover.test.tsx` runs and **both
tests pass** (2 passed).

### Step 3: Full lint + typecheck + test gate

**Verify** (run all three from `web/`):
```bash
bunx tsc --noEmit && bun run lint && bun run test
```
→ `tsc` exit 0 (no output); `lint` exit 0 (no new errors on
`EventPoster.tsx` or the new test); `test` reports all files passing,
including the 2 new tests. If lint flags the new test file, fix the lint
finding (do not disable rules) and re-run.

## Test plan

- **New test file**: `web/components/__tests__/EventPoster.cover.test.tsx`
  (created in Step 2), covering:
  - happy path — cover `<img>` present with `loading="lazy"`,
    `decoding="async"`, `width="1200"`, `height="630"`, unchanged `src` and
    `object-cover` class (this is the regression guard for the perf attributes);
  - edge case — `coverUrl` absent ⇒ no `<img>` rendered (guards the conditional
    branch so a future refactor can't silently always-render the cover).
- **Structural pattern**: model after
  `web/components/__tests__/TxLink.test.tsx` (RTL `render`, jsdom, jest-dom
  matchers), but query the decorative `<img>` with
  `container.querySelector("img")` — **not** `getByRole("img")` (empty `alt`
  ⇒ role `presentation`).
- **Verification**: `bun run test` → all pass, including the 2 new tests in the
  new file.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `grep -nE 'loading="lazy"|decoding="async"|width=\{1200\}|height=\{630\}' components/EventPoster.tsx` prints 4 lines.
- [ ] `grep -c 'no-img-element' components/EventPoster.tsx` prints `1` (the eslint-disable comment is still there — the `<img>` was not converted to `next/image`).
- [ ] `grep -c 'alt=""' components/EventPoster.tsx` prints `1` (decorative alt unchanged).
- [ ] `bunx tsc --noEmit` exits 0 with no output.
- [ ] `bun run lint` exits 0 with no errors.
- [ ] `bun run test` exits 0; `components/__tests__/EventPoster.cover.test.tsx` exists and its 2 tests pass.
- [ ] Exactly two files changed and nothing else (from repo root): `git status --porcelain` shows only ` M web/components/EventPoster.tsx` and `?? web/components/__tests__/EventPoster.cover.test.tsx` (plus, if you updated it, ` M plans/README.md`).
- [ ] `git diff -- web/lib/walrus.ts web/next.config.ts` is empty (out-of-scope files untouched).
- [ ] `plans/README.md` status row for plan 018 updated (unless a reviewer owns the index).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check in the header prints any file, **or** the cover `<img>` block
  at `web/components/EventPoster.tsx:233-244` does not match the "Current state"
  excerpt (the codebase drifted since this plan was written).
- The cover `<img>` is no longer a raw `<img>` (e.g. someone migrated it to
  `next/image`, or to a wrapper component) — the attribute targets in Step 1 no
  longer apply; report instead of guessing.
- `bunx tsc --noEmit`, `bun run lint`, or `bun run test` fails and the failure
  is not plainly caused by your two-file change, or fails twice after a
  reasonable fix attempt.
- The fix appears to require editing `web/next.config.ts`, `web/lib/walrus.ts`,
  or any consumer of `EventPoster` — that means the assumption "this is a
  one-element, two-file change" is false. Report.
- You discover the assumption "an empty-`alt` `<img>` is not matched by
  `getByRole('img')`" is false in this RTL/jsdom version (the test would then be
  structured wrong) — report rather than forcing it.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **What a reviewer should scrutinize**: that the diff touches *only* the four
  added attributes on the one `<img>` (no `src`/`alt`/`className`/`onError`/guard
  changes), and that the new test queries the decorative img via
  `querySelector`, not `getByRole`.
- **Deferred, larger perf wins (intentionally NOT in this plan)** — pick up as
  follow-ups when the appetite exists:
  1. **Serve a resized/optimized cover instead of the raw blob.** Today
     `web/lib/walrus.ts:42-44` `blobUrl()` returns the full-weight aggregator
     URL. Options: (a) add the Walrus aggregator host to
     `web/next.config.ts` `images.remotePatterns` and render covers through
     `next/image` (gets automatic resize/format negotiation, but changes the
     whole image pipeline and the `next/image` host-allowlist security surface);
     or (b) route covers through an image CDN/optimizer. Either is M-effort and
     warrants its own plan.
  2. **Constrain uploaded cover dimensions at create time** (e.g. downscale to a
     max width before `storeFile`) in the create flow so the stored blob is
     never oversized in the first place — touches
     `web/components/screens/CreateEventScreen.tsx` and the upload path.
- **What interacts with this change**: if option (1a) is ever taken and the
  cover becomes a `next/image`, this plan's `width`/`height`/`loading`/`decoding`
  attributes and the `EventPoster.cover.test.tsx` selectors must be revisited
  (the rendered element and its attributes change).
