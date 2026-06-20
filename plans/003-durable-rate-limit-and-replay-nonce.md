# Plan 003: Back the rate limiter with a shared store and add a one-time nonce to the memory auth challenge

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (create it if it does not exist — a template is in the
> Done criteria section) unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: from the repo root run
> `git diff --stat 957206b..HEAD -- web/lib/rateLimit.ts web/lib/memwalAuth.ts web/lib/memwalChallenge.ts web/lib/memoryClient.ts web/app/api/memory web/app/api/create-assist web/app/api/copilot`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts below against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20

> **Planning-note (drift the executor should know)**: this plan was requested
> against SHA `9b169c0`, but the live `HEAD` at authoring time was `957206b`
> (one commit ahead — `feat(forum): organizer admin … [#37]`). The diff between
> those two SHAs touched ONLY `web/lib/config.ts` (+7/-3, forum-related) and NOT
> any file in this plan's scope. All "Current state" excerpts below were copied
> from the live tree at `957206b`, so they are accurate. The drift-check command
> above is pinned to `957206b` for that reason.

## Why this matters

The `/api/memory/*` and `/api/copilot` + `/api/create-assist` routes fan out to
an LLM and a Walrus/SEAL relayer — the costly, externally-billed edge of the
app. Their **only** cost gate is `web/lib/rateLimit.ts`, which counts requests in
a **module-level `Map` that lives in one process's memory**. On Vercel/serverless
every cold lambda instance starts with an empty Map, so the effective limit is
`configured-limit × instance-count` — the cap silently dissolves under load or a
burst, which is exactly when an attacker (or a runaway client) drives LLM/relayer
spend. Separately, the memory auth challenge (`web/lib/memwalAuth.ts`) validates
only a 5-minute time window with **no consumed-nonce check**, so a single captured
signed envelope can be replayed to `recall`/`remember`/`analyze`/`create-assist`
for up to ~5 minutes. Both problems are solved by **one shared key-value store**:
a KV-backed sliding-window limiter that survives across instances, plus a
one-time-use nonce keyed by the challenge hash. That is why they ship together.
When this lands, the rate cap is global (not per-instance) and a signed challenge
is single-use.

## Current state

Files in play (each with its role):

- `web/lib/rateLimit.ts` — the per-process limiter. Module-level `Map`, the
  `rateLimit()` seam, `clientIpFromHeaders()`, and the `rateLimitMemory()` helper.
- `web/lib/memwalAuth.ts` — server-side caller auth for `/api/memory/*`.
  `parseChallenge()` enforces only the time window; `verifyMemoryCaller()` is the
  single entry the routes call.
- `web/lib/memwalChallenge.ts` — client-safe challenge builder + the `MAX_AGE`
  constant. Imported by BOTH the browser and the server (must stay client-safe —
  no `server-only`, no heavy deps).
- `web/lib/memoryClient.ts` — the browser caller; builds + signs one fresh
  challenge per call. Embeds only owner + timestamp (no client-side nonce today).
- `web/app/api/memory/{analyze,recall,remember,status}/route.ts` — the consuming
  routes; `analyze` is the costliest (invokes the relayer LLM).
- `web/app/api/create-assist/route.ts`, `web/app/api/copilot/route.ts` — the
  other LLM routes; both call the raw `rateLimit()` per-IP.

### The per-process limiter and its self-documented limitation

`web/lib/rateLimit.ts:7-14` (module header — the seam is intentional):

```
// SCOPE / KNOWN LIMITATION: this is a per-process fixed-window counter. It is good
// enough for a single instance but is NOT robust across a multi-instance / serverless
// deployment (each lambda/worker has its own memory), and it cannot enforce a
// replay-nonce store for the auth challenge. Robust limiting AND replay protection
// both need a shared KV store (Vercel KV / Upstash Redis) — the SAME store ISSUES.md
// #17 calls for — so they should be implemented together. The `rateLimit(key)`
// function below is the clean seam: swap its body for a KV-backed sliding window
// (and add a nonce check in memwalAuth) when #17 lands; callers do not change.
```

`web/lib/rateLimit.ts:32` — the per-process store:

```
const buckets = new Map<string, Bucket>();
```

`web/lib/rateLimit.ts:43-74` — the seam to replace. **Its signature must not
change** (callers stay untouched):

```
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0, limit, remaining: limit - 1 };
  }
  ...
}
```

`web/lib/rateLimit.ts:81-91` — IP extraction trusts the **first** `x-forwarded-for`
entry, which a client can spoof unless a trusted proxy overwrites it:

```
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // First entry is the originating client; the rest are proxies.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "unknown";
}
```

`web/lib/rateLimit.ts:98-111` — the `rateLimitMemory` fan-out (two `rateLimit`
calls; both go through the seam, so a KV-backed seam fixes both automatically):

```
export function rateLimitMemory(
  route: string,
  identity: string,
  ip: string,
  opts: { limit: number; windowMs: number },
): RateLimitResult {
  const idResult = rateLimit(`mem:${route}:id:${identity}`, opts.limit, opts.windowMs);
  if (!idResult.ok) return idResult;
  return rateLimit(`mem:${route}:ip:${ip}`, opts.limit, opts.windowMs);
}
```

### Every caller of the seam (must keep working unchanged)

Confirmed call sites (output of
`grep -rn "rateLimitMemory\|rateLimit(" web/app web/lib | grep -v lib/rateLimit.ts`):

- `web/app/api/memory/analyze/route.ts:47` → `rateLimitMemory("analyze", owner, ip, { limit: 10, windowMs: 60_000 })`
- `web/app/api/memory/recall/route.ts:52` → `rateLimitMemory("recall", owner, ip, { limit: 60, windowMs: 60_000 })`
- `web/app/api/memory/remember/route.ts:45` → `rateLimitMemory("remember", owner, ip, { limit: 30, windowMs: 60_000 })`
- `web/app/api/create-assist/route.ts:189` → `rateLimit(\`create-assist:ip:${ip}\`, RL_LIMIT, RL_WINDOW_MS)` where `RL_LIMIT = 20`, `RL_WINDOW_MS = 60_000`
- `web/app/api/copilot/route.ts:162` → `rateLimit(\`copilot:ip:${ip}\`, RL_LIMIT, RL_WINDOW_MS)` where `RL_LIMIT = 20`, `RL_WINDOW_MS = 60_000`

All five must compile and behave identically after this plan; you are changing
only the *internals* behind `rateLimit()`.

### The auth challenge has no nonce

`web/lib/memwalAuth.ts:98-108` (`parseChallenge`, time-window-only):

```
  const ts = Number(tsMatch[1]);
  if (!Number.isSafeInteger(ts)) {
    throw new MemoryAuthError("Invalid auth challenge timestamp");
  }
  const now = Date.now();
  if (ts > now + MEMORY_CHALLENGE_FUTURE_SKEW_MS) {
    throw new MemoryAuthError("Auth challenge timestamp is in the future");
  }
  if (now - ts > MEMORY_CHALLENGE_MAX_AGE_MS) {
    throw new MemoryAuthError("Auth challenge expired (replay window)");
  }
```

`web/lib/memwalAuth.ts:177-180` (`verifyMemoryCaller` tail — `parseChallenge`
runs only after the signature is proven; this is the natural place to consume a
nonce):

```
  // Only now (signature proven) enforce the challenge structure + replay window.
  parseChallenge(message, owner);

  return owner;
```

`web/lib/memwalChallenge.ts:11-22` (domain + window + builder; the canonical
challenge is `DOMAIN\nowner=…\nts=…`):

```
export const MEMORY_CHALLENGE_DOMAIN = "HostIt-MemWal:auth:v1";
export const MEMORY_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
export const MEMORY_CHALLENGE_FUTURE_SKEW_MS = 60 * 1000; // 1 minute
export function buildMemoryChallenge(owner: string, tsMs: number): string {
  return `${MEMORY_CHALLENGE_DOMAIN}\nowner=${owner}\nts=${tsMs}`;
}
```

`web/lib/memoryClient.ts:155-168` (`signEnvelope` — embeds only owner + timestamp;
no per-message uniqueness beyond `Date.now()`):

```
  const signEnvelope = useCallback(
    async (ownerAddr: string): Promise<SignedEnvelope> => {
      const message = buildMemoryChallenge(ownerAddr, Date.now());
      const bytes = new TextEncoder().encode(message);
      ...
      return { owner: ownerAddr, message, signature };
    },
```

> **Replay note**: two distinct messages with the same `owner` and the same
> millisecond `Date.now()` are byte-identical and produce the same hash. That is
> fine for replay protection — the FIRST use of that exact signed challenge
> succeeds; any **identical resend** (the actual replay vector) is rejected.
> Adding a client nonce is OPTIONAL hardening (see Step 6) and is NOT required
> for correctness, because the challenge hash (domain+owner+ts) already keys the
> nonce store.

### The auth test that pins behavior (your structural pattern)

`web/lib/__tests__/memwalAuth.test.ts:1-21` — how this suite neutralizes
`server-only` and stubs the only crypto/network dep. **Match this exactly** when
you add nonce tests:

```
import { describe, it, expect, vi, beforeEach } from "vitest";

// memwalAuth imports "server-only" (throws if bundled for the client) — neutralize
// it so the module loads under vitest.
vi.mock("server-only", () => ({}));

// The ONLY network/crypto dependency: stub it so we control the recovered signer.
const toSuiAddress = vi.fn();
vi.mock("@mysten/sui/verify", () => ({
  verifyPersonalMessageSignature: vi.fn(async () => ({ toSuiAddress })),
}));

import { verifyMemoryCaller, isMemoryAuthError } from "../memwalAuth";
import { buildMemoryChallenge } from "../memwalChallenge";

const OWNER = "0x" + "a".repeat(64);
```

The existing happy-path test at `memwalAuth.test.ts:28-31` asserts a fresh
challenge **resolves** to the owner — after Step 4 that test will start to FAIL
on its second assertion if the same message is reused, so read Step 4's note on
keeping it green.

### Environment / config conventions (inline — the executor has not read these)

- `web/.env.local.example:40-64` documents the MemWal env block. Server-only
  secrets are NEVER `NEXT_PUBLIC_`-prefixed and are NOT added to
  `web/lib/config.ts` as exported constants. Quote from `:46-48`:
  `// Server-only — NEVER NEXT_PUBLIC_-prefixed; read via process.env inside`
  `// lib/memwal.ts + the /api/memory/* route handlers only. Keep out of the browser`
  `// bundle (do NOT add to lib/config.ts as an exported constant).`
  **Follow this for the new KV env vars**: read them via `process.env` inside the
  server-only store module; do NOT export them from `config.ts`.
- Routes declare no `export const runtime` → they default to the **Node.js**
  runtime (confirmed: `grep -rn "export const runtime" web/app/api` returns
  nothing). A Node runtime means you may use either the Upstash REST client
  (`@upstash/redis`, fetch-based, works on Node and Edge) or `@vercel/kv`. Prefer
  the **REST/fetch client** so the module stays Edge-portable if a route is moved
  later.
- `web/lib/rateLimit.ts:16` and `web/lib/memwalAuth.ts:31` both `import "server-only"`.
  The new store module MUST also `import "server-only"` (it touches a secret token).
- Package manager is **bun only**. Never `npm`/`pnpm`. (`bun.lock` is the lockfile.)
- The `@/` path alias exists in `tsconfig.json` but the vitest suites import via
  **relative paths** (`../memwalAuth`) — there is no vitest config that registers
  the alias. Use relative imports in any new test.

## Commands you will need

Run all of these from `web/` (the Next.js tree). The Move tree at the repo root
is NOT touched by this plan.

| Purpose             | Command                                  | Expected on success                |
|---------------------|------------------------------------------|------------------------------------|
| Install (if needed) | `bun install`                            | exit 0                             |
| Typecheck (PRIMARY) | `bunx tsc --noEmit`                       | exit 0, no errors                  |
| Unit tests          | `bun run test`                           | all files pass                     |
| Run one test file   | `bunx vitest run lib/__tests__/rateLimit.test.ts` | that file passes          |
| Lint                | `bun run lint`                           | exit 0                             |

There is **no** `typecheck` npm script — use `bunx tsc --noEmit` directly (this is
the project's primary verification gate per `CLAUDE.md`). **Never run
`bun run build` while `bun run dev` is running** — it corrupts `.next/`. You do
not need `bun run build` for this plan; verify with `bunx tsc --noEmit`.

## Suggested executor toolkit

- The `next-best-practices` skill (Route Handlers / server-only modules) if you
  are unsure how a Node-runtime route handler may import a `server-only` module.
- Upstash Redis REST docs (`@upstash/redis`) for the sliding-window primitive —
  prefer their documented `ZADD`/`ZREMRANGEBYSCORE`/`ZCARD` sorted-set sliding
  window, or the `@upstash/ratelimit` package's `slidingWindow` if you add it as a
  dependency.

## Scope

**In scope** (the only files you should create or modify):

- `web/lib/rateLimit.ts` — replace the seam body; keep `rateLimit()` and
  `rateLimitMemory()` signatures identical. Make the function `async` ONLY if you
  also update all five callers (see Step 3 for the chosen approach — we keep it
  **sync-compatible** by NOT making it async; see that step).
- `web/lib/kvStore.ts` — **(create)** the shared store module (one client,
  server-only, graceful in-memory fallback).
- `web/lib/memwalAuth.ts` — consume a one-time nonce in `verifyMemoryCaller`.
- `web/lib/__tests__/rateLimit.test.ts` — **(create)** sliding-window + fallback tests.
- `web/lib/__tests__/memwalAuth.test.ts` — add nonce/replay tests; keep existing
  tests green.
- `web/.env.local.example` — document the new KV env vars (no secret values).
- `plans/README.md` — **(create or update)** the status row.

**Out of scope** (do NOT touch, even though they look related):

- `web/lib/config.ts` — KV env vars are server-only and must NOT be exported here
  (see env convention above). It also drifted in commit `957206b`; leave it.
- `web/lib/memwalChallenge.ts` — it is client-safe and shared with the browser.
  Adding a server-only nonce store here would pull `server-only` into the client
  bundle and fail `next build`. The nonce lives in `memwalAuth.ts` + `kvStore.ts`.
- `web/lib/memoryClient.ts` — no client change is REQUIRED (replay protection is
  server-side). A client nonce is OPTIONAL hardening, deferred to Step 6 — do that
  only if Steps 1–5 are green and you have time; otherwise leave the file alone.
- The five route handlers (`web/app/api/memory/*`, `create-assist`, `copilot`) —
  they must keep calling `rateLimit`/`rateLimitMemory` exactly as today. Do NOT
  change their limits, their order of checks, or their `clientIpFromHeaders`
  usage beyond what Step 2 specifies for `clientIpFromHeaders` itself.
- Any Move file (repo root `sources/`, `tests/`). `web/lib/moveErrors.ts` is NOT
  involved (no new Move error code is added — confirmed
  `grep -c "rateLimit\|nonce" web/lib/moveErrors.ts` → 0).

## Git workflow

- Branch: `advisor/003-durable-rate-limit-and-replay-nonce` (create from `main`).
- Commit per logical step; conventional-commit messages (the repo uses them — last
  commit: `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
  Examples for this plan:
  `feat(rate-limit): KV-backed sliding window behind rateLimit() seam` /
  `feat(auth): one-time-use nonce for the memory challenge` /
  `chore(env): document KV/Redis env vars`.
- Do NOT push or open a PR unless the operator explicitly instructs it. (Repo flow
  is issue → branch → PR, and the `gh` CLI may hang in this environment.)

## Steps

> **Design constraint that drives all steps**: the five callers invoke
> `rateLimit()`/`rateLimitMemory()` **synchronously** today (e.g.
> `const rl = rateLimitMemory(...)`). A network round-trip to Redis is async.
> Rather than make the seam `async` (which would force editing all five
> out-of-scope-sensitive routes and risk subtle ordering bugs), this plan keeps
> the seam **synchronous and best-effort with a write-through async store**:
> the in-memory `Map` remains the authoritative *fast path within an instance*,
> and the KV store is queried/updated to share counts across instances. See
> Step 3 for the exact mechanism and its trade-off. If you conclude an async
> seam is unavoidable for correctness, that is a STOP condition (it expands scope
> to the routes) — report it.

### Step 1: Add the shared store dependency and the `kvStore.ts` module

Add the Upstash REST client (fetch-based, Node + Edge safe) as a dependency:

```
bun add @upstash/redis
```

Create `web/lib/kvStore.ts` — a server-only singleton with a **graceful in-memory
fallback** when the env vars are absent (so the app builds + runs locally without
a provisioned KV, mirroring how MemWal "gracefully disables"). Target shape:

```ts
import "server-only";
import { Redis } from "@upstash/redis";

// KV env vars are server-only secrets — read via process.env here, NEVER export
// from lib/config.ts and NEVER NEXT_PUBLIC_-prefix (see .env.local.example).
const url = process.env.RATE_LIMIT_KV_REST_URL;
const token = process.env.RATE_LIMIT_KV_REST_TOKEN;

/** True when a real shared KV is configured; false → per-process fallback. */
export function kvEnabled(): boolean {
  return Boolean(url && token);
}

let client: Redis | null = null;
export function getKv(): Redis | null {
  if (!kvEnabled()) return null;
  if (!client) client = new Redis({ url: url!, token: token! });
  return client;
}
```

Naming: use `RATE_LIMIT_KV_REST_URL` / `RATE_LIMIT_KV_REST_TOKEN` (these are the
two values an Upstash Redis database exposes as REST URL + REST token; if you
provision Vercel KV instead, it exposes `KV_REST_API_URL` / `KV_REST_API_TOKEN`
— in that case set the two `RATE_LIMIT_*` vars to those values so this module
stays provider-agnostic).

**Verify**: `bunx tsc --noEmit` → exit 0 (the module compiles; `@upstash/redis`
types resolve).

### Step 2: Stop trusting raw `x-forwarded-for`

The current `clientIpFromHeaders` (excerpt above, `rateLimit.ts:81-91`) returns
the FIRST `x-forwarded-for` entry, which the client controls. On Vercel, the
platform sets a trustworthy client IP — but a request can still arrive with an
attacker-supplied `x-forwarded-for`. Harden it so the per-IP bucket cannot be
trivially rotated by spoofing:

- Prefer a platform-verified header when present. On Vercel that is
  `x-vercel-forwarded-for` (or `x-real-ip`, which Vercel sets to the true client
  IP). Read those BEFORE `x-forwarded-for`.
- Only fall back to `x-forwarded-for[0]` when no verified header exists, and add a
  short code comment that this entry is client-controlled and therefore weak.

Target shape (precedence: verified → real-ip → first XFF → "unknown"):

```ts
export function clientIpFromHeaders(headers: Headers): string {
  // Platform-verified client IP (Vercel sets these; a client cannot forge them
  // because the edge overwrites them). Prefer them over x-forwarded-for.
  const verified =
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (verified) {
    const first = verified.split(",")[0]?.trim();
    if (first) return first;
  }
  // Fallback: x-forwarded-for is CLIENT-CONTROLLED and spoofable — last resort.
  const xff = headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first;
  return "unknown";
}
```

This keeps the return type `string` so all callers are untouched.

**Verify**: `bunx tsc --noEmit` → exit 0. Then a behavioral check (Step 5 adds the
unit test; for now just confirm it compiles).

### Step 3: Make `rateLimit()` KV-aware behind its existing signature

Replace the body of `rateLimit()` (`rateLimit.ts:43-74`) so it consults the shared
KV store *in addition to* the local `Map`, while **keeping the function
synchronous and the signature identical**. Mechanism (write-through, fail-open to
local):

1. Keep the existing local `Map` logic exactly as-is — it remains the in-instance
   fast path and the always-available fallback. Compute the local
   `RateLimitResult` first (this is what you return synchronously).
2. If `kvEnabled()` (from `kvStore.ts`), **fire a best-effort async KV update**
   that increments a windowed counter for `key` and, when the KV count exceeds
   `limit`, primes the local `Map` bucket to its limit so the NEXT call on this
   instance is rejected even though the count originated on another instance.
   Use Redis `INCR` + `PEXPIRE` (fixed window matching `windowMs`) or the
   sorted-set sliding window; do not `await` it inside the sync return path —
   instead use a tiny module-level async helper that updates the `Map` when the
   promise resolves. Swallow KV errors (log once) so a KV outage degrades to the
   current per-process behavior rather than failing requests.

> **Why this design**: it satisfies the signature constraint (no caller edits, so
> the five routes stay out of scope) and makes the cap *shared-aware* — a burst
> that hits many instances converges to the global limit within one window
> instead of multiplying by instance count. The known trade-off (document it in a
> code comment): the very first request to each cold instance within a window can
> still slip through before the KV-primed rejection lands; this is a deliberate,
> bounded relaxation, far tighter than today's unbounded `limit × instances`.
>
> If, after attempting this, you find the project actually requires a strict
> synchronous global decision (no per-instance slip allowed), STOP and report —
> that requires making the seam `async` and editing all five callers, which is
> out of scope for this plan.

Update the module header (`rateLimit.ts:7-14`) to reflect that the KV seam is now
implemented (note the write-through + fail-open semantics and the cold-start
caveat). Keep the `sweep()` eviction for the local `Map`.

**Verify**: `bunx tsc --noEmit` → exit 0. `bun run test` → all existing tests
still pass (no test imports the KV path yet).

### Step 4: Consume a one-time nonce in `verifyMemoryCaller`

The replay vector is an **identical resend** of a signed envelope within the
5-minute window. Reject the second use by recording a hash of the challenge in the
shared store with a TTL equal to `MEMORY_CHALLENGE_MAX_AGE_MS`.

In `web/lib/memwalAuth.ts`, after the signature is proven and `parseChallenge`
passes (i.e. right before `return owner;` at `memwalAuth.ts:177-180`), add a
one-time-nonce check:

1. Derive a stable key from the exact signed message bytes, e.g.
   `nonce:mem:<sha256-hex-of-message>`. Use Node's `crypto.createHash("sha256")`
   (this module is server-only / Node runtime). Hash `message` (the canonical
   challenge string), NOT the signature, so the key is deterministic for an
   identical replay.
2. Attempt an atomic "set if not exists with TTL" against the store:
   - With KV enabled: `redis.set(key, "1", { nx: true, px: MEMORY_CHALLENGE_MAX_AGE_MS })`.
     If it returns falsy (key already existed), throw
     `new MemoryAuthError("Auth challenge already used (replay)")`.
   - With KV disabled (`!kvEnabled()`): fall back to a module-level
     `Map<string, number>` of `key → expiryMs` inside `memwalAuth.ts` (best-effort,
     per-process) so local dev and single-instance still get replay protection.
     Reject if the key is present and unexpired; otherwise record it with expiry
     `Date.now() + MEMORY_CHALLENGE_MAX_AGE_MS`. Sweep expired entries on access.
3. Because this is `await`ed and `verifyMemoryCaller` is already `async`, no
   caller changes (the routes already `await verifyMemoryCaller(body)` — confirmed
   at `analyze/route.ts:37`, `recall/route.ts:42`, `remember/route.ts:35`,
   `create-assist/route.ts:206`).

**Keep the existing happy-path test green**: `memwalAuth.test.ts:28-31` calls
`verifyMemoryCaller` once with a fresh challenge and expects it to resolve. A
single call is the FIRST use, so it still resolves — good. But other tests build a
challenge and call once each; ensure each uses a **distinct** `ts` (they already
do via `Date.now()` offsets) so they don't collide on the nonce key. If two tests
share an identical `(owner, ts)` you must give them distinct timestamps. The
fallback `Map` must reset between tests — add a `beforeEach` that clears it, or
expose a tiny `__resetNonceStoreForTest()` (guarded, server-only) and call it.

> **Note on KV in tests**: tests run with KV env vars unset, so `kvEnabled()` is
> false and the in-memory nonce fallback is exercised. You do NOT need to mock
> `@upstash/redis` for the nonce tests — but you must mock `server-only` and
> `@mysten/sui/verify` exactly as `memwalAuth.test.ts:3-11` already does.

**Verify**: `bun run test` → all pass, including the existing 7
`verifyMemoryCaller` cases plus the new replay case (Step 5 lists it).

### Step 5: Tests

Add `web/lib/__tests__/rateLimit.test.ts` (model its mock setup after
`memwalAuth.test.ts:3-5` — mock `server-only`; also mock `./kvStore` so
`kvEnabled()` returns false to force the deterministic in-memory path). Cover:

- **Happy path**: `rateLimit("k", 2, 60_000)` twice returns `ok:true`, third
  returns `ok:false` with `retryAfterSec >= 1`.
- **Window reset**: with `vi.useFakeTimers()`, advancing past `windowMs` resets
  the count (re-`ok`).
- **`rateLimitMemory` fan-out**: identity over-limit returns the id failure before
  the IP bucket is consulted (assert the returned `remaining`/`ok`).
- **`clientIpFromHeaders` precedence (Step 2)**: a request with both
  `x-vercel-forwarded-for: 1.2.3.4` and a spoofed `x-forwarded-for: 9.9.9.9`
  returns `1.2.3.4`; with only `x-forwarded-for` returns its first entry; with no
  IP headers returns `"unknown"`.

Add to `web/lib/__tests__/memwalAuth.test.ts` (same file, new `it` blocks):

- **Replay rejected**: build ONE challenge+envelope; first `verifyMemoryCaller`
  resolves to OWNER; a SECOND `verifyMemoryCaller` with the **same `message`**
  rejects with a `MemoryAuthError` (satisfy `isMemoryAuthError`). Reset the nonce
  fallback in `beforeEach` so this is the only test seeing that key.
- **Distinct fresh challenges both succeed**: two `verifyMemoryCaller` calls with
  different `ts` both resolve (proves the nonce keys on the message, not the owner).

**Verify**: `bun run test` → all pass; the run reports the new tests. Spot-run the
new file: `bunx vitest run lib/__tests__/rateLimit.test.ts` → that file passes.

### Step 6 (OPTIONAL — do only if Steps 1–5 are green and time allows): client nonce hardening

This is hardening, not required for correctness. If you do it, modify ONLY
`web/lib/memwalChallenge.ts` and `web/lib/memoryClient.ts`, and keep the builder
client-safe:

- Add an optional `nonce` segment to `buildMemoryChallenge` (e.g. a 4th line
  `nonce=<hex>`), bump `MEMORY_CHALLENGE_DOMAIN` to `:v2`, and update
  `parseChallenge` to accept the new line count. Generate the client nonce with
  `crypto.getRandomValues`. This makes every challenge byte-unique even within the
  same millisecond.
- If you bump the domain you MUST update `parseChallenge`'s `lines.length` /
  `MEMORY_CHALLENGE_DOMAIN` check (`memwalAuth.ts:74-83`) and all the test
  builders. This widens blast radius — if it threatens to break the existing
  suite and you cannot keep it green in one attempt, REVERT Step 6 and ship Steps
  1–5 (they are complete on their own). Note the deferral in Maintenance notes.

**Verify**: `bunx tsc --noEmit` → exit 0; `bun run test` → all pass.

### Step 7: Document the env vars

Append to `web/.env.local.example` (after the MemWal block ending at line 64) a new
section — **names and purpose only, NO secret values**:

```
# Shared rate-limit + replay-nonce store (Vercel KV / Upstash Redis REST).
# OPTIONAL: when unset, the limiter falls back to a per-process in-memory counter
# and the replay-nonce store falls back to per-process memory (single-instance
# only — NOT robust on serverless). Set BOTH to enable the shared, cross-instance
# store. Server-only — NEVER NEXT_PUBLIC_-prefixed; read via process.env in
# lib/kvStore.ts only (do NOT add to lib/config.ts).
# For Upstash: REST URL + REST token of the database.
# For Vercel KV: set these to the KV_REST_API_URL / KV_REST_API_TOKEN values.
RATE_LIMIT_KV_REST_URL=
RATE_LIMIT_KV_REST_TOKEN=
```

**Verify**: `grep -n "RATE_LIMIT_KV_REST_URL" web/.env.local.example` → prints the
line; `grep -rn "RATE_LIMIT_KV_REST" web/lib/config.ts` → no output (the secret is
NOT exported from config).

## Test plan

- **New file** `web/lib/__tests__/rateLimit.test.ts`: happy path, window reset
  (fake timers), `rateLimitMemory` identity-before-IP, `clientIpFromHeaders`
  precedence (verified header beats spoofed `x-forwarded-for`, `x-forwarded-for`
  fallback, `"unknown"`). Mock `server-only` and `./kvStore` (force
  `kvEnabled()===false`).
- **Extend** `web/lib/__tests__/memwalAuth.test.ts`: replay-rejected (same message
  twice), two-distinct-challenges-both-succeed. Reset the nonce fallback in
  `beforeEach`.
- **Structural pattern**: model all mock setup after
  `web/lib/__tests__/memwalAuth.test.ts:1-21`.
- **Verification**: `bun run test` → all pass, including the new cases; the 7
  pre-existing `verifyMemoryCaller` cases remain green.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `bunx tsc --noEmit` exits 0 with no errors.
- [ ] `bun run test` exits 0; the new `lib/__tests__/rateLimit.test.ts` exists and
      passes; the replay + distinct-challenge cases in
      `lib/__tests__/memwalAuth.test.ts` pass; the 7 pre-existing
      `verifyMemoryCaller` cases still pass.
- [ ] `bun run lint` exits 0.
- [ ] `web/lib/kvStore.ts` exists and starts with `import "server-only";`
      (`grep -n 'import "server-only"' web/lib/kvStore.ts` → matches line 1).
- [ ] `rateLimit()` and `rateLimitMemory()` keep their original signatures —
      `grep -n "export function rateLimit(" web/lib/rateLimit.ts` and
      `grep -n "export function rateLimitMemory(" web/lib/rateLimit.ts` still show
      the same parameter lists shown in "Current state".
- [ ] No route handler was modified:
      `git diff --name-only main..HEAD -- web/app/api` returns nothing.
- [ ] `web/lib/config.ts` was NOT modified:
      `git diff --name-only main..HEAD -- web/lib/config.ts` returns nothing.
- [ ] The new env vars are documented but not exported from config:
      `grep -c "RATE_LIMIT_KV_REST" web/.env.local.example` → `2`;
      `grep -c "RATE_LIMIT_KV_REST" web/lib/config.ts` → `0`.
- [ ] No secret values committed:
      `grep -rnE "RATE_LIMIT_KV_REST_(URL|TOKEN)=.+" web/.env.local.example`
      returns nothing (the example keeps the values blank).
- [ ] No files outside the in-scope list are modified (`git status --porcelain`
      shows only in-scope paths + `plans/README.md`).
- [ ] `plans/README.md` status row for plan 003 updated to DONE.

If `plans/README.md` does not yet exist, create it with this header and a row for
this plan:

```markdown
# Implementation Plans

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 003  | Durable rate limit + replay nonce | P1 | M | — | DONE |
```

## STOP conditions

Stop and report back (do not improvise) if:

- The drift-check `git diff --stat 957206b..HEAD -- <in-scope paths>` shows any
  in-scope file changed AND the "Current state" excerpt for that file no longer
  matches the live code (the codebase drifted since this plan was written).
- Achieving a correct global cap appears to REQUIRE making `rateLimit()` async
  (i.e. the synchronous write-through in Step 3 is judged insufficient) — that
  forces editing the five out-of-scope route handlers; report it instead.
- No KV/Redis provider can be provisioned in this environment AND the operator
  has not confirmed the in-memory fallback is acceptable for the deploy. In that
  case: implement Steps as written (the fallback path keeps everything working),
  but flag in your report that the shared store is NOT yet provisioned, so the
  cross-instance guarantee is inert until `RATE_LIMIT_KV_REST_*` are set. (Do not
  invent or commit credentials.)
- `@upstash/redis` cannot be added via `bun add` (offline/registry failure) —
  report; do not hand-roll a Redis client or switch to a different unvetted
  dependency without sign-off.
- A step's verification fails twice after a reasonable fix attempt.
- Step 6 (optional client nonce) cannot be completed while keeping `bun run test`
  green in one attempt — revert Step 6 and ship Steps 1–5.

## Maintenance notes

For the human/agent who owns this after it lands:

- **Provision the store before relying on the cap.** Until `RATE_LIMIT_KV_REST_*`
  are set in the Vercel project env, both the limiter and the nonce store run in
  per-process memory — fine for local/single-instance, but the cross-instance
  guarantee (the whole point of this plan) is inert. Treat provisioning as a
  follow-up ops task; rotate the REST token if it is ever exposed.
- **The Step 3 cold-start caveat is intentional.** Each cold instance can let the
  first request of a window through before the KV-primed rejection lands. If a
  stricter guarantee is ever needed, the seam must go async and all five callers
  updated — that is a larger change and was deliberately out of scope here.
- **Nonce key is the SHA-256 of the canonical challenge message.** If
  `MEMORY_CHALLENGE_DOMAIN` is bumped (Step 6 / future `:vN`), or the challenge
  format in `memwalChallenge.ts` changes, old nonces simply expire — no migration
  needed, but the change must keep client and server byte-identical (the file's
  own header at `memwalChallenge.ts:1-8` warns about this).
- **Reviewer should scrutinize**: (1) that the five `rateLimit`/`rateLimitMemory`
  call sites are byte-for-byte unchanged; (2) that `kvStore.ts` and the
  `memwalAuth` nonce path both swallow KV errors (fail-open for the limiter,
  fail-open-to-local for the nonce) so a Redis outage cannot 500 the routes; (3)
  that no secret leaks into `config.ts` or the client bundle; (4) the TTL on the
  nonce equals `MEMORY_CHALLENGE_MAX_AGE_MS` (a shorter TTL would re-open the
  replay window; a longer one wastes store space).
- **Deferred out of this plan**: a session-token scheme to avoid per-call signing
  (noted in `memoryClient.ts:122-125` as tied to this KV work) and DeepBook-style
  distributed token-bucket limits — both are larger and not needed for the cost
  + replay fix.
```