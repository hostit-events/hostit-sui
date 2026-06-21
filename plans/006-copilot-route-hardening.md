# Plan 006: Stop upstream error leakage and clamp user content on the copilot route

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: from the repo root
> `/Users/dadadave/Dev/HostIT/sui-ticket`, run:
> `git diff --stat 957206b..HEAD -- web/app/api/copilot/route.ts web/app/api/create-assist/route.ts web/components/screens/CopilotPanel.tsx`
> If `web/app/api/copilot/route.ts` changed since this plan was written,
> compare the "Current state" excerpts below against the live file before
> proceeding; on any mismatch, treat it as a STOP condition.
>
> **Note on the planned-at SHA**: this plan was authored against working-tree
> content that is byte-identical to the excerpts below. The repo `HEAD` at
> authoring time was `957206b` (the prompt that generated this plan named an
> older SHA `9b169c0`; the discrepancy is recorded here for honesty and does
> not affect the excerpts, which were read directly from the live files).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20

## Why this matters

`web/app/api/copilot/route.ts` is an **unauthenticated** edge route that fans
out to Groq's LLM. Two issues widen its attack/cost surface:

1. **Upstream error leakage.** On a Groq non-2xx response it returns
   `error: await r.text()` (the raw Groq error body) to the browser, and in the
   `catch` it returns `error: String(e)` (the raw Node exception). Both can
   surface internal detail — upstream rate-limit/quota wording, model names,
   stack-ish exception strings, or hints about server config — to any caller.
   The sibling route `web/app/api/create-assist/route.ts` already does the
   right thing: it **swallows** the upstream detail and returns only a
   fallback. This route should match that posture and additionally log the
   detail server-side with a stable code for debuggability.

2. **No length clamp on chat content.** The `messages` array is sliced to the
   last 12 turns, and `sanitizeEvent` truncates every `EventCtx` string field
   to 200 chars (`MAX_EV_STR_LEN`), but `messages[].content` has **no**
   per-message length clamp before it is forwarded to Groq. Only the 32 KB
   whole-body cap bounds it, so a single message can be ~32 KB of attacker text
   — a larger prompt-injection payload window and a token-cost amplifier. Clamp
   each message's `content` the same way `sanitizeEvent` clamps its strings.

When this lands: the route never echoes upstream/internal error text to
clients, server logs still carry the detail for debugging, and per-message
content is bounded so the prompt-injection / token-cost surface matches the
already-hardened event-context path.

## Current state

Files in play:

- `web/app/api/copilot/route.ts` — the route to fix. Exports **only**
  `dynamic` and `POST` (verified: `grep -n "export"` returns lines 7 and 130 —
  the helpers `sanitizeEvent`, `clampStr`, `fallback`, `systemPrompt` are
  module-private and NOT exported).
- `web/app/api/create-assist/route.ts` — the sibling route whose
  swallow-and-fallback error posture this plan mirrors. **Do not modify it.**
- `web/components/screens/CopilotPanel.tsx` — the only client caller of
  `/api/copilot`. Read-only here; used to prove the `error` field is unused.
- `web/lib/rateLimit.ts` — supplies `rateLimit` + `clientIpFromHeaders`. No
  change needed; listed so you recognize the imports.
- `web/lib/__tests__/predict.test.ts`, `web/lib/__tests__/memwalAuth.test.ts`
  — the structural patterns for the new test (pure-logic vitest + a
  `vi.mock`-based pattern). See Test plan.

### The two leak sites and the missing clamp (copilot/route.ts)

The string-clamp constant and helper that the event path already uses
(`web/app/api/copilot/route.ts:82-89`):

```ts
// String fields on EventCtx are truncated to this length to bound prompt-injection
// blast radius (an attacker can't smuggle a long instruction via a context field).
const MAX_EV_STR_LEN = 200;

function clampStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.slice(0, MAX_EV_STR_LEN);
}
```

Messages are sliced to 12 turns but their `content` is never length-clamped
(`web/app/api/copilot/route.ts:173-174`):

```ts
  const ev = sanitizeEvent(body.event);
  const messages = (body.messages ?? []).slice(-12);
```

The Groq call and the two leak sites (`web/app/api/copilot/route.ts:187-211`):

```ts
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        messages: [
          { role: "system", content: systemPrompt(ev, memory) },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!r.ok) {
      return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: await r.text() });
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = (j.choices?.[0]?.message?.content ?? "").trim();
    return Response.json({ reply: reply || fallback(ev, messages), sourced: "groq" });
  } catch (e: unknown) {
    return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: String(e) });
  }
```

The `Msg` type (`web/app/api/copilot/route.ts:25-28`):

```ts
interface Msg {
  role: "user" | "assistant";
  content: string;
}
```

### The pattern to mirror (create-assist/route.ts)

`create-assist` swallows the upstream detail entirely — `!r.ok` and `catch`
both return ONLY the fallback, with **no** `error` field
(`web/app/api/create-assist/route.ts:247-261`):

```ts
    if (!r.ok) {
      return Response.json({ description: fallback(ctx, memory), sourced: "fallback" });
    }
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const out = (j.choices?.[0]?.message?.content ?? "").trim();
    return Response.json(
      out
        ? { description: out, sourced: "groq" }
        : { description: fallback(ctx, memory), sourced: "fallback" },
    );
  } catch {
    return Response.json({ description: fallback(ctx, memory), sourced: "fallback" });
  }
```

This plan goes one small step further than create-assist: it keeps a **stable,
generic** `error` code on the client response (so the UI/telemetry can tell a
fallback-due-to-error apart from a fallback-due-to-no-key) AND logs the real
upstream detail server-side. The generic code must be a fixed string — never
interpolated from `r.text()` or the exception.

### Proof the client does not depend on the leaked `error` text

`web/components/screens/CopilotPanel.tsx:286-287` types the response as
`{ reply?: string; error?: string }` but reads ONLY `reply`; `error` is
declared and never used/rendered:

```ts
      const j = (await res.json()) as { reply?: string; error?: string };
      const reply = (j.reply ?? "").trim();
```

So removing the raw `error` body — or replacing it with a fixed generic code —
is non-breaking for the only caller. **Do not change `CopilotPanel.tsx`.**

### Repo conventions that apply

- **Package manager is bun only.** Never run `npm`/`pnpm`. All frontend
  commands run from `web/`.
- **Primary verification gate is `bunx tsc --noEmit`** (not a production
  build). **Never run `bun run build` while `bun run dev` is running** — it
  corrupts `.next/`. This plan needs neither.
- Tests are **vitest** (`bun run test` → `vitest run`), files under
  `web/lib/__tests__/`. Pure-logic style: import the unit, assert on its
  output (see `predict.test.ts`). Server-only modules are made importable under
  vitest by mocking `"server-only"` with `vi.mock("server-only", () => ({}))`
  (see `memwalAuth.test.ts:5`).
- This is a **permissionless** platform: no issuer/buyer role split. This plan
  adds no auth/role gate — it is purely defensive hardening of an existing
  unauthenticated route. Do not introduce any gating.

## Commands you will need

| Purpose   | Command (run from `web/`)        | Expected on success            |
|-----------|----------------------------------|--------------------------------|
| Install   | `bun install`                    | exit 0                         |
| Typecheck | `bunx tsc --noEmit`              | exit 0, no output              |
| Tests     | `bun run test`                   | all files pass                 |
| Tests (1) | `bunx vitest run lib/__tests__/copilot.test.ts` | new file passes |
| Lint      | `bun run lint`                   | exit 0, no errors              |

(Verified against `web/package.json`: `"test": "vitest run"`, `"lint": "eslint ."`.)

## Suggested executor toolkit

- None required. This is a small, self-contained TypeScript edit plus one
  vitest file. Do not pull in new dependencies.

## Scope

**In scope** (the only files you should modify or create):

- `web/app/api/copilot/route.ts` — edit (add a message-content clamp; replace
  the two raw `error` returns with a generic code + server-side log).
- `web/lib/__tests__/copilot.test.ts` — create (unit test for the clamp).

**Out of scope** (do NOT touch, even though they look related):

- `web/app/api/create-assist/route.ts` — already correct; it is the exemplar,
  not a target.
- `web/components/screens/CopilotPanel.tsx` — the client; it already ignores
  `error` and reads only `reply`. Changing it is unnecessary and risks the UI.
- `web/lib/rateLimit.ts` — unrelated; the rate-limit behavior is fine.
- `web/lib/config.ts` and `web/lib/moveErrors.ts` — `humanizeError`/
  `SPONSORED_TARGETS` are for **Move** aborts and on-chain targets. This is an
  HTTP route error string, not a `MoveAbort`, so it does **not** belong in
  `moveErrors.ts`. Do not add anything there.
- The `MAX_BODY_BYTES` (32 KB) cap, the rate limiter, `sanitizeEvent`, and the
  `fallback`/`systemPrompt` text — leave behavior unchanged.
- Response shape for the success/no-key paths — `{ reply, sourced }` must stay
  exactly as is.

## Git workflow

- Branch off `main`: `git checkout -b advisor/006-copilot-route-hardening`
- Commit style: conventional commits (matches `git log`, e.g.
  `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
  Suggested message:
  `fix(copilot): stop upstream error leakage and clamp message content [security]`
- Commit the route edit and the test together (one logical unit) or as two
  commits — either is fine.
- Do **NOT** push or open a PR unless the operator explicitly asked. (Repo flow
  is issue → branch → PR, and the `gh` CLI may hang here.)

## Steps

### Step 1: Add a message-content clamp constant and a sanitizer for messages

In `web/app/api/copilot/route.ts`, add a max-length constant for chat content
next to the existing `MAX_EV_STR_LEN`, and a small helper that whitelists each
incoming message to `{ role, content }` with `content` length-clamped. Place
the constant right after `MAX_EV_STR_LEN` (line 84) and the helper near
`sanitizeEvent`.

Target shape (pick a clamp generous for real chat turns but far below the
32 KB body cap — `2000` chars is recommended; document the choice in a
comment, mirroring the `MAX_EV_STR_LEN` comment):

```ts
// Each chat message's content is clamped to bound the prompt-injection blast
// radius and token cost per turn (the event-context strings are clamped the
// same way via MAX_EV_STR_LEN). The 32 KB whole-body cap is a coarse outer
// bound; this is the per-message bound.
const MAX_MSG_CONTENT_LEN = 2000;

// Whitelist each incoming chat turn into a fresh { role, content } object,
// dropping malformed entries and clamping content length. Mirrors the
// coerce-into-a-fresh-object posture of sanitizeEvent().
function sanitizeMessages(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    out.push({ role, content: content.slice(0, MAX_MSG_CONTENT_LEN) });
  }
  return out;
}
```

Then change the messages line (currently line 174) to use it, preserving the
last-12 slice:

```ts
  const messages = sanitizeMessages(body.messages).slice(-12);
```

Leave `fallback(ev, messages)` calls untouched — they already accept `Msg[]`
and only read the last message's `content`.

**Verify**: from `web/`, `bunx tsc --noEmit` → exits 0 with no output.

### Step 2: Replace the two raw `error` returns with a generic code + server-side log

In the Groq block of `web/app/api/copilot/route.ts` (currently lines 203-211),
stop returning raw upstream/exception text to the client. Log the detail
server-side and return a fixed, generic `error` code instead.

Define a stable code constant near the other limits (top of file is fine):

```ts
// Stable, generic client-facing error code. Distinguishes a fallback caused by
// an upstream/runtime error from a fallback caused by no GROQ_API_KEY, WITHOUT
// leaking upstream detail. Detail is logged server-side only.
const ERR_UPSTREAM = "copilot_upstream_error";
```

Rewrite the `!r.ok` branch to read and log the body but not return it:

```ts
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error(`[copilot] groq upstream ${r.status}: ${detail.slice(0, 500)}`);
      return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: ERR_UPSTREAM });
    }
```

Rewrite the `catch` to log the exception but return only the generic code:

```ts
  } catch (e: unknown) {
    console.error("[copilot] groq request failed:", e);
    return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: ERR_UPSTREAM });
  }
```

Notes:
- Keep `sourced: "fallback"` and the `reply: fallback(...)` exactly as before —
  the user-visible answer is unchanged.
- The `error` value MUST be the constant `ERR_UPSTREAM` — never `await r.text()`,
  never `String(e)`, never any interpolation of upstream/exception text.
- `console.error` is the server-side log (matches the repo's plain-console
  posture; no logger dependency exists to import).

**Verify**: from `web/`, run:
`grep -n "await r.text()\|String(e)" app/api/copilot/route.ts`
→ the only match is the `const detail = await r.text().catch(...)` line inside
the `!r.ok` branch; there must be **no** `error: await r.text()` and **no**
`String(e)` anywhere. Confirm with:
`grep -n "error:" app/api/copilot/route.ts` → every `error:` value is either a
`413`/`400`/`429` validation message (the pre-existing byte-cap/JSON/rate-limit
returns) or `ERR_UPSTREAM` — none is `await r.text()` or `String(e)`.

### Step 3: Add a unit test for the message clamp

Because `sanitizeMessages` is module-private (like the other helpers in this
route), the cleanest test exercises it through the only seam available without
restructuring: **export `sanitizeMessages` and the `MAX_MSG_CONTENT_LEN`
constant** from the route module so the test can import them. Add `export` to
both (route handlers can have extra named exports alongside `POST`; this does
not change Next.js routing).

Create `web/lib/__tests__/copilot.test.ts`. Model the structure on
`web/lib/__tests__/predict.test.ts` (plain `describe`/`it`/`expect`, no mocks
needed — `sanitizeMessages` touches no `server-only` import, so no `vi.mock` is
required). Cover:

1. **Happy path**: a well-formed `[{role:"user",content:"hi"}]` passes through
   unchanged.
2. **The clamp (the regression this plan fixes)**: a message with
   `content` of length `MAX_MSG_CONTENT_LEN + 100` is truncated to exactly
   `MAX_MSG_CONTENT_LEN`.
3. **Malformed-entry rejection**: a non-string `content`, a bad `role`
   (e.g. `"system"`), and a non-object entry (`null`, `42`) are all dropped.
4. **Non-array input**: `sanitizeMessages(undefined)` and
   `sanitizeMessages("x")` return `[]`.

Test skeleton:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeMessages, MAX_MSG_CONTENT_LEN } from "../../app/api/copilot/route";

describe("sanitizeMessages (copilot)", () => {
  it("passes a well-formed turn through unchanged", () => {
    expect(sanitizeMessages([{ role: "user", content: "hi" }])).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("clamps content to MAX_MSG_CONTENT_LEN", () => {
    const long = "x".repeat(MAX_MSG_CONTENT_LEN + 100);
    const [m] = sanitizeMessages([{ role: "assistant", content: long }]);
    expect(m.content.length).toBe(MAX_MSG_CONTENT_LEN);
  });

  it("drops malformed entries (bad role, non-string content, non-object)", () => {
    expect(
      sanitizeMessages([
        { role: "system", content: "no" },
        { role: "user", content: 42 },
        null,
        7,
        { role: "user", content: "ok" },
      ]),
    ).toEqual([{ role: "user", content: "ok" }]);
  });

  it("returns [] for non-array input", () => {
    expect(sanitizeMessages(undefined)).toEqual([]);
    expect(sanitizeMessages("x")).toEqual([]);
  });
});
```

If importing from `../../app/api/copilot/route` fails to resolve under vitest
(path/alias issue), that is a STOP condition — see STOP conditions; do not
work around it by deleting the test.

**Verify**: from `web/`, run `bunx vitest run lib/__tests__/copilot.test.ts`
→ all 4 tests pass.

### Step 4: Full verification sweep

Run the whole gate from `web/`:

```
bunx tsc --noEmit   # exit 0, no output
bun run lint        # exit 0
bun run test        # all files pass, including the new copilot.test.ts
```

**Verify**: all three exit 0; the test summary lists `copilot.test.ts` among
passing files and shows no failures.

## Test plan

- **New file**: `web/lib/__tests__/copilot.test.ts`, covering `sanitizeMessages`:
  happy path, the content-length clamp (the regression), malformed-entry drops
  (bad role / non-string content / non-object), and non-array input → `[]`.
  Modeled structurally on `web/lib/__tests__/predict.test.ts` (pure-logic
  vitest, no mocks).
- **Error-leak fix is verified by grep**, not a unit test: the two leak sites
  are removed (Step 2 Verify). A unit test of the error branch would require
  mocking global `fetch` and is out of proportion to a 2-line swallow change;
  the grep gate is the contract here.
- **Verification**: `bun run test` → all pass including the 4 new tests;
  `grep` gates from Step 2 confirm no raw `error` text remains.

## Done criteria

Machine-checkable. ALL must hold (run from `web/`):

- [ ] `bunx tsc --noEmit` exits 0 with no output.
- [ ] `bun run lint` exits 0 with no errors.
- [ ] `bun run test` exits 0; `web/lib/__tests__/copilot.test.ts` exists and its
      4 tests pass.
- [ ] `grep -rn "error: await r.text()\|error: String(e)\|String(e)" app/api/copilot/route.ts`
      returns **no** matches.
- [ ] `grep -n "ERR_UPSTREAM\|MAX_MSG_CONTENT_LEN\|sanitizeMessages" app/api/copilot/route.ts`
      shows all three present (constant defined, clamp constant defined, helper
      defined + used on the messages line).
- [ ] `grep -n "console.error" app/api/copilot/route.ts` shows the two
      server-side log lines (upstream non-2xx and catch).
- [ ] `git status --porcelain` shows ONLY `web/app/api/copilot/route.ts` (M) and
      `web/lib/__tests__/copilot.test.ts` (??) changed/added — no other files.
- [ ] `plans/README.md` status row for plan 006 updated to DONE (unless a
      reviewer owns the index).

## STOP conditions

Stop and report back (do not improvise) if:

- The live `web/app/api/copilot/route.ts` does not match the "Current state"
  excerpts — specifically if the two `error:` returns (currently lines 204 and
  210) or the `const messages = ... .slice(-12)` line (174) differ from what is
  quoted. The codebase has drifted; re-confirm the finding before editing.
- The test import `from "../../app/api/copilot/route"` cannot be resolved by
  vitest, OR importing it pulls in a `server-only` throw (it should not — this
  route does not `import "server-only"`, unlike `rateLimit.ts`). If vitest
  errors on the import, report it rather than restructuring the route into a
  separate helper file (that would expand scope).
- `bun run lint` flags the extra named exports (`sanitizeMessages`,
  `MAX_MSG_CONTENT_LEN`) on a route file as disallowed. Report it; do not
  silence the rule or move code into `lib/` without sign-off.
- Any verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (especially
  `CopilotPanel.tsx`, `moveErrors.ts`, or `config.ts`).
- You discover the assumption "the only client caller reads only `reply` and
  ignores `error`" is false (e.g. another caller of `/api/copilot` now renders
  `error`). Re-grep `api/copilot` across the repo if unsure.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Keep `error` as a stable code, never free text.** If future telemetry needs
  to distinguish upstream failure modes (quota vs. 5xx vs. timeout), add more
  fixed codes (e.g. `copilot_upstream_429`) — never interpolate `r.text()` or
  the exception into the client response.
- **`create-assist` is the sibling.** If you harden one route's error/clamp
  posture, mirror it in the other so they stay consistent (create-assist
  currently returns NO `error` field on fallback; consider giving it the same
  generic code in a follow-up — explicitly deferred here to keep this plan
  single-file and low-risk).
- **`MAX_MSG_CONTENT_LEN` interacts with the 12-turn slice and the 32 KB body
  cap.** If the chat UI ever sends longer turns or more history, revisit all
  three bounds together so the total prompt stays sane.
- A reviewer should scrutinize: (1) that no code path returns raw upstream text;
  (2) that the success and no-key response shapes (`{ reply, sourced }`) are
  byte-for-byte unchanged; (3) that the new exports don't break Next.js route
  handling (typecheck + the route still responds — a quick manual `bun run dev`
  POST to `/api/copilot` is optional, not required by the gates).
- **Deferred out of scope**: rate-limit / replay hardening (tracked separately
  via the KV-store work referenced in `web/lib/rateLimit.ts` header) and any
  change to create-assist.
