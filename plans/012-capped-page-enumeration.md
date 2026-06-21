# Plan 012: Route capped single-page log reads through full cursor enumeration and surface truncation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — **but note that file does NOT exist yet** (see
> "Maintenance notes"); if it is still absent, skip that update and say so in
> your report instead of creating it.
>
> **Drift check (run first)**:
> `git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- web/components/screens/DashboardScreen.tsx web/components/screens/EventManageScreen.tsx web/components/screens/DoorScreen.tsx web/components/screens/CheckInScreen.tsx web/components/screens/ForumScreen.tsx web/components/screens/EventMarketsScreen.tsx web/lib/events.ts web/lib/markets.ts web/lib/pagination.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: —

## Why this matters

Six organizer/attendee screens read **global, newest-first** on-chain logs with a single capped RPC page (`useSuiQuery("queryEvents", {…, order:"descending", limit:50|200})`) and **never follow the `nextCursor`**. `queryEvents` returns logs for the *whole platform* (e.g. every `TicketMinted` across all events), so once ~50 (or ~200) newer logs exist platform-wide, an individual event's own rows fall off the first page and are silently dropped. The result is **undercounted financials presented as authoritative**: revenue, tickets sold, gross sales, and attendance all under-report, and an organizer may make a withdraw decision on wrong numbers.

The repo already has the fix primitive — `web/lib/pagination.ts` `collectPages` (follows the cursor up to `MAX_PAGES=20` ≈ 1000 logs and returns a `truncated` flag) wrapped by `web/lib/events.ts` `useAllEvents(moveEventType)`. Discover and the market badge already use it. This plan routes the six remaining capped reads through `useAllEvents` and **surfaces `truncated`** (a "showing first N" banner) instead of hiding the undercount.

The sharpest case is the forum: `ForumScreen` folds `PostModerated` tombstones (`foldModeration`, latest-action-per-blob wins). If an old `hide` tombstone falls off the truncated 200-log page while the post itself survives, the post **un-hides and reappears** — truncation silently *reverts a moderator action*, not just shortens a list. Fix that one first.

## Current state

All six call sites are confirmed live at commit `957206b` (working tree clean). The fix primitive and an exemplar consumer both already exist.

### The primitive (already exists — DO NOT modify)

`web/lib/pagination.ts:16-32` — pure cursor-follow, injected `fetchPage`, returns a `truncated` flag:

```ts
export async function collectPages<T, C>(
  fetchPage: (cursor: C | null) => Promise<{ data: T[]; nextCursor: C | null; hasNextPage: boolean }>,
  maxPages: number = MAX_PAGES,
): Promise<{ data: T[]; truncated: boolean }> {
  // … walks pages, returns { data: all, truncated: true } only when maxPages stopped it early
}
```
`web/lib/pagination.ts:7` — `export const MAX_PAGES = 20;` (20 pages × ~50/page ≈ 1000 logs).

`web/lib/events.ts:52-70` — `useAllEvents(moveEventType: string)`: one react-query keyed by the type, fully enumerates a single `MoveEventType` newest-first, returns `{ data: SuiEvent[]; truncated: boolean }`:

```ts
export function useAllEvents(moveEventType: string) {
  // … returns useQuery<{ data: SuiEvent[]; truncated: boolean }, Error>(...)
  //     queryKey: ["queryEventsAll", moveEventType], staleTime: 30_000
}
```
**This is the drop-in replacement for every raw `useSuiQuery("queryEvents", { query:{MoveEventType: X}, order:"descending", limit:N })` below.** It takes the exact same `MoveEventType` string those calls already pass.

### The banner exemplar (copy this UI pattern — DO NOT modify)

`web/components/screens/DiscoverScreen.tsx:20` consumes `truncated` from `useEventList()`; `:157-161` renders it:

```tsx
{truncated && (
  <p className="mono text-sm" style={{ color: "var(--fg3)", textAlign: "center" }}>
    Search covers the {events.length} most recent events — older ones aren&apos;t loaded yet.
  </p>
)}
```
Match this idiom (a small `var(--fg3)` paragraph gated on a `truncated` boolean). Reuse `var(--fg3)` and existing class names; do not introduce new design tokens.

### Site A — `web/components/screens/DashboardScreen.tsx:133-150` (organizer totals)

Three raw capped reads feed revenue / ticketsSold / checkedIn / poap totals:

```ts
const minted = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
  "queryEvents",
  { query: { MoveEventType: EV_TICKET_MINTED }, order: "descending", limit: 50 },
  { enabled: Boolean(addr), staleTime: 30_000 },
);
const checkins = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_CHECKED_IN }, order: "descending", limit: 50 }, …);
const poaps = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_POAP_CLAIMED }, order: "descending", limit: 50 }, …);
```
Downstream readers use `.data.data` (an array of `SuiEvent`): `minted.data.data.flatMap(...)` (`:154`), `checkins.data.data.reduce(...)` (`:173`), `poaps.data.data.reduce(...)` (`:181`), and `.isLoading` at `:195` (`statsLoading`).
Constants are **local** to this file: `EV_POAP_CLAIMED` / `EV_CHECKED_IN` defined at `:21-22`; `EV_TICKET_MINTED` imported from `@/lib/config` at `:9`. Existing undercount disclaimers sit at `:266-269` and `:488-491`.

### Site B — `web/components/screens/EventManageScreen.tsx:127-137` (per-event withdraw gating)

```ts
const mintedQ = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: `${PACKAGE_ID}::market::TicketMinted` }, order: "descending", limit: 50 }, { staleTime: 30_000 });
const checkedQ = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: `${PACKAGE_ID}::checkin::CheckedIn` }, order: "descending", limit: 50 }, { staleTime: 30_000 });
```
Readers: `mintedQ.data.data.map(...).filter(...)` (`:154-156`), `checkedQ.data.data.map(...).filter(...)` (`:160-162`). The MoveEventType strings are **inline template literals** here (not the `EV_*` constants). There is an explicit disclaimer at `:454-457`: *"Gross sales and check-ins are tallied from the 50 most recent on-chain logs, not the full history…"* — update its wording once enumeration is in (see Step 2).

### Site C — `web/components/screens/DoorScreen.tsx:109-113` (live door attendance)

```ts
const checkinQ = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_CHECKED_IN }, order: "descending", limit: 50 },
  { refetchInterval: 8000, staleTime: 4000 },
);
```
Reader: `checkinQ.data.data.filter(...).map(...)` (`:117-128`). `EV_CHECKED_IN` is a **local** const at `:60`. **Note the polling options** (`refetchInterval: 8000, staleTime: 4000`) — `useAllEvents` does NOT accept options (it hardcodes `staleTime: 30_000` and no interval). See Step 3 for how to preserve liveness.

### Site D — `web/components/screens/CheckInScreen.tsx:436-440` (attendance list, `Attendance` component)

```ts
const q = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: CHECKED_IN_EVENT }, order: "descending", limit: 50 },
  { refetchInterval: 8_000 },
);
```
Reader: `q.data.data.map(...).filter(...)` (`:444-447`). `CHECKED_IN_EVENT` is a **local** const at `:42`. Also polls (`refetchInterval: 8_000`).

### Site E — `web/components/screens/ForumScreen.tsx:166-184` (SHARPEST — moderation correctness)

```ts
const postsQ = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_FORUM_POST }, order: "descending", limit: 200 },
  { enabled: gatedIn, refetchInterval: gatedIn ? POLL_MS : false });
const modQ = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_FORUM_MODERATED }, order: "descending", limit: 200 },
  { enabled: gatedIn, refetchInterval: gatedIn ? POLL_MS : false });

const modState = useMemo(() => {
  const rows = (modQ.data?.data ?? []).map((ev) => ev.parsedJson as ModerationJson).filter((m) => m && m.event_id === id);
  return foldModeration(rows);
}, [modQ.data, id]);
```
`EV_FORUM_POST` / `EV_FORUM_MODERATED` are **imported from `@/lib/forum`** (`:30-31`), not from config. Readers: `postsQ.data.data` at `:188`, `modQ.data?.data` at `:180`, `postsQ.data` truthiness at `:187`. Both queries are gated by `gatedIn` and poll (`refetchInterval: gatedIn ? POLL_MS : false`).

Why this is a correctness bug, not a cosmetic one — `web/lib/forum.ts:167-180` `foldModeration` keeps the **latest action per blob**; a `hide` only sticks if its tombstone is in the input set:

```ts
export function foldModeration(events: ModerationJson[]): Map<string, ModerationState> {
  const sorted = [...events].sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));
  // … if (a === MOD_HIDE) cur.hidden = true; else if (a === MOD_UNHIDE) cur.hidden = false; …
}
```
If `EV_FORUM_MODERATED` logs exceed 200 platform-wide, an old `hide` tombstone drops out of `modQ`, `foldModeration` no longer marks the blob hidden, and the hidden post **reappears**.

> **Field-name caveat (out of scope — do NOT fix here):** `foldModeration` keys by `e.target_blob_id` (`forum.ts:171,177`) and `ModerationJson` declares `target_blob_id` (`forum.ts:150`), but `ForumScreen` reads `modState.get(p.blob_id)` (`ForumScreen.tsx:196-197`) against the post's `blob_id`. Whether those keys line up at runtime depends on the actual `parsedJson` shape and is a **separate concern** from this truncation fix. This plan only swaps the data source (capped page → full enumeration) and surfaces the truncation flag; it must NOT rename fields or change `foldModeration`. If you discover the keys genuinely don't match, note it in your report and leave it — see STOP conditions.

### Site F — `web/components/screens/EventMarketsScreen.tsx:186-200` + parent `:994-1011` (sellout card self-discovery + discarded id)

`SelloutMarketCard` (defined at `:163`) self-discovers its market id with its own raw capped query and a local dedup memo:

```ts
const created = useSuiQuery<…>("queryEvents",
  { query: { MoveEventType: EV_MARKET_CREATED }, order: "descending", limit: 50 }, { staleTime: 30_000 });
const marketId = useMemo(() => {
  if (!created.data) return null;
  for (const ev of created.data.data) {
    const p = ev.parsedJson as { event_seq?: string | number; market_id?: string };
    if (String(p.event_seq) === eventSeq && p.market_id) return String(p.market_id);
  }
  return null;
}, [created.data, eventSeq]);
```
`created` is then read at `:253` (`created.refetch()` inside `run()`) and `:264` (`created.isLoading` in `loading`).

The parent `EventMarketsScreen` (`:980-1014`) **already computes `selloutMarketId` but throws it away** — `web/lib/markets.ts:41-70` `useEventMarkets(eventSeq)` returns `{ selloutMarketId, rangeMarketId, loading, refetch }`, yet the parent destructures only `rangeMarketId` (`:994`) and passes only `rangeMarketId` to `RangeMarketCard` (`:1006`), while `SelloutMarketCard` (`:998-1003`) gets no `marketId` and re-fetches the same `MarketCreated` log itself (the perf double-fetch).

```tsx
const { rangeMarketId, loading, refetch } = useEventMarkets(eventSeq);
// …
<SelloutMarketCard eventId={eventId} eventSeq={eventSeq} maxTickets={maxTickets} onMarketChange={onMarketChange} />
<RangeMarketCard eventId={eventId} marketId={rangeMarketId} marketsLoading={loading} maxTickets={maxTickets} refetchMarkets={refetch} onMarketChange={onMarketChange} />
```

`RangeMarketCard` is the **exact prop shape to mirror** for the sellout card (`web/components/screens/EventMarketsScreen.tsx:548-563`):

```tsx
function RangeMarketCard({ eventId, marketId, marketsLoading, maxTickets, refetchMarkets, onMarketChange }: {
  eventId: string;
  marketId: string | null;
  marketsLoading: boolean;
  maxTickets: bigint;
  refetchMarkets: () => void;
  onMarketChange?: () => void;
}) { … }
```

### Conventions to honor

- **`useAllEvents(moveEventType)` returns `{ data, truncated, isLoading, isError, refetch, … }`** where `data` is `{ data: SuiEvent[]; truncated: boolean } | undefined`. Today's raw readers do `q.data.data` (a `SuiEvent[]`). After the swap, the array is **`q.data?.data.data`** (react-query envelope → `{data, truncated}` envelope → array). To keep readers unchanged, **adapt at the hook call** (Steps 1-3 show the exact shape). `isLoading` is `q.isLoading`; `refetch` is `q.refetch`; truncation is `q.data?.truncated`.
- `useSuiQuery`'s 3rd arg is react-query options (`web/lib/hooks.ts:104-108`). `useAllEvents` takes **no options** — it hardcodes `staleTime: 30_000` and has no `refetchInterval`/`enabled`. Preserving polling/gating is handled explicitly in Steps 3-5.
- This is a **permissionless** app: do NOT add any role/issuer gate. The banner is informational only.
- Match existing screen style (shadcn + tailwind v4 tokens). Reuse `var(--fg3)` for the banner, as DiscoverScreen does.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install (web) | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun install` | exit 0 |
| **Typecheck (PRIMARY gate)** | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` | exit 0, no errors |
| Lint | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` | exit 0 |
| Unit tests | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` | all pass |
| Grep for residual capped reads | `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && grep -rn "limit: 50\|limit: 200" components/screens/` | only the USDC-decimal comment in EventMarketsScreen.tsx (see Done) |

**Package manager is `bun` ONLY — never `npm`/`pnpm`.** **NEVER run `bun run build` while `bun run dev` is running** (it corrupts `.next/`). Use `bunx tsc --noEmit` to verify — not a production build. The Move tree is untouched by this plan; no `sui` commands needed.

## Scope

**In scope** (the only files you may modify):
- `web/components/screens/DashboardScreen.tsx`
- `web/components/screens/EventManageScreen.tsx`
- `web/components/screens/DoorScreen.tsx`
- `web/components/screens/CheckInScreen.tsx`
- `web/components/screens/ForumScreen.tsx`
- `web/components/screens/EventMarketsScreen.tsx`
- `web/lib/__tests__/markets.test.ts` **(create — see Test plan)** — only if `web/lib/markets.ts` is changed; this plan does NOT change `markets.ts`, so this test is OPTIONAL and pins existing `useEventMarkets` shape only via a pure assertion. Skip if it requires a SuiClient mock you cannot cheaply build (note in report).

**Out of scope** (do NOT touch):
- `web/lib/pagination.ts`, `web/lib/events.ts`, `web/lib/markets.ts`, `web/lib/forum.ts` — the primitives are correct and already used in production paths; reuse, don't edit. (`useEventMarkets` already returns `selloutMarketId`; you only need to start *consuming* it.)
- `web/components/screens/DiscoverScreen.tsx` — the banner exemplar; read it, don't change it.
- `foldModeration` and the `blob_id` / `target_blob_id` field naming — separate concern (see the caveat under Site E).
- `web/lib/config.ts` and `SPONSORED_TARGETS` — no new on-chain ids, targets, or error codes are introduced, so no config/`moveErrors.ts` change.
- Any Move file (`sources/`, `tests/`).

## Git workflow

- Branch: `advisor/012-capped-page-enumeration` (off `main`).
- One commit per step (or per logical site). Conventional-commit messages, matching repo style, e.g.:
  - `fix(forum): enumerate all moderation logs so hidden posts stay hidden`
  - `fix(dashboard): full-enumerate mint/checkin/poap logs and surface truncation`
- Do **NOT** push or open a PR. (Repo flow is issue→branch→PR and `gh` may hang; the operator handles the PR.)

## Steps

Order: forum first (correctness), then the financial screens, then the live-door screens (which need polling care), then the sellout-card refactor last (largest diff). The tree typechecks after every step.

### Step 1: ForumScreen — full-enumerate posts + moderation tombstones, keep moderation correct

In `web/components/screens/ForumScreen.tsx`:

1. Add an import of `useAllEvents` from `@/lib/events` (there is currently no such import — `useSuiQuery` comes from `@/lib/hooks`).
2. Replace the two raw queries (`:166-177`) with:
   ```ts
   const postsQ = useAllEvents(EV_FORUM_POST);
   const modQ = useAllEvents(EV_FORUM_MODERATED);
   ```
   `EV_FORUM_POST`/`EV_FORUM_MODERATED` are already imported from `@/lib/forum`.
3. Update the readers to the new envelope shape:
   - `modState` memo (`:179-184`): `(modQ.data?.data.data ?? [])` instead of `(modQ.data?.data ?? [])`; dependency stays `[modQ.data, id]`.
   - `channelPosts` memo (`:186-192`): guard `if (!postsQ.data) return [];` then iterate `postsQ.data.data.map(...)`.
4. **Preserve gating + polling that `useAllEvents` drops.** `useAllEvents` has no `enabled`/`refetchInterval`. To keep the forum from querying before the user is gated in and to keep it live, wrap consumption so the queries effectively only matter when `gatedIn` (the simplest correct approach: leave the hooks unconditional but keep all *downstream* effects/UI gated on `gatedIn` as they already are — the extra background query when not gated in is cheap and the data is unused). Do **NOT** invent an `enabled` arg on `useAllEvents`. If you judge background polling unacceptable, STOP and report rather than editing `events.ts`.
5. Add a truncation banner near the post list (mirror DiscoverScreen `:157-161`), gated on `Boolean(modQ.data?.truncated || postsQ.data?.truncated)`, e.g.: *"Showing the most recent forum activity — older posts and moderation actions aren't all loaded yet."* Place it where the channel/post list renders.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0, no errors. Then `grep -n "limit: 200" components/screens/ForumScreen.tsx` → **no matches**.

### Step 2: EventManageScreen — full-enumerate mint + check-in; correct the disclaimer

In `web/components/screens/EventManageScreen.tsx`:

1. Import `useAllEvents` from `@/lib/events`.
2. Replace `mintedQ`/`checkedQ` (`:127-137`) with `useAllEvents` calls passing the same MoveEventType strings (keep them inline or reuse — do not add new exported constants):
   ```ts
   const mintedQ = useAllEvents(`${PACKAGE_ID}::market::TicketMinted`);
   const checkedQ = useAllEvents(`${PACKAGE_ID}::checkin::CheckedIn`);
   ```
3. Update readers (`:152-163`): `mintedQ.data.data` → `mintedQ.data?.data.data`; `checkedQ.data.data` → `checkedQ.data?.data.data` (keep the existing `.map().filter()` and guards; the memo currently checks `if (!mintedQ.data) return []` — keep an equivalent guard).
4. Replace the `:454-457` disclaimer text. New copy must reflect enumeration + truncation, e.g.: *"Gross sales and check-ins are tallied from on-chain logs (up to ~1000 most recent). On-chain escrow isn't exposed as a readable field — withdraw to settle."* Optionally gate an extra "older activity may be omitted" clause on `mintedQ.data?.truncated || checkedQ.data?.truncated`.
5. Optionally change the `(recent)` stat labels at `:447`/`:451` only if you also surface truncation; otherwise leave them.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0. `grep -n "limit: 50" components/screens/EventManageScreen.tsx` → **no matches**.

### Step 3: DoorScreen — full-enumerate live attendance (preserve liveness)

In `web/components/screens/DoorScreen.tsx`:

1. Import `useAllEvents` from `@/lib/events`.
2. Replace `checkinQ` (`:109-113`) with `const checkinQ = useAllEvents(EV_CHECKED_IN);` (`EV_CHECKED_IN` local const at `:60` stays).
3. Update the reader (`:115-129`): `checkinQ.data.data` → `checkinQ.data?.data.data` (keep `.filter().map()`); the existing `if (!checkinQ.data) return [];` guard stays valid.
4. **Liveness:** the old query polled every 8s (`refetchInterval: 8000`); `useAllEvents` does not. Restore the live refresh without editing `events.ts` by re-invoking `checkinQ.refetch()` on an interval — add a `useEffect` with `setInterval(() => void checkinQ.refetch(), 8000)` and a cleanup `clearInterval`. (Pattern: a standard React effect; depend on `checkinQ.refetch`.)
5. Add a truncation banner near the attendance list, gated on `Boolean(checkinQ.data?.truncated)`, mirroring DiscoverScreen.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0. `grep -n "limit: 50" components/screens/DoorScreen.tsx` → **no matches**.

### Step 4: CheckInScreen — full-enumerate the `Attendance` list (preserve liveness)

In `web/components/screens/CheckInScreen.tsx`, inside the `Attendance` component (`:434`):

1. Import `useAllEvents` from `@/lib/events` (top of file).
2. Replace `q` (`:436-440`) with `const q = useAllEvents(CHECKED_IN_EVENT);` (`CHECKED_IN_EVENT` local const `:42` stays).
3. Update the reader (`:442-447`): `q.data.data` → `q.data?.data.data`.
4. Restore the 8s liveness with a `useEffect` + `setInterval(() => void q.refetch(), 8000)` + cleanup, same as Step 3.
5. Add a truncation banner near the attendance list, gated on `Boolean(q.data?.truncated)`.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0. `grep -n "limit: 50" components/screens/CheckInScreen.tsx` → **no matches**.

### Step 5: DashboardScreen — full-enumerate mint/checkin/poap totals + surface truncation

In `web/components/screens/DashboardScreen.tsx`:

1. Import `useAllEvents` from `@/lib/events` (alongside the existing `useEventList` import at `:7`).
2. Replace the three queries (`:134-150`) with:
   ```ts
   const minted = useAllEvents(EV_TICKET_MINTED);
   const checkins = useAllEvents(EV_CHECKED_IN);
   const poaps = useAllEvents(EV_POAP_CLAIMED);
   ```
   (Constants: `EV_TICKET_MINTED` from config `:9`; `EV_CHECKED_IN`/`EV_POAP_CLAIMED` local `:21-22`.) Note these drop the `{ enabled: Boolean(addr) }` gate — acceptable (the rows are filtered to `mySeqs`, which is empty when not connected, so the result is unused; and the not-connected branch at `:198` returns before any totals render).
3. Update readers: `minted.data.data` → `minted.data?.data.data` (`:152-154`); `checkins.data.data` → `checkins.data?.data.data` (`:171-173`); `poaps.data.data` → `poaps.data?.data.data` (`:179-181`). Keep the `if (!minted.data) return []` guards.
4. `statsLoading` at `:195` already reads `minted.isLoading || checkins.isLoading` — `useAllEvents` exposes `.isLoading`, so no change needed; confirm it still typechecks.
5. Update the two undercount disclaimers (`:266-269`, `:488-491`) to reflect enumeration, and optionally gate an "older activity may be omitted" clause on `minted.data?.truncated || checkins.data?.truncated || poaps.data?.truncated`. At minimum, add a `truncated` banner mirroring DiscoverScreen so a real overflow is visible.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0. `grep -n "limit: 50" components/screens/DashboardScreen.tsx` → **no matches**.

### Step 6: EventMarketsScreen — pass `selloutMarketId` down; delete the sellout card's inline query

In `web/components/screens/EventMarketsScreen.tsx`:

1. **Parent (`:994`)**: destructure the already-computed sellout id:
   ```ts
   const { selloutMarketId, rangeMarketId, loading, refetch } = useEventMarkets(eventSeq);
   ```
2. **Parent (`:998-1003`)**: pass it down, mirroring `RangeMarketCard`'s prop set:
   ```tsx
   <SelloutMarketCard
     eventId={eventId}
     eventSeq={eventSeq}
     marketId={selloutMarketId}
     marketsLoading={loading}
     maxTickets={maxTickets}
     refetchMarkets={refetch}
     onMarketChange={onMarketChange}
   />
   ```
   Keep `eventSeq` only if the card still needs it after Step 6.3 (it does NOT — once `marketId` is a prop, `eventSeq` is unused in the card; remove it from both the JSX and the signature, or leave it passed and unused only if `tsc`/lint don't flag it — prefer removing to keep lint clean).
3. **`SelloutMarketCard` signature (`:163-175`)**: change to mirror `RangeMarketCard` (`:548-563`) — accept `{ eventId, marketId, marketsLoading, maxTickets, refetchMarkets, onMarketChange }` with the same types (`marketId: string | null; marketsLoading: boolean; refetchMarkets: () => void`).
4. **Delete the inline discovery** (`:186-200`): remove the `created` `useSuiQuery` and the `marketId` `useMemo`. Then fix the two references:
   - `:253` `created.refetch()` inside `run()` → `refetchMarkets()`.
   - `:264` `loading = created.isLoading || (Boolean(marketId) && marketQ.isLoading)` → `marketsLoading || (Boolean(marketId) && marketQ.isLoading)`.
   - `marketId` is now the prop, so `marketQ` (`:203-207`, `enabled: Boolean(marketId)`) and everything downstream keep working unchanged.
5. If `EV_MARKET_CREATED` / `QueryEventsParams` / `PaginatedEvents` / `useSuiQuery` become unused **in this file** after the deletion, remove those now-dead imports (lint will flag them). Be careful: `useSuiQuery` is used elsewhere in this file (e.g. `marketQ`, `balanceQ`) — only remove imports that are genuinely unreferenced.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` → exit 0. `grep -n "limit: 50" components/screens/EventMarketsScreen.tsx` → **no matches** (the only remaining match in the whole `screens/` tree should be the unrelated USDC-decimal *comment*, not a `limit: 50` query — see Done criteria).

### Step 7: Lint + full test pass

Run lint and tests; fix any unused-import / hook-deps warnings introduced.

**Verify**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` → exit 0, AND `bun run test` → all pass.

## Test plan

This is a UI-wiring change over an already-unit-tested primitive (`collectPages`/`foldModeration` are covered by `web/lib/__tests__/pagination.test.ts` and `web/lib/__tests__/forum.test.ts`). The screens have no per-component enumeration logic of their own after this change — they delegate to `useAllEvents`. So the verification is primarily the typecheck + existing suites:

- **Primary**: `bunx tsc --noEmit` (the repo's stated main gate) passes — proves the envelope-shape (`q.data?.data.data`) rewrites are type-correct at all six sites.
- **Regression guard already exists**: `web/lib/__tests__/forum.test.ts:21` asserts `foldModeration([UNHIDE@20, HIDE@10])` → not hidden (latest wins). This plan does NOT change `foldModeration`; the forum bug was that the HIDE row never reached `foldModeration`. After Step 1 the full tombstone set is enumerated, so the existing test's invariant now actually holds in the screen. Re-run it: `bun run test forum` → all pass.
- **Optional new test** (`web/lib/__tests__/markets.test.ts`, only if you can mock cheaply): assert `useEventMarkets`'s pure shape — that it exposes `selloutMarketId` (the field the parent now consumes). Model the structure after `web/lib/__tests__/predict.test.ts` (vitest, no network) and `web/lib/__tests__/pagination.test.ts` (injected fake page fn). If a `SuiClient`/react-query mock is required and non-trivial, **skip and note it** — the `tsc` pass on `EventMarketsScreen.tsx` already proves `selloutMarketId` exists on `useEventMarkets`'s return type.
- **Verification**: `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` → all pass (and the count is ≥ the pre-change count).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` exits 0 with no errors.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint` exits 0.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` exits 0; all suites pass (count ≥ pre-change).
- [ ] `grep -rn "limit: 50\|limit: 200" /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/` returns **only** the line `EventMarketsScreen.tsx:89` (the USDC-decimal *comment* "silently truncated by"), and **zero** `queryEvents … limit:` lines. (Equivalently: `grep -rn "limit: 50\|limit: 200" web/components/screens/ | grep -v "USDC has 6 decimals"` → no output.)
- [ ] `grep -rn "useSuiQuery(\s*\"queryEvents\"\|useSuiQuery<\"queryEvents\"" /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/` returns **no matches** (every screen-level `queryEvents` read now goes through `useAllEvents`).
- [ ] `grep -n "useAllEvents" /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/DashboardScreen.tsx /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/EventManageScreen.tsx /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/DoorScreen.tsx /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/CheckInScreen.tsx /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/ForumScreen.tsx` returns a match in **each** of the five files.
- [ ] `grep -n "selloutMarketId" /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/EventMarketsScreen.tsx` shows it is **destructured from `useEventMarkets` and passed to `SelloutMarketCard`** (the id is consumed, not discarded).
- [ ] `grep -n "truncated" /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/ForumScreen.tsx /Users/dadadave/Dev/HostIT/sui-ticket/web/components/screens/DashboardScreen.tsx` shows a `truncated`-gated banner in each (truncation is surfaced, not swallowed).
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows changes ONLY under the in-scope paths (the six screens, and optionally the new `web/lib/__tests__/markets.test.ts`); no edits to `lib/events.ts`, `lib/pagination.ts`, `lib/markets.ts`, `lib/forum.ts`, `lib/config.ts`, or any Move file.
- [ ] `plans/README.md` status row updated **if that file exists**; if it does not exist (it currently does not), this item is satisfied by reporting its absence rather than creating it.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope file changed since `957206b`, or any "Current state" excerpt no longer matches the live code (line numbers may shift; the bug is a mismatch in *content* — e.g. a site already uses `useAllEvents`, or a constant moved into `config.ts`).
- After swapping a site to `useAllEvents`, the envelope-shape rewrite (`q.data?.data.data`) does not typecheck because the reader's shape differs from what's documented here — investigate, but do not edit `lib/events.ts` to change the return shape.
- Preserving liveness for DoorScreen/CheckInScreen (Steps 3-4) appears to require adding an `enabled`/`refetchInterval` option to `useAllEvents` (i.e. editing `lib/events.ts`). That is out of scope — STOP and report; do not modify the shared hook.
- You find evidence that `foldModeration`'s `target_blob_id` key genuinely does not match `ForumScreen`'s `p.blob_id` lookup at runtime (i.e. moderation never worked even on a single page). That is a *different* bug than truncation — note it and leave it; do NOT rename fields or alter `foldModeration` in this plan.
- The Sellout card refactor (Step 6) would change observable behavior beyond "same first-match market id, now from the shared hook" — e.g. `useEventMarkets`'s first-match dedup differs from the card's old inline loop. (They should be identical: both take the first `MarketCreated` whose `event_seq` matches; confirm by reading `markets.ts:45-51`.) If they differ, STOP and report.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

- **`plans/README.md` does not exist** at the time this plan was written (the `plans/` dir has 001–010 only, no index). The standard executor instruction to "update the status row" cannot be followed; do not fabricate the index. The repo owner should create it per the improve-skill template if they want a tracked index.
- **`MAX_PAGES = 20` is still a ceiling** (`web/lib/pagination.ts:7`): `collectPages` enumerates ~1000 logs, not infinitely. This plan trades "silently drops the tail after 50/200" for "loads up to ~1000 and *tells the user* when there's more." The real fix for high-volume events is a **server-side indexer** (the documented v2 path, noted in `pagination.ts:5-6` and `markets.ts:14-18`). When that lands, these screens should read the indexer instead of `useAllEvents`, and the truncation banners become unnecessary.
- **Reviewer focus**: (1) the envelope-shape change at every reader — easy to write `q.data.data` (old) where `q.data?.data.data` (new) is required; `tsc` catches it but eyeball each. (2) DoorScreen/CheckInScreen liveness — confirm the `setInterval` cleanup runs (no leaked timers) and the 8s cadence is preserved. (3) ForumScreen — confirm the hidden-post-reappears scenario is the one fixed, and that moderation field-naming was left untouched. (4) EventMarketsScreen — confirm the sellout card no longer issues its own `MarketCreated` query (perf double-fetch removed) and that `eventSeq` is cleanly removed from the card if unused.
- **Deferred out of this plan** (intentionally): the `blob_id`/`target_blob_id` field-name reconciliation in moderation (separate concern); any change to `useAllEvents`'s options surface (would touch the shared hook used by Discover/markets); the server-side indexer (v2).
