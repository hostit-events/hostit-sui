# Plan 013: Generate real, scannable ticket QR codes that the door scanner can read

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- web/components/MyTickets.tsx web/components/screens/CheckInScreen.tsx web/components/screens/DoorScreen.tsx web/lib/staffKey.ts web/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx (UX)
- **Planned at**: commit `957206b`, 2026-06-20

> **SHA note (read before drift check)**: this plan was authored against the
> live working tree at HEAD `957206b` ("feat(forum): organizer admin …"). The
> excerpts below were copied from that working tree. (The task brief referenced
> `9b169c0`, which is an *ancestor* CI-merge commit, not HEAD — the in-scope
> files are byte-identical to HEAD per the drift check above, so the excerpts
> are authoritative. If your `git log -1 --oneline` shows a SHA other than
> `957206b`, run the drift check and reconcile before proceeding.)

## Why this matters

The headline attendee flow — "scan your ticket at the door" — is non-functional.
The QR rendered on every ticket (`web/components/MyTickets.tsx`, the `Qr`
component) is a **deterministic faux-QR matrix that encodes nothing**: it hashes
the ticket id into a random-looking grid that no scanner can decode. The door's
camera scanner (`web/components/screens/DoorScreen.tsx`, `QrScanner` →
`extractTicketId`) is a **real** scanner expecting a genuine code, so today staff
must hand-type a 64-character object id for every attendee. The check-in
console's QR tab (`web/components/screens/CheckInScreen.tsx`, `FauxQr`) shows the
same decorative matrix under misleading "point the camera" copy.

After this plan: a ticket renders a **real QR encoding its on-chain object id**,
the door camera decodes it, `extractTicketId` returns the id, and the staff
voucher check-in proceeds with no typing. The console QR tab stops claiming a
scanner exists where there is none.

## Current state

Files involved (each with its role):

- `web/package.json` — frontend deps. Has `@yudiel/react-qr-scanner` (a *scanner*)
  but **no QR generator** (verified: `grep` for `qrcode`/`qrcode.react`/`react-qr-code`
  in `package.json` and `*.ts(x)` returns nothing).
- `web/components/MyTickets.tsx` — wallet "My tickets" grid; renders the faux QR.
- `web/components/screens/CheckInScreen.tsx` — organizer check-in console; QR tab
  shows a faux QR with misleading copy.
- `web/components/screens/DoorScreen.tsx` — full-screen door view; runs the **real**
  camera scanner and submits the voucher check-in. Do not change its scan logic.
- `web/lib/staffKey.ts` — `extractTicketId(raw)` parses the scanned payload.
- `web/components/QrScanner.tsx` — thin wrapper over the scanner library (read-only here).

### The faux generator on the ticket (the thing to replace)

`web/components/MyTickets.tsx:40-56` — encodes **nothing**, just hashes the seed:

```tsx
/** Deterministic faux-QR matrix (ticket-stub motif). */
function Qr({ seed, size = 54, dim = 11 }: { seed: string; size?: number; dim?: number }) {
  const cells = useMemo(() => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const out: boolean[] = [];
    for (let i = 0; i < dim * dim; i++) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      out.push((h >>> 0) % 100 < 48);
    }
    return out;
  }, [seed, dim]);
```

Rendered at `web/components/MyTickets.tsx:294`, inside `TicketStub`:

```tsx
        <Qr seed={ticketId} />
```

`ticketId` here is the real on-chain object id — `TicketStub` is called at
`web/components/MyTickets.tsx:143-145` as `<TicketStub key={t.id} ticketId={t.id} … />`,
and `t.id` is `entry.data.objectId` (`web/components/MyTickets.tsx:97-104`).

### What the door scanner expects (the contract the QR must satisfy)

`web/lib/staffKey.ts:132-158` — `extractTicketId` accepts a **bare `0x…` object id**
directly (first branch). Encoding the bare object id is therefore all that is needed:

```ts
export function extractTicketId(raw: string): string | null {
  const s = raw.trim();
  // Direct object id.
  if (isValidSuiObjectId(s)) return normalizeSuiObjectId(s);
  // JSON payload.
  if (s.startsWith("{")) { /* … reads ticketId / ticket_id / id … */ }
  // Any 0x-prefixed 64-hex substring (covers URLs and arbitrary wrappers).
  const m = s.match(/0x[0-9a-fA-F]{64}/);
  if (m && isValidSuiObjectId(m[0])) return normalizeSuiObjectId(m[0]);
  return null;
}
```

The door consumes a decoded string in `web/components/screens/DoorScreen.tsx:489-503`
(`onDecode={(v) => … admit(v)}`) and `admit` calls `extractTicketId(rawTicket)` at
`web/components/screens/DoorScreen.tsx:421-423`. The manual paste field's placeholder
is `"0x… ticket object id"` (`web/components/screens/DoorScreen.tsx:520-524`) — i.e.
the bare object id is already the canonical hand-entry format. **Encode the bare
object id** so the QR and the typed path are identical.

> **Deep-link caveat (decides the encoding choice)**: the door route is
> `web/app/(door)/door/[id]/page.tsx`, where `[id]` is the **event** id
> (`<DoorScreen id={id} />`), and `DoorScreen` has **no** `useSearchParams`/`ticket`
> handling (verified: `grep` for `searchParams|useSearchParams` in
> `web/app/(door)/` and `DoorScreen.tsx` returns nothing). A `/door?ticket=<id>`
> deep link would therefore **not** pre-fill anything. Do **not** encode a deep
> link in v1; encode the bare object id. (Wiring `/door?ticket=` is explicitly
> deferred — see Maintenance notes.)

### The console QR tab (misleading copy to fix)

`web/components/screens/CheckInScreen.tsx:501-511` — claims a scanner that doesn't exist:

```tsx
        <TabsContent value="qr">
          <Card className="text-center" style={{ padding: 22 }}>
            <FauxQr seed={eventId} />
            <p className="text-sm text-muted-foreground mt-3">
              Point an attendee&apos;s ticket QR at the staff scanner. On scan, the staff
              device signs a voucher and the attendee submits the on-chain check-in.
            </p>
```

`FauxQr` is defined at `web/components/screens/CheckInScreen.tsx:575-620` (same
faux algorithm, seeded by `eventId`). There is **no** camera or scanner anywhere
in `CheckInScreen.tsx` — the real scanner lives only in `DoorScreen`. This tab
must stop implying a scanner; replace it with a CTA that links to the door view
(`/door/{eventId}` — the same link already used at
`web/components/screens/CheckInScreen.tsx:254-256`: `<Link href={`/door/${event.eventId}`}>`).

### Conventions to honor (inlined — the executor has not read these docs)

- **Package manager is `bun` ONLY.** Never run `npm`/`pnpm`. Add deps with
  `bun add <pkg>` from `web/`. (Project rule, `CLAUDE.md`.)
- **Primary verification gate is `bunx tsc --noEmit`**, run from `web/`. Do
  **NOT** run `bun run build` — it corrupts a running `bun run dev`'s `.next/`.
- **Tests are vitest**, run from `web/` with `bun run test`. Component tests use
  React Testing Library + jsdom (`web/vitest.config.ts`: `environment: "jsdom"`).
  Model new tests on `web/components/__tests__/TxLink.test.tsx` (a pure
  presentational-component smoke test) and `web/lib/__tests__/predict.test.ts`.
- The QR is a pure presentational unit. Keep the faux matrix as a **CSS/SSR
  fallback** so a render before the QR lib mounts (or if it ever fails) still
  shows the ticket-stub motif — i.e. do not delete the `Qr` function; render the
  real QR on top of / in place of it once available.
- shadcn + Tailwind v4 tokens are the styling system; match surrounding inline
  styles in these components (they already use inline `style={{…}}` heavily).
- **Permissionless model**: no issuer/buyer role gate. This change adds none —
  every ticket holder sees their own QR. Do not introduce any access gate.

## Commands you will need

| Purpose            | Command (run from `web/`)                          | Expected on success            |
|--------------------|----------------------------------------------------|--------------------------------|
| Install / add dep  | `bun add qrcode.react`                             | exit 0; entry in `package.json`|
| Install (refresh)  | `bun install`                                      | exit 0                         |
| Typecheck (GATE)   | `bunx tsc --noEmit`                                | exit 0, no errors              |
| Lint               | `bun run lint`                                     | exit 0                         |
| Tests              | `bun run test`                                     | all pass                       |
| Tests (filter)     | `bun run test TicketQr`                            | the new test file passes       |

Do **NOT** run `bun run build`. Use `bunx tsc --noEmit` to verify the frontend.

## Suggested executor toolkit

- If a `shadcn` or React best-practices skill is available, you may consult it
  for component-composition conventions, but this change does not add a shadcn
  component — `qrcode.react` is a plain React component.
- `qrcode.react` exports `QRCodeSVG` (renders an inline `<svg>`, SSR-safe, no
  canvas/DOM-measure) and `QRCodeCanvas`. **Use `QRCodeSVG`** — it renders
  identically on server and client and needs no `useEffect`, so no SSR guard is
  required. Props you need: `value` (string), `size` (number, px),
  `bgColor`, `fgColor`, `level` ("L"|"M"|"Q"|"H").

## Scope

**In scope** (the only files you should modify or create):

- `web/package.json` (+ `bun.lock` / `bun.lockb` — updated automatically by `bun add`; commit it)
- `web/components/MyTickets.tsx`
- `web/components/screens/CheckInScreen.tsx`
- `web/components/__tests__/TicketQr.test.tsx` (**create**)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `web/components/screens/DoorScreen.tsx` — the door scanner already works; its
  `onDecode → extractTicketId → admit` path is the consumer this plan satisfies.
  Changing it risks the live check-in flow. (You will *read* it to verify, not edit.)
- `web/lib/staffKey.ts` — `extractTicketId` already accepts a bare object id; no
  change needed. Editing it could break the existing voucher/JSON/URL parsing
  and its 64-hex regex contract.
- `web/components/QrScanner.tsx` — scanner wrapper, unrelated to generation.
- `web/lib/config.ts`, `web/lib/moveErrors.ts` — no new on-chain ids, targets,
  sponsored entries, or Move error codes are introduced by this plan.
- The `/door?ticket=` deep-link wiring — explicitly deferred (Maintenance notes).

## Git workflow

- Branch: `advisor/013-real-qr-generation` (create from the current HEAD).
- Commit per logical unit; conventional-commit style (matches `git log`, e.g.
  `feat(forum): organizer admin …`, `fix(web): …`). Suggested messages:
  - `chore(web): add qrcode.react for real ticket QR codes`
  - `feat(web): render real scannable QR on tickets`
  - `fix(web): replace faux check-in QR tab with door-view CTA`
  - `test(web): cover real ticket QR encodes the object id`
- Do **NOT** push or open a PR unless the operator instructed it. (Repo flow is
  issue → branch → PR; `gh` CLI may hang — leave PR creation to the operator.)

## Steps

### Step 1: Add the QR generator dependency

From `web/`, run `bun add qrcode.react`. This adds a real, well-maintained QR
**generator** (it exports `QRCodeSVG`/`QRCodeCanvas` and ships its own TypeScript
types, so no `@types/*` is needed).

**Verify**:
- `bun pm ls 2>/dev/null | grep qrcode.react || grep qrcode.react package.json` → shows `qrcode.react`
- `bunx tsc --noEmit` → exit 0 (dep resolves, types present)

### Step 2: Render a real QR on each ticket (with the faux matrix as fallback)

In `web/components/MyTickets.tsx`:

1. Add the import near the other imports (top of file):
   ```tsx
   import { QRCodeSVG } from "qrcode.react";
   ```
2. Rename the existing faux `Qr` function (lines 40-85) to `FauxQr` (it stays as
   the SSR/fallback motif) — update its single call site accordingly. Then add a
   new `TicketQr` component that renders the **real** QR encoding the bare object id:
   ```tsx
   /** Real, scannable QR encoding the ticket's on-chain object id. */
   function TicketQr({ ticketId, size = 54 }: { ticketId: string; size?: number }) {
     return (
       <div
         style={{ background: "#fff", padding: 4, borderRadius: 7, flex: "none", lineHeight: 0 }}
       >
         <QRCodeSVG
           value={ticketId}
           size={size}
           bgColor="#ffffff"
           fgColor="#0C112B"
           level="M"
           aria-label="Ticket QR code"
         />
       </div>
     );
   }
   ```
   Keep `#0C112B` as the module color (it is the faux matrix's fill at
   `web/components/MyTickets.tsx:81`) so the look is consistent.
3. Replace the render at `web/components/MyTickets.tsx:294` (`<Qr seed={ticketId} />`)
   with `<TicketQr ticketId={ticketId} />`.

The encoded `value` MUST be the bare object id (`ticketId`), with **no** prefix,
URL, or JSON wrapper — `extractTicketId`'s first branch (`isValidSuiObjectId(s)`)
decodes it directly. Do not encode `seed`-derived data; encode the id itself.

**Verify**:
- `bunx tsc --noEmit` → exit 0
- `grep -n "QRCodeSVG" web/components/MyTickets.tsx` → at least the import + the use
- `grep -n "<Qr " web/components/MyTickets.tsx` → **no matches** (old render gone)
- `grep -n "value={ticketId}" web/components/MyTickets.tsx` → 1 match (id is encoded)

### Step 3: Replace the console QR tab's faux scanner with a door-view CTA

In `web/components/screens/CheckInScreen.tsx`, the `Attendance` function's
`<TabsContent value="qr">` block (lines 501-511) currently renders `<FauxQr … />`
plus copy claiming a scanner. There is **no** scanner in this file, so:

1. Replace the `<FauxQr seed={eventId} />` + the misleading paragraph with a
   clear CTA that links to the real door view for this event. Reuse the existing
   `Link` + `Button` pattern already in this file (see the "Open door view"
   button at `web/components/screens/CheckInScreen.tsx:253-256`). Target shape:
   ```tsx
        <TabsContent value="qr">
          <Card className="text-center" style={{ padding: 22 }}>
            <div className="text-sm text-muted-foreground">
              QR scanning happens in the full-screen door view, which runs the
              camera scanner and signs the staff voucher on each scan.
            </div>
            <Button asChild className="mt-3">
              <Link href={`/door/${eventId}`}>
                <Icon icon="ic:round-meeting-room" size={15} /> Open door view to scan
              </Link>
            </Button>
            <p className="text-xs mono text-muted-foreground mt-2">
              event {eventId.slice(0, 14)}…
            </p>
          </Card>
        </TabsContent>
   ```
   `Link`, `Button`, `Icon`, and `Card` are already imported in this file
   (`web/components/screens/CheckInScreen.tsx:2,21,23,25`); no new imports needed
   except confirm `Link` is imported (it is, line 2: `import Link from "next/link";`).
   `eventId` is the prop already in scope inside `Attendance`
   (`web/components/screens/CheckInScreen.tsx:434`).
2. **Delete the now-unused `FauxQr` function** (lines 575-620) since its only
   caller is removed. (If `tsc`/lint still reference it, you missed a caller —
   STOP and re-check.)

Do NOT change the `qr`/`search` `Tabs` structure or the `Attendance` data logic —
only the contents of the `qr` tab and the dead `FauxQr` function.

**Verify**:
- `bunx tsc --noEmit` → exit 0
- `bun run lint` → exit 0 (catches the unused `FauxQr` if you forgot to delete it)
- `grep -n "FauxQr" web/components/screens/CheckInScreen.tsx` → **no matches**
- `grep -n "Point an attendee" web/components/screens/CheckInScreen.tsx` → **no matches** (misleading copy gone)
- `grep -n "/door/\${eventId}" web/components/screens/CheckInScreen.tsx` → 1 match (CTA present)

### Step 4: Add a unit test that the ticket QR encodes the real object id

Create `web/components/__tests__/TicketQr.test.tsx`, modeled on
`web/components/__tests__/TxLink.test.tsx` (RTL + jsdom + vitest). Because
`TicketQr` is a module-private function inside `MyTickets.tsx`, the most robust,
black-box assertion is to render `qrcode.react`'s `QRCodeSVG` directly with a
known id and assert it produced a real, non-empty SVG with the expected encoded
`value` exposed for accessibility — OR, preferably, export `TicketQr` from
`MyTickets.tsx` for testability.

Choose the **export** approach (smallest, most honest test):

1. In `web/components/MyTickets.tsx`, change `function TicketQr(` to
   `export function TicketQr(` (named export; it does not change the default
   page behavior). This is the only additional edit to `MyTickets.tsx`.
2. Write the test:
   ```tsx
   import { render } from "@testing-library/react";
   import { describe, expect, it } from "vitest";
   import { TicketQr } from "../MyTickets";

   // The ticket QR must encode the bare on-chain object id so the door scanner's
   // extractTicketId (lib/staffKey.ts) can decode it directly. qrcode.react's
   // QRCodeSVG renders an <svg> whose paths represent the encoded value.
   describe("TicketQr", () => {
     const id = "0x000000000000000000000000000000000000000000000000000000000000abcd";

     it("renders a real (non-empty) SVG QR, not a faux matrix", () => {
       const { container } = render(<TicketQr ticketId={id} />);
       const svg = container.querySelector("svg");
       expect(svg).not.toBeNull();
       // A real QR has many <path>/<rect> modules; the old faux matrix used <span>s.
       const modules = svg!.querySelectorAll("path, rect");
       expect(modules.length).toBeGreaterThan(0);
       expect(container.querySelectorAll("span").length).toBe(0);
     });

     it("exposes the encoded id for accessibility", () => {
       const { container } = render(<TicketQr ticketId={id} />);
       expect(container.querySelector('[aria-label="Ticket QR code"]')).not.toBeNull();
     });
   });
   ```
   If `QRCodeSVG` renders modules as `<path>` only (it does in current versions),
   the `path, rect` selector still matches; keep both for version tolerance.

**Verify**:
- `bun run test TicketQr` → the new file runs, both tests pass
- `bun run test` → entire suite passes (no regressions)

### Step 5: Full verification sweep

Run, from `web/`:
- `bunx tsc --noEmit` → exit 0
- `bun run lint` → exit 0
- `bun run test` → all pass (including the 2 new `TicketQr` tests)
- `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` → only the
  in-scope files (plus the lockfile and `plans/`) are modified.

## Test plan

- **New test file**: `web/components/__tests__/TicketQr.test.tsx`.
  - Happy path: `TicketQr` renders a real, non-empty `<svg>` (the regression this
    plan fixes — the old `Qr`/`FauxQr` rendered `<span>` cells, not an SVG).
  - Accessibility: the SVG carries `aria-label="Ticket QR code"`.
- **Structural pattern**: model after `web/components/__tests__/TxLink.test.tsx`
  (RTL `render`/`container` + vitest `describe/it/expect`, jsdom env from
  `web/vitest.config.ts`).
- **Manual smoke (optional, not required to pass)**: the encoded value is the
  bare object id; `extractTicketId("0x…")` in `web/lib/staffKey.ts:138-158`
  already returns it via `isValidSuiObjectId`. No new test is needed for
  `extractTicketId` (it is out of scope and unchanged).
- **Verification**: `bun run test` → all pass, including 2 new `TicketQr` tests.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless a path is given):

- [ ] `grep -q "qrcode.react" package.json` → exit 0 (generator dependency added)
- [ ] `bunx tsc --noEmit` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` exits 0; `web/components/__tests__/TicketQr.test.tsx` exists and its tests pass
- [ ] `grep -rn "<Qr " components/MyTickets.tsx` returns **no matches** (faux QR no longer rendered on tickets)
- [ ] `grep -n "QRCodeSVG" components/MyTickets.tsx` returns **at least 2** matches (import + use)
- [ ] `grep -n "FauxQr" components/screens/CheckInScreen.tsx` returns **no matches** (dead faux fn removed)
- [ ] `grep -n "Point an attendee" components/screens/CheckInScreen.tsx` returns **no matches** (misleading copy removed)
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows only: `package.json`, the bun lockfile, `components/MyTickets.tsx`, `components/screens/CheckInScreen.tsx`, `components/__tests__/TicketQr.test.tsx`, and `plans/README.md` (paths relative to repo root). No `DoorScreen.tsx`, `staffKey.ts`, `config.ts`, or `QrScanner.tsx` changes.
- [ ] `plans/README.md` status row for plan 013 updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `957206b`, or the
  "Current state" excerpts (especially `web/components/MyTickets.tsx:40-85,294`,
  `web/components/screens/CheckInScreen.tsx:501-511,575-620`, and
  `web/lib/staffKey.ts:138-158`) do not match the live code.
- `extractTicketId` in `web/lib/staffKey.ts` no longer accepts a bare object id
  via `isValidSuiObjectId` (its first branch) — then encoding the bare id would
  not decode, and the encoding choice must be reconsidered (report, don't guess).
- `qrcode.react` cannot be added with `bun add` (registry/network/peer-dep
  failure) — report; do not substitute a different library without sign-off,
  and do **not** fall back to `npm`/`pnpm`.
- `bun run build` was run by mistake and the dev bundle is now corrupt — stop
  `bun run dev`, run `rm -rf web/.next`, restart dev, and report.
- Removing the misleading copy in Step 3 would require a code path that *does*
  have a scanner in `CheckInScreen.tsx` (it should not — verified there is none).
  If you find a scanner there, STOP: the plan's premise has drifted.
- Any step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Reviewer focus**: confirm the QR `value` is the **bare** object id (not a
  URL/JSON), since the door's manual-entry placeholder and `extractTicketId`'s
  primary branch both assume the bare id. If you later switch the encoding to a
  deep link or JSON, you rely on `extractTicketId`'s 64-hex regex / JSON branch
  (`web/lib/staffKey.ts:143-156`) instead — add a test there if you do.
- **Deferred — `/door?ticket=<id>` deep link**: the door route
  (`web/app/(door)/door/[id]/page.tsx`) keys on the **event** id and `DoorScreen`
  has no `searchParams`/`ticket` handling. To make a deep-linked QR auto-fill the
  admit input, you would (a) encode `…/door/<eventId>?ticket=<ticketId>`, (b) read
  the `ticket` param in `DoorScreen` (`useSearchParams`) and seed `ticketInput` /
  call `admit` once on mount. That is a separate, larger change — intentionally
  out of scope here; the bare-id QR already makes camera scanning work.
- **Faux fallback**: `FauxQr` is retained in `MyTickets.tsx` as the SSR/loading
  motif. If a future redesign drops it, ensure the real `QRCodeSVG` still renders
  on first paint (it is SSR-safe, so this is low-risk).
- **No on-chain surface touched**: this plan adds no Move calls, no sponsored
  targets (`web/lib/config.ts` `SPONSORED_TARGETS`), and no Move error codes
  (`web/lib/moveErrors.ts`). A reviewer should confirm those files are unchanged.
