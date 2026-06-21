# Plan 002: Add abuse controls and stop error leakage on the gasless sponsor routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, skip that — do
> NOT create it; just report completion.)
>
> **Drift check (run first)**:
> `git diff --stat 957206b..HEAD -- web/app/api/sponsor/route.ts web/app/api/sponsor/execute/route.ts web/app/api/copilot/route.ts web/lib/rateLimit.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (relates to plan 003 — durable cross-instance rate limiting)
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: (none)

## Why this matters

The two gasless-onboarding API routes — `web/app/api/sponsor/route.ts` (create a
sponsored transaction) and `web/app/api/sponsor/execute/route.ts` (execute it) —
have **no auth, no rate limit, and no request-body size cap**. The Enoki
allowlist (`SPONSORED_TARGETS` in `web/lib/config.ts`) restricts *which* Move
calls can be sponsored, but not *how many*: an unauthenticated attacker can loop
`POST /api/sponsor` to make the Enoki sponsor wallet pay gas for unbounded junk
transactions, drain the gas budget, and take gasless onboarding offline for
every real user. Both routes also leak upstream Enoki detail to the
unauthenticated client (`{ error: e.message, details: e.errors }`), exposing
internal error shapes. This plan adds a per-IP rate limit and a body-size cap to
both routes (reusing the existing, proven helper from
`web/app/api/copilot/route.ts`) and replaces the leaky `catch` with a generic
client message while logging full detail server-side only. It is a small,
self-contained hardening change with no behavior change for legitimate clients.

## Current state

All paths below are absolute-from-repo-root; the Next.js app lives in `web/`.
Run all frontend commands from `web/`. **The repo has two trees** — the Move
package at the repo root and the Next.js app in `web/`; this plan touches only
`web/`.

### Files in scope

- `web/app/api/sponsor/route.ts` — creates the Enoki-sponsored tx. **No rate
  limit, no body cap; leaks `e.message`/`e.errors`.** (57 lines.)
- `web/app/api/sponsor/execute/route.ts` — executes the user-signed sponsored
  tx. **Same three gaps.** (45 lines.)

### Reference file (the pattern to copy — DO NOT modify it)

- `web/app/api/copilot/route.ts` — an unauthenticated, cost-amplifying route
  that *already* implements exactly the body-cap + per-IP rate-limit pattern this
  plan adds. Copy its approach verbatim.

### Shared helper (already exists — DO NOT modify it)

- `web/lib/rateLimit.ts` — exports `rateLimit(key, limit, windowMs)` and
  `clientIpFromHeaders(headers)`. Per-process fixed-window counter; `server-only`.

### Excerpt — `web/app/api/sponsor/route.ts` (the file to harden)

The leaky catch and the unguarded `req.json()` are the targets:

```ts
// web/app/api/sponsor/route.ts:11-35  (current — no body cap, no rate limit)
export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) { /* ... 500 ... */ }

  let body: { transactionKindBytes?: string; sender?: string };
  try {
    body = await req.json();              // <-- no size cap before this
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { transactionKindBytes, sender } = body;
  if (!transactionKindBytes || !sender) { /* ... 400 ... */ }
```

```ts
// web/app/api/sponsor/route.ts:48-57  (current — LEAKS upstream detail)
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; errors?: unknown };
    return Response.json(
      {
        error: e.message ?? "Enoki createSponsoredTransaction failed",
        details: e.errors,
      },
      { status: e.status ?? 500 },
    );
  }
```

Imports at the top of that file are currently only:

```ts
// web/app/api/sponsor/route.ts:6-7
import { EnokiClient } from "@mysten/enoki";
import { NETWORK, SPONSORED_TARGETS } from "@/lib/config";
```

### Excerpt — `web/app/api/sponsor/execute/route.ts` (the second file to harden)

```ts
// web/app/api/sponsor/execute/route.ts:8-29  (current — no body cap, no rate limit)
export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) { /* ... 500 ... */ }

  let body: { digest?: string; signature?: string };
  try {
    body = await req.json();              // <-- no size cap before this
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { digest, signature } = body;
  if (!digest || !signature) { /* ... 400 ... */ }
```

```ts
// web/app/api/sponsor/execute/route.ts:35-44  (current — LEAKS upstream detail)
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; errors?: unknown };
    return Response.json(
      {
        error: e.message ?? "Enoki executeSponsoredTransaction failed",
        details: e.errors,
      },
      { status: e.status ?? 500 },
    );
  }
```

Its only import is `import { EnokiClient } from "@mysten/enoki";` (line 4).

### Exemplar to mirror — `web/app/api/copilot/route.ts`

This is the **canonical pattern**. Reproduce its body-cap + rate-limit shape
exactly (only the constants and the `rateLimit` key string change).

```ts
// web/app/api/copilot/route.ts:5  (import)
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";
```

```ts
// web/app/api/copilot/route.ts:76-80  (constants)
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
const MAX_BODY_BYTES = 32 * 1024;
```

```ts
// web/app/api/copilot/route.ts:130-168  (body cap, then rate limit)
export async function POST(req: Request) {
  // Byte cap the raw payload BEFORE parsing (413 on oversize). A Content-Length
  // header lets us short-circuit; otherwise we measure the decoded body.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  let body: { /* ... */ };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Per-IP rate limit before any LLM fan-out (429 + Retry-After on breach).
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`copilot:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }
  // ... rest of handler
}
```

Note the precedent reads the body once with `req.text()` then `JSON.parse(...)`
(NOT `req.json()`), so the byte length can be measured. The sponsor routes
currently use `req.json()`; this plan switches them to the `req.text()` +
`JSON.parse()` shape to add the cap.

### Helper contract — `web/lib/rateLimit.ts`

```ts
// web/lib/rateLimit.ts:47-74  (signature + return shape)
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult { /* fixed-window; returns { ok, retryAfterSec, limit, remaining } */ }
```

```ts
// web/lib/rateLimit.ts:81-91  (best-effort client IP)
export function clientIpFromHeaders(headers: Headers): string { /* x-forwarded-for → x-real-ip → "unknown" */ }
```

### Conventions that apply here

- **Package manager is `bun` ONLY** — never `npm`/`pnpm`. Run frontend commands
  from `web/`.
- **Primary verification gate is `bunx tsc --noEmit`** (run from `web/`).
  Do NOT use `bun run build` to verify, and **never run `bun run build` while a
  `bun run dev` server is running** — it corrupts `.next/`.
- **Permissionless model:** do NOT add any auth/role gate to these routes. The
  fix is rate limiting + body cap + a non-leaky error, NOT login. (The proper
  longer-term proof-of-control gate is a v2 follow-up; see Maintenance notes.)
- `@/lib/...` is the path alias for `web/lib/...` (`tsconfig.json` `paths`).
- Match the existing route style: terse top-of-file comment, `Response.json`,
  `export const dynamic = "force-dynamic";`.

### Important context discovered during planning (read this)

- **There are NO route-handler (HTTP) tests in this repo.** Every test under
  `web/lib/__tests__/` imports pure `lib/` modules (e.g.
  `web/lib/__tests__/sponsoredTargets.test.ts` imports from `../config`). The
  exemplar `copilot/route.ts` ships **with no test of its own.** Therefore this
  plan's automated verification is `tsc` + `lint` + `grep` assertions plus a
  **manual curl smoke test**; adding a Next-route HTTP test harness is OUT of
  scope (see Scope). Do not try to `import` the route's `POST` into a vitest file
  unless you can do so without adding new dev dependencies or config — if it is
  not trivial, skip it (the optional test in Step 4 covers the helper-level
  logic instead).
- **Drift note:** this plan was written against working-tree commit `957206b`
  (clean tree, 2026-06-20). The four cited files matched their excerpts exactly
  at that commit.

## Commands you will need

| Purpose            | Command (run from `web/`)                                  | Expected on success                |
|--------------------|------------------------------------------------------------|------------------------------------|
| Install            | `bun install`                                              | exit 0                             |
| Typecheck (GATE)   | `bunx tsc --noEmit`                                        | exit 0, no errors                  |
| Lint               | `bun run lint`                                             | exit 0                             |
| Unit tests         | `bun run test`                                             | all pass                           |
| Single test file   | `bun run test web/lib/__tests__/<file>`                    | that file's tests pass             |
| Manual smoke       | see Step 5 (`curl` burst against `bun run dev`)            | 429 after the limit; no `details`  |

(`bun run test` is `vitest run`; `package.json` has no `typecheck` script — the
gate is `bunx tsc --noEmit`, per project convention.)

## Scope

**In scope** (the only files you should modify):
- `web/app/api/sponsor/route.ts`
- `web/app/api/sponsor/execute/route.ts`
- `web/lib/__tests__/sponsorGuards.test.ts` (**create — OPTIONAL**, only if Step 4
  is feasible without new deps/config; otherwise omit it)

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/rateLimit.ts` — reuse as-is; making it durable across serverless
  instances is plan 003's job, not this one. Do not change its signature.
- `web/app/api/copilot/route.ts` and `web/app/api/memory/**` — reference only.
- `web/lib/config.ts` / `SPONSORED_TARGETS` — the allowlist is correct; this plan
  is about volume + error hygiene, not which targets are sponsorable.
- The client-side submit flow (`web/lib/hooks.ts`, screens) — no client change is
  needed; legitimate single requests are unaffected.
- Adding auth / proof-of-control signatures to these routes — deferred to v2
  (Maintenance notes). Adding a Next-route HTTP test harness or new test deps.

## Git workflow

- Branch: `advisor/002-sponsor-route-hardening` (create from current HEAD).
- Conventional-commit message, e.g.
  `security(sponsor): add per-IP rate limit + body cap, stop error leakage`.
  (Repo style — recent log shows `feat(forum): ...`, `ci: ...`.)
- Commit per logical unit is fine (e.g. one commit for the route changes, one
  for the optional test). Do NOT push and do NOT open a PR unless the operator
  explicitly tells you to. (`gh` CLI may hang in this environment.)

## Steps

### Step 1: Harden `web/app/api/sponsor/route.ts`

1. Add the rate-limit import alongside the existing imports:
   ```ts
   import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";
   ```
2. Add module-level constants (place them after the imports / before `POST`):
   ```ts
   // Per-IP rate limit + body cap: this route is UNAUTHENTICATED and makes the
   // Enoki sponsor wallet pay gas, so it is a gas-drain surface. Mirrors the
   // /api/copilot limiter. NOTE: per-process only — see plan 003 for a durable
   // KV-backed limiter across serverless instances.
   const RL_LIMIT = 20;
   const RL_WINDOW_MS = 60_000;
   // transactionKindBytes is base64 of a tx kind; 128 KB is generous and bounds
   // junk-payload cost before we call Enoki.
   const MAX_BODY_BYTES = 128 * 1024;
   ```
3. At the very start of `POST`, **before** the `ENOKI_PRIVATE_API_KEY` check is
   fine, but the body-cap + rate-limit must run **before `req.json()`**. Replace
   the current `req.json()` block with the copilot-style sequence: Content-Length
   short-circuit → `req.text()` → decoded-byte cap → `JSON.parse` → per-IP
   `rateLimit("sponsor:ip:" + ip, ...)`. Use these exact response shapes:
   - oversize → `Response.json({ error: \`body exceeds ${MAX_BODY_BYTES} bytes\` }, { status: 413 })`
   - bad JSON → keep `{ error: "Invalid JSON body" }`, `{ status: 400 }`
   - rate-limited → `Response.json({ error: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } })`

   Target shape for the top of `POST` (preserve the existing
   `transactionKindBytes`/`sender` validation that follows):
   ```ts
   export async function POST(req: Request) {
     const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
     if (!apiKey) { /* keep existing 500 */ }

     const declaredLen = Number(req.headers.get("content-length"));
     if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
       return Response.json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
     }
     let rawBody: string;
     try { rawBody = await req.text(); }
     catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
     if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
       return Response.json({ error: `body exceeds ${MAX_BODY_BYTES} bytes` }, { status: 413 });
     }

     const ip = clientIpFromHeaders(req.headers);
     const rl = rateLimit(`sponsor:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
     if (!rl.ok) {
       return Response.json(
         { error: "Rate limit exceeded" },
         { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
       );
     }

     let body: { transactionKindBytes?: string; sender?: string };
     try { body = JSON.parse(rawBody); }
     catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
     // ... existing transactionKindBytes/sender validation unchanged ...
   ```
4. Replace the leaky `catch` (lines 48-57) so it logs full detail server-side
   and returns a generic message **without** `e.message` or `e.errors`:
   ```ts
   } catch (err: unknown) {
     const e = err as { message?: string; status?: number; errors?: unknown };
     // Log full upstream detail server-side ONLY; never echo it to the client.
     console.error("[sponsor] createSponsoredTransaction failed", {
       status: e.status, message: e.message, errors: e.errors,
     });
     const status = e.status ?? 500;
     return Response.json(
       { error: "Could not create sponsored transaction. Please try again." },
       { status },
     );
   }
   ```
   (Preserving the upstream `status` code is fine — it is not sensitive. Do NOT
   include `details`/`e.errors`/`e.message` in the response body.)

**Verify**:
- `cd web && bunx tsc --noEmit` → exit 0, no errors.
- `cd web && grep -n "details: e.errors" app/api/sponsor/route.ts` → **no output** (exit 1).
- `cd web && grep -n "rateLimit(\`sponsor:ip:" app/api/sponsor/route.ts` → matches one line.

### Step 2: Harden `web/app/api/sponsor/execute/route.ts`

Apply the identical pattern. This route's body is tiny (`{ digest, signature }`),
so use a smaller cap.

1. Add `import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";`.
2. Add constants:
   ```ts
   const RL_LIMIT = 30;
   const RL_WINDOW_MS = 60_000;
   // Body is just { digest, signature } — both short strings. 16 KB is ample.
   const MAX_BODY_BYTES = 16 * 1024;
   ```
   (A slightly higher request count than `/api/sponsor` is fine: execute is the
   second leg of a flow whose first leg is already limited. Keep it simple — one
   per-IP bucket keyed `execute:ip:${ip}`.)
3. Insert the same Content-Length → `req.text()` → byte-cap → `rateLimit("execute:ip:" + ip, ...)` → `JSON.parse` sequence at the top of `POST`, before the
   current `req.json()` block, preserving the existing `digest`/`signature`
   validation.
4. Replace the leaky `catch` (lines 35-44) with the same server-only-log +
   generic message pattern, message:
   `"Could not execute sponsored transaction. Please try again."`, log prefix
   `"[sponsor/execute] executeSponsoredTransaction failed"`.

**Verify**:
- `cd web && bunx tsc --noEmit` → exit 0.
- `cd web && grep -n "details: e.errors" app/api/sponsor/execute/route.ts` → **no output**.
- `cd web && grep -n "rateLimit(\`execute:ip:" app/api/sponsor/execute/route.ts` → one match.

### Step 3: Lint + full typecheck + existing tests still green

**Verify**:
- `cd web && bun run lint` → exit 0.
- `cd web && bunx tsc --noEmit` → exit 0.
- `cd web && bun run test` → all pass (no test was removed; existing count holds).

### Step 4 (OPTIONAL — only if trivial): add a helper-level unit test

There is **no HTTP route-test harness** in this repo, and adding one is out of
scope. If — and only if — you can do it with the existing vitest setup and no
new dependencies, add `web/lib/__tests__/sponsorGuards.test.ts` that pins the
*limiter keying + window behavior* the routes rely on, using the already-pure
`rateLimit` export. Model the file structure on
`web/lib/__tests__/sponsoredTargets.test.ts` (same `import { describe, it, expect } from "vitest";` header). Suggested cases:

- `rateLimit("sponsor:ip:1.2.3.4", 2, 60_000)` returns `ok: true` twice then
  `ok: false` with `retryAfterSec >= 1` on the third call (same key).
- Two different keys (`sponsor:ip:a` vs `sponsor:ip:b`) do not share a budget.

Do NOT attempt to import the route `POST` handler or stub `EnokiClient`; if that
is the only way to test, **skip this step entirely** (the manual smoke in Step 5
plus the `grep`/`tsc` gates are the real verification).

**Verify** (only if the file was created):
- `cd web && bun run test web/lib/__tests__/sponsorGuards.test.ts` → all new tests pass.
- `cd web && bunx tsc --noEmit` → exit 0.

### Step 5: Manual smoke test (rate limit fires; no leakage)

This confirms runtime behavior the static checks can't.

1. In one terminal: `cd web && bun run dev` (leave it running; do NOT run
   `bun run build` anywhere while this is up).
2. In a second terminal, send a burst that exceeds `RL_LIMIT` (20) for the
   sponsor route. With no `ENOKI_PRIVATE_API_KEY` set the handler returns 500
   *after* passing the rate gate, which is fine — we only care that requests
   start returning **429** once the per-IP window is exhausted:
   ```bash
   for i in $(seq 1 25); do \
     curl -s -o /dev/null -w "%{http_code}\n" \
       -X POST http://localhost:3000/api/sponsor \
       -H 'content-type: application/json' \
       -H 'x-forwarded-for: 9.9.9.9' \
       -d '{"transactionKindBytes":"AA==","sender":"0x1"}'; \
   done | sort | uniq -c
   ```
   **Expected**: the output includes a line for `429` (the later requests in the
   burst). (Earlier requests will be `400`/`500` depending on env — that is
   acceptable; the presence of `429` proves the limiter engaged.)
3. Confirm the body cap returns 413:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" \
     -X POST http://localhost:3000/api/sponsor \
     -H 'content-type: application/json' -H 'x-forwarded-for: 8.8.8.8' \
     --data-binary @<(head -c 200000 /dev/zero | tr '\0' 'a')
   ```
   **Expected**: `413`.
4. Confirm no upstream `details` leaks. Trigger the error path (no API key, or a
   malformed `transactionKindBytes` with a key set) and inspect the JSON body:
   ```bash
   curl -s -X POST http://localhost:3000/api/sponsor \
     -H 'content-type: application/json' -H 'x-forwarded-for: 7.7.7.7' \
     -d '{"transactionKindBytes":"AA==","sender":"0x1"}'
   ```
   **Expected**: response body has an `error` string and **no `details` key**.
5. Stop the dev server (Ctrl-C). If the dev bundle ever breaks during this:
   `rm -rf web/.next` and restart.

**Verify**: step 2 shows `429` in the histogram; step 3 returns `413`; step 4's
JSON has no `details` field.

## Test plan

- **Automated gates (required):** `bunx tsc --noEmit`, `bun run lint`,
  `bun run test` — all from `web/`, all exit 0 / pass. These do not exercise HTTP
  behavior (no route-test harness exists in this repo), so they are paired with:
- **Static assertions (required):** the `grep` checks in Steps 1–2 prove the
  leaky `details: e.errors` is gone from both routes and the new
  `rateLimit(...)` keys are present.
- **Manual smoke (required):** Step 5 proves at runtime that (a) a per-IP burst
  yields `429`, (b) an oversized body yields `413`, and (c) the error response
  carries no `details`/upstream message.
- **Optional unit test:** `web/lib/__tests__/sponsorGuards.test.ts` (Step 4),
  structured like `web/lib/__tests__/sponsoredTargets.test.ts`, asserting the
  `rateLimit` window + per-key isolation the routes depend on. Skip if it cannot
  be added with the existing vitest config and zero new deps.

## Done criteria

Machine-checkable. ALL must hold (run from `web/`):

- [ ] `bunx tsc --noEmit` exits 0 with no errors.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` passes (and, if Step 4 was done, `web/lib/__tests__/sponsorGuards.test.ts` exists and passes).
- [ ] `grep -rn "details: e.errors" app/api/sponsor` returns **no matches** (the leak is removed from both routes).
- [ ] `grep -n "rateLimit(\`sponsor:ip:" app/api/sponsor/route.ts` returns one match.
- [ ] `grep -n "rateLimit(\`execute:ip:" app/api/sponsor/execute/route.ts` returns one match.
- [ ] `grep -c "MAX_BODY_BYTES" app/api/sponsor/route.ts app/api/sponsor/execute/route.ts` shows each file references it (>= 1 each).
- [ ] Manual smoke (Step 5): a 25-request burst to `/api/sponsor` produces at least one `429`; an oversized body returns `413`; the error response body has no `details` key.
- [ ] `git status --porcelain` shows only the in-scope files changed (the two routes, and optionally the one new test file) — nothing else.
- [ ] `plans/README.md` status row updated to DONE (skip only if that file does not exist).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift-check `git diff --stat 957206b..HEAD -- <in-scope paths>` shows any
  in-scope file changed, AND the live code no longer matches the "Current state"
  excerpts (e.g. the `catch` block already returns a generic message, or a rate
  limit was already added). The codebase has drifted; report what you found.
- `web/lib/rateLimit.ts` no longer exports `rateLimit(key, limit, windowMs)` or
  `clientIpFromHeaders(headers)` with the signatures in "Current state" — the
  helper you depend on changed; do not refactor it (out of scope).
- `bunx tsc --noEmit` or `bun run lint` fails twice after a reasonable fix
  attempt.
- The manual smoke (Step 5) never produces a `429` even at 25+ requests — the
  limiter is not engaging; report rather than tuning limits blindly.
- The fix appears to require touching any out-of-scope file (e.g. the client
  submit flow, `config.ts`, or `rateLimit.ts`).
- You find that adding the optional test (Step 4) would require new dev
  dependencies or a new vitest/route-test harness — skip the test and proceed;
  do NOT add the harness.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **This limiter is per-process / per-instance only.** On a multi-instance or
  serverless deployment (e.g. Vercel) each lambda has its own in-memory bucket,
  so the effective global limit is `RL_LIMIT × instances`. `web/lib/rateLimit.ts`
  documents this and is the clean swap seam. **Plan 003** makes the limiter
  durable across instances with a shared KV store (Vercel KV / Upstash Redis);
  when it lands, these routes need no change — only `rateLimit`'s body is swapped.
- **The proper longer-term gate is proof-of-control, not just rate limiting.**
  The memory routes already require the caller to sign a canonical challenge as a
  personal message (`web/lib/memwalAuth.ts` + the client-safe builder in
  `web/lib/memwalChallenge.ts`; see `web/app/api/memory/analyze/route.ts` for the
  verify-then-rate-limit ordering). A v2 follow-up for the sponsor routes should
  reuse that challenge to require a signature from `sender` before sponsoring,
  plus a per-target KV quota (e.g. tighter budgets for `create_event` /
  `market::buy` than for `claim_free`). That is deliberately deferred here to
  keep this change small (Effort S) and the permissionless onboarding UX intact.
- **No secret values are involved in this change.** It references the env var
  *name* `ENOKI_PRIVATE_API_KEY` only (a server-only key — never
  `NEXT_PUBLIC_`-prefixed). If that key was ever exposed in logs by the old
  leaky `catch` output (it was not echoed to clients, only `e.errors`/`e.message`
  were), consider rotating it as a precaution.
- **What a reviewer should scrutinize:** that the body cap runs *before*
  `req.text()`/`JSON.parse`; that the rate-limit check runs *before* the
  `EnokiClient` call (so a blocked request never costs gas); and that **no**
  `e.errors`/`e.message`/`details` field remains in either route's response body.
- **If `SPONSORED_TARGETS` grows** (new sponsored entry functions in
  `web/lib/config.ts`), revisit whether per-target quotas (the v2 item above) are
  warranted before the surface gets large.
