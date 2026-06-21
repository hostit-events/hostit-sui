# Plan 004: Emit CSP + security response headers app-wide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists (it does not exist yet — create it
> only if a reviewer asks; otherwise skip).
>
> **All commands run from `/Users/dadadave/Dev/HostIT/sui-ticket/web` unless a
> command is explicitly tagged `(repo root)`.** Package manager is **bun only** —
> never `npm`/`pnpm`/`yarn`.
>
> **Drift check (run FIRST, from repo root)**:
> ```bash
> git diff --stat 957206b..HEAD -- web/next.config.ts web/lib/config.ts web/app/layout.tsx web/app/globals.css web/lib/staffKey.ts
> ```
> Expected: **empty output** (no in-scope file changed since this plan was
> written). If any of those files changed, compare the "Current state" excerpts
> below against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20

> **PLANNING NOTE — SHA discrepancy (read once, then ignore).** The task that
> commissioned this plan stated the working tree was at `9b169c0`. The live
> `HEAD` at authoring time was actually `957206b` ("feat(forum): organizer admin
> [#37]"), with `9b169c0` being its parent. The working tree was **clean** at
> `957206b`. The five files this plan reads (`next.config.ts`, `lib/config.ts`,
> `app/layout.tsx`, `app/globals.css`, `lib/staffKey.ts`) are **byte-identical
> between `9b169c0` and `957206b`** (verified: `git diff 9b169c0..957206b` on
> those paths is empty), so every excerpt below is valid at both commits. The
> drift check above uses `957206b` because that is the real authoring SHA.

## Why this matters

The app sends **zero** security response headers. `web/next.config.ts` defines
only `reactStrictMode` + `images.remotePatterns`, and there is **no
`middleware.ts` anywhere** in the repo, so the browser receives no
`Content-Security-Policy`, no `Strict-Transport-Security`, no
`X-Frame-Options`/`frame-ancestors`, no `X-Content-Type-Options`, and no
`Referrer-Policy`.

This is high blast-radius for **this** app specifically. It signs wallet
transactions, holds Seal threshold-decryption session keys in the browser, and
persists a **raw ed25519 staff check-in private key in `localStorage`**
(`web/lib/staffKey.ts:30`, key `hostit.staffSigner.secret`). With no CSP and no
frame-busting, any reflected/stored XSS or a clickjacking overlay has maximal
reach: it can exfiltrate the staff signing key and forge check-in vouchers, or
trick a user into approving transactions. A baseline CSP + `frame-ancestors`
+ `nosniff` + HSTS removes the cheapest attack classes (injected `<script
src>`, framing, MIME-sniffing) and is a standard production hardening step.

This plan **only adds response headers**. It does **not** relocate the staff
key out of `localStorage` — that is explicitly deferred (see Maintenance notes).

## Current state

Files and their roles:

- `web/next.config.ts` — the entire Next.js config. **No `headers()` today.** This is where the headers get added.
- `web/lib/config.ts` — single source of truth for on-chain ids/targets AND the external origins (Walrus, Seal). The CSP `connect-src`/`img-src` allowlist is derived from the origins referenced here.
- `web/app/layout.tsx` — root layout; loads a **third-party `<script>`** that the CSP `script-src` must allow, and the Iconify runtime that needs `connect-src`.
- `web/app/globals.css` — has a **Google Fonts `@import`** that drives `style-src`/`font-src`.
- `web/lib/staffKey.ts` — the high-value secret in `localStorage` this CSP protects (read-only context; do NOT modify it).

### `web/next.config.ts` (entire file, lines 1–13)

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "**.suivision.xyz" },
    ],
  },
};

export default config;
```

Next version is `^16.2.9` (`web/package.json`), which supports `async headers()`
in `next.config.ts`.

### Why the staff key makes this P1 — `web/lib/staffKey.ts:28-30`, `97-103`

```ts
// localStorage key. Per-device, not per-event: one staff key can be registered on
// many events. Holds the bech32 `suiprivkey1…` secret string.
const STAFF_KEY_STORAGE = "hostit.staffSigner.secret";
```
```ts
export function generateStaffKeypair(): Ed25519Keypair {
  const kp = Ed25519Keypair.generate();
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STAFF_KEY_STORAGE, kp.getSecretKey());
  }
  return kp;
}
```
A successful XSS reads `localStorage["hostit.staffSigner.secret"]` and exfiltrates
a signing key. `script-src 'self'` (no wildcard) blocks the most common XSS
delivery (injected remote `<script src>`).

### External origins the CSP must allow — derived first-hand

These are the **runtime, browser-side** origins. Server-only fetches are noted
because they MUST NOT be added to the browser CSP (a header set in
`next.config.ts` applies to document responses; the browser enforces it on the
client — server `fetch()` inside route handlers is not subject to it).

| Origin | Where referenced | CSP directive(s) |
|---|---|---|
| `https://fullnode.testnet.sui.io` (+ `:443`; mainnet variant `https://fullnode.mainnet.sui.io`) | `web/lib/dapp-kit.ts:30-31` (`new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(network) })`); the SDK resolves to `https://fullnode.<net>.sui.io:443` | `connect-src` |
| `https://api.enoki.mystenlabs.com` | Enoki SDK default base URL (`@mysten/enoki` `EnokiClient`, `DEFAULT_API_URL`); used by zkLogin nonce/zkp + sponsor calls. Also referenced via `EnokiFlowProvider` in `web/app/ClientProviders.tsx:37` | `connect-src` |
| `https://aggregator.walrus-testnet.walrus.space` | `web/lib/config.ts:78-79` (`WALRUS_AGGREGATOR`). Used to (a) `fetch` blobs (`web/lib/walrus.ts:24`) and (b) as an **`<img src>`** for cover images (`web/lib/walrus.ts:41-43` "use as an `<img src>`") | `connect-src` AND `img-src` |
| `https://publisher.walrus-testnet.walrus.space` | `web/lib/config.ts:76-77` (`WALRUS_PUBLISHER`); `fetch` to store blobs (`web/lib/walrus.ts:12`) | `connect-src` |
| `https://seal-aggregator-testnet.mystenlabs.com` | `web/lib/config.ts:94` (`SEAL_AGGREGATOR_URL`); Seal key-server committee aggregator (`web/lib/seal.ts:19`) | `connect-src` |
| `https://code.iconify.design` | `web/app/layout.tsx:24-27` — `<Script src="https://code.iconify.design/iconify-icon/2.1.0/iconify-icon.min.js" />` | `script-src` |
| `https://api.iconify.design` | The Iconify web component fetches icon SVG data at runtime from the Iconify API (the `code.iconify.design` script's data backend) | `connect-src` |
| `https://placehold.co` | `web/next.config.ts:7` image remotePattern; placeholder cover images | `img-src` |
| `https://*.suivision.xyz` | `web/next.config.ts:8` image remotePattern; explorer; also `web/lib/config.ts:19-22` `explorerTxUrl` (these are link `href`s / images) | `img-src` |
| `https://fonts.googleapis.com` | `web/app/globals.css:1` — `@import url('https://fonts.googleapis.com/css2?...')` (the landing brand fonts) | `style-src` |
| `https://fonts.gstatic.com` | The font **files** referenced by the `fonts.googleapis.com` CSS are served from `fonts.gstatic.com` | `font-src` |
| `https://accounts.google.com` | Google zkLogin is a **full-page redirect** (`web/lib/auth.ts:30` `redirectUrl: ${window.location.origin}/auth`). Top-level navigation is not `connect-src`-gated, but Enoki/Google may also XHR; include it in `connect-src` to be safe and add it to `form-action` so the OAuth redirect/POST is never blocked | `connect-src`, `form-action` |

**Server-only — DO NOT put in the browser CSP:**
- `https://api.groq.com` — called only inside `web/app/api/copilot/route.ts:188`
  and `web/app/api/create-assist/route.ts:227` via server `fetch()`. Adding it to
  the client CSP is harmless but unnecessary; leaving it out is correct.
- `GROQ_API_KEY`, `ENOKI_PRIVATE_API_KEY`, `GOOGLE_CLIENT_SECRET`,
  `MEMWAL_DELEGATE_KEY` — secrets, never in any header.

**Self-hosted, needs no external `font-src`:** the app's primary UI font
(`Geist`) is loaded via `next/font/google` in `web/app/layout.tsx:12`, which
self-hosts at build time (served from your own origin).

### Repo conventions to honor

- **Permissionless model:** this plan adds headers only; it introduces no role
  gate and touches no auth logic. (See `CLAUDE.md` "Conventions".)
- **Tests are vitest**, under `web/lib/__tests__/`. A config-export assertion
  pattern already exists — model the new test after
  `web/lib/__tests__/sponsoredTargets.test.ts` (imports a value from a config
  module and asserts membership/shape) and `web/lib/__tests__/config.test.ts`.
  Excerpt of the pattern (`web/lib/__tests__/sponsoredTargets.test.ts:1-6`):
  ```ts
  import { describe, it, expect } from "vitest";
  import { SPONSORED_TARGETS, PACKAGE_ID, PACKAGE_ID_LATEST } from "../config";

  describe("SPONSORED_TARGETS", () => {
    it("includes the critical sponsored entry points", () => {
  ```
- **Primary verification gate is `bunx tsc --noEmit`**, then `bun run lint`,
  then `bun run test`. There is no browser E2E layer.
- **NEVER run `bun run build` while `bun run dev` is running** — they share
  `.next/` and a prod build corrupts the dev client bundle. This plan's runtime
  verification uses `next dev` + `curl`, never `next build`.

## Commands you will need

All from `web/` unless tagged.

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck (primary gate) | `bunx tsc --noEmit` | exit 0, no output |
| Lint | `bun run lint` | exit 0 |
| Unit tests | `bun run test` | all pass |
| Run one test file | `bunx vitest run lib/__tests__/securityHeaders.test.ts` | pass |
| Start dev server (bg) | `bun run dev` | logs "Ready" / "Local: http://localhost:3000" |
| Read headers from a running dev server | `curl -sI http://localhost:3000/discover` | HTTP/1.1 200 + the headers |

## Scope

**In scope** (the only files you may modify/create):
- `web/next.config.ts` — add the `headers()` block + a small exported CSP helper.
- `web/lib/__tests__/securityHeaders.test.ts` — **create**; unit-tests the CSP string.

**Out of scope** (do NOT touch):
- `web/lib/staffKey.ts` — relocating the key out of `localStorage` is a deferred v2 follow-up, NOT this plan. Read-only here.
- `web/lib/config.ts` — derive origins by reading it; do not edit it. (If you find you "need" to export origins from it to build the CSP, that is fine ONLY as an additive new export — but the simpler path is to inline the origin list in `next.config.ts`. Prefer inlining; see Step 1.)
- Any route handler (`web/app/api/**`), any screen/component, any auth logic.
- `web/app/layout.tsx` / `web/app/globals.css` — read-only inputs to the CSP; do not add nonces or rewrite the `<Script>`/`@import` in this plan.
- The Move package (repo root `sources/`, `tests/`) — unaffected.
- Do NOT switch to a nonce-based CSP or add a `middleware.ts` — `next.config.ts headers()` is the chosen mechanism (see STOP conditions for why nonces are out of scope here).

## Git workflow

- Branch: `advisor/004-security-headers-csp` (create from current `HEAD`).
- Commit message style: conventional commits (matches repo log, e.g.
  `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
  Suggested message:
  `feat(web): emit CSP + security response headers app-wide`
- Commit once at the end (single logical unit) or per step — your choice.
- Do **NOT** push or open a PR. (Repo flow is issue→branch→PR and `gh` may hang;
  the human will open the PR.)

## Steps

### Step 1: Add the security-headers block to `web/next.config.ts`

Replace the entire contents of `web/next.config.ts` with the version below. It:
- keeps the existing `reactStrictMode` + `images.remotePatterns` untouched;
- defines `CONNECT_SRC` / `IMG_SRC` / `SCRIPT_SRC` / `STYLE_SRC` / `FONT_SRC`
  arrays from the **first-hand origin table** in "Current state";
- builds a single CSP string via an **exported** `buildCsp()` so the unit test in
  Step 2 can assert on it without a running server;
- emits the CSP, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  and `Strict-Transport-Security` on **all** routes (`source: "/:path*"`).

Design decisions baked in (do not change without a STOP):
- `script-src 'self' 'unsafe-inline'` + the Iconify CDN. **`'unsafe-inline'` is
  intentional**: Next.js injects inline bootstrap/runtime `<script>` and
  `next/script` (`afterInteractive`) inlines a loader; a nonce-based policy would
  require a `middleware.ts` rewrite of every inline script and is explicitly
  out of scope (STOP condition). Adding the staff-key protection via
  `script-src 'self'` (no remote wildcard) is the win here.
- `'unsafe-eval'` is included **only in development** (Turbopack/React Refresh
  needs it); production omits it.
- In **development**, `connect-src` also allows `ws:`/`wss:` and `http://localhost:*`
  for HMR, or the dev overlay/HMR socket will be CSP-blocked.
- `frame-ancestors 'none'` (clickjacking) + the legacy `X-Frame-Options: DENY`.
- `form-action 'self' https://accounts.google.com` so the zkLogin redirect is
  never blocked.
- HSTS is emitted unconditionally; browsers ignore it over plain HTTP (localhost),
  so it is safe to send in all environments.

```ts
import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Browser-side origins the app legitimately talks to. Derived from
// web/lib/config.ts (Walrus aggregator/publisher, Seal aggregator), the Sui
// fullnode (resolved by @mysten/sui's getJsonRpcFullnodeUrl), the Enoki API
// (zkLogin + sponsor), Iconify (runtime icon data), and Google (zkLogin
// redirect). NOTE: api.groq.com is called ONLY server-side (app/api/*) and is
// deliberately NOT listed here. Keep this list in sync if those origins change.
const CONNECT_SRC = [
  "'self'",
  "https://fullnode.testnet.sui.io",
  "https://fullnode.mainnet.sui.io",
  "https://api.enoki.mystenlabs.com",
  "https://aggregator.walrus-testnet.walrus.space",
  "https://publisher.walrus-testnet.walrus.space",
  "https://seal-aggregator-testnet.mystenlabs.com",
  "https://api.iconify.design",
  "https://accounts.google.com",
];

const IMG_SRC = [
  "'self'",
  "data:",
  "blob:",
  "https://aggregator.walrus-testnet.walrus.space",
  "https://placehold.co",
  "https://*.suivision.xyz",
];

const SCRIPT_SRC = ["'self'", "'unsafe-inline'", "https://code.iconify.design"];

// Google Fonts CSS (@import in app/globals.css) needs the stylesheet host;
// 'unsafe-inline' covers Next/shadcn/next-themes injected inline styles.
const STYLE_SRC = ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"];

const FONT_SRC = ["'self'", "data:", "https://fonts.gstatic.com"];

/**
 * Build the Content-Security-Policy header value. Exported so it can be unit
 * tested (web/lib/__tests__/securityHeaders.test.ts) without a running server.
 * `dev=true` loosens it for Turbopack/HMR (eval + ws); production is strict.
 */
export function buildCsp(dev = isDev): string {
  const connect = dev
    ? [...CONNECT_SRC, "ws:", "wss:", "http://localhost:*"]
    : CONNECT_SRC;
  const script = dev ? [...SCRIPT_SRC, "'unsafe-eval'"] : SCRIPT_SRC;
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": script,
    "style-src": STYLE_SRC,
    "img-src": IMG_SRC,
    "font-src": FONT_SRC,
    "connect-src": connect,
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'", "https://accounts.google.com"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: buildCsp() },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "**.suivision.xyz" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default config;
```

**Verify**: `bunx tsc --noEmit` → exit 0, no output. Then `bun run lint` → exit 0.

### Step 2: Add a unit test pinning the CSP contents

Create `web/lib/__tests__/securityHeaders.test.ts`. Import `buildCsp` from the
config (relative path from `lib/__tests__/` to repo's `web/next.config.ts` is
`../../next.config`) and assert the load-bearing directives. Model the structure
after `web/lib/__tests__/sponsoredTargets.test.ts`.

```ts
import { describe, it, expect } from "vitest";
import { buildCsp } from "../../next.config";

describe("Content-Security-Policy", () => {
  const prod = buildCsp(false);
  const dev = buildCsp(true);

  it("blocks framing and restricts the base set", () => {
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("object-src 'none'");
  });

  it("allows exactly the real runtime origins the app needs", () => {
    for (const o of [
      "https://fullnode.testnet.sui.io",
      "https://api.enoki.mystenlabs.com",
      "https://aggregator.walrus-testnet.walrus.space",
      "https://seal-aggregator-testnet.mystenlabs.com",
      "https://api.iconify.design",
    ]) {
      expect(prod).toContain(o); // in connect-src
    }
    expect(prod).toContain("https://code.iconify.design"); // script-src
    expect(prod).toContain("https://fonts.googleapis.com"); // style-src
    expect(prod).toContain("https://fonts.gstatic.com"); // font-src
    expect(prod).toContain("https://placehold.co"); // img-src
  });

  it("does NOT leak server-only origins into the browser policy", () => {
    expect(prod).not.toContain("api.groq.com");
  });

  it("is strict in production but loosened for HMR in dev", () => {
    expect(prod).not.toContain("'unsafe-eval'");
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws:");
  });
});
```

**Verify**: `bunx vitest run lib/__tests__/securityHeaders.test.ts` → all 4 tests
pass. Then `bun run test` → whole suite passes (no regressions in the existing
`config.test.ts` / `sponsoredTargets.test.ts` etc.).

### Step 3: Confirm headers are actually emitted by a running dev server

Start the dev server in the background, then read the headers with `curl`. **Do
NOT run `bun run build`** at any point (it corrupts the dev `.next/`).

```bash
# from web/ — start dev in the background
bun run dev
# wait until it logs "Ready" / "Local: http://localhost:3000", then in another shell:
curl -sI http://localhost:3000/discover | grep -iE "content-security-policy|x-frame-options|x-content-type-options|referrer-policy|strict-transport-security"
```

**Verify**: the `curl` output contains all five header names, e.g.:
```
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline' ...
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
strict-transport-security: max-age=63072000; includeSubDomains; preload
```
(The CSP value in dev will include `'unsafe-eval'` and `ws:` — that is expected.)

### Step 4: Manually smoke the three flows the CSP is most likely to break

With the dev server still running, open `http://localhost:3000` in a real
browser, open DevTools → Console, and exercise the flows below. A too-strict
`connect-src`/`img-src`/`script-src` fails **silently in the network layer**;
the only reliable signal is a `Refused to ...` / `Content Security Policy`
violation line in the Console.

Check, watching the Console for any `Content-Security-Policy` / `Refused to
connect/load` errors:
1. **Walrus cover image** — go to `/discover`; event cards / an event page must
   render their cover images (served from `aggregator.walrus-testnet.walrus.space`
   as `<img>`). A broken image + a CSP `img-src` console error = `img-src` is
   wrong.
2. **Icons render** — the Iconify icons across the UI (e.g. landing footer
   social icons) must appear. Missing icons + a CSP error on `code.iconify.design`
   or `api.iconify.design` = `script-src`/`connect-src` is wrong.
3. **zkLogin sign-in** (only if `NEXT_PUBLIC_ENOKI_API_KEY` is set in your
   `web/.env.local`) — click Google sign-in; it must redirect to
   `accounts.google.com` and return to `/auth` without a CSP error. If Enoki is
   not configured locally, **skip this and note it** — do not invent a key.
4. **Seal decrypt** (only if you have a ticket/forum message to decrypt locally)
   — opening an encrypted forum message must not throw a CSP error on
   `seal-aggregator-testnet.mystenlabs.com`. If you cannot reach a Seal-gated
   view locally, **skip and note it**.

**Verify**: For each flow you could exercise, the DevTools Console shows **no**
`Content-Security-Policy` / `Refused to connect`/`load`/`run` violations. Record
which flows you exercised and which you skipped (and why) in your hand-back. If a
flow you *can* exercise produces a CSP violation, that is a STOP condition — see
below.

Stop the dev server when done.

## Test plan

- **New test file**: `web/lib/__tests__/securityHeaders.test.ts` (Step 2),
  covering: (a) `frame-ancestors 'none'` + base directives present; (b) all real
  runtime origins present in the right directives; (c) `api.groq.com` (server-only)
  is **absent**; (d) prod strict vs dev loosened (`'unsafe-eval'`/`ws:`).
- **Structural pattern to copy**: `web/lib/__tests__/sponsoredTargets.test.ts`
  (import a value from a config module, assert membership).
- **Runtime verification** (Step 3 + 4): `curl -sI` shows the five headers; manual
  browser smoke shows no CSP console violations on the exercisable flows.
- Verification command: `bun run test` → all pass, including the 4 new tests in
  `securityHeaders.test.ts`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bunx tsc --noEmit` exits 0 with no output. (from `web/`)
- [ ] `bun run lint` exits 0. (from `web/`)
- [ ] `bun run test` exits 0; `web/lib/__tests__/securityHeaders.test.ts` exists and its tests pass.
- [ ] `grep -c "Content-Security-Policy" web/next.config.ts` returns ≥ 1, and `grep -c "frame-ancestors" web/next.config.ts` returns ≥ 1. (from repo root)
- [ ] With `next dev` running: `curl -sI http://localhost:3000/discover | grep -ci -E "content-security-policy|x-frame-options|x-content-type-options|referrer-policy|strict-transport-security"` returns `5`.
- [ ] Manual browser smoke (Step 4): no CSP console violations on every flow you were able to exercise; skipped flows are explicitly listed with the reason.
- [ ] No files outside the in-scope list are modified: `git status --porcelain` (repo root) shows changes only to `web/next.config.ts` and `web/lib/__tests__/securityHeaders.test.ts`.
- [ ] `git diff --stat 957206b..HEAD -- web/lib/staffKey.ts web/lib/config.ts` (repo root) is empty (you did NOT edit the out-of-scope files).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check is non-empty, OR the `web/next.config.ts` you open does not
  match the 13-line excerpt in "Current state" (the codebase drifted since this
  plan was written — re-derive the origin list before proceeding).
- A Step-4 flow you **can** exercise (Walrus image, icons, zkLogin, or Seal)
  produces a `Content-Security-Policy` console violation. Do **not** fix it by
  globally widening to `*` or adding `'unsafe-eval'` to production. Report the
  exact refused URL + directive; the correct fix is adding that specific origin
  to the right directive array (likely a Walrus/Seal/Enoki subdomain or an
  Iconify endpoint this plan missed) — but confirm the origin against
  `web/lib/config.ts` / the SDK before adding it.
- You find the app legitimately needs a nonce-based CSP (e.g. a security
  reviewer rejects `script-src 'unsafe-inline'`). That is a larger change
  (middleware + nonce propagation to every inline script) and is **out of scope**
  for this plan — report and stop.
- `bun run dev` fails to start, or the page is blank with `Cannot find module
  './xxx.js'` (a corrupted dev bundle, usually from a prior `bun run build`):
  stop the dev server, `rm -rf web/.next`, restart `bun run dev`, and retry once.
  If still broken, STOP and report.
- Any step's verification fails twice after a reasonable fix attempt.
- The fix appears to require editing `web/lib/staffKey.ts`, `web/lib/config.ts`,
  `web/app/layout.tsx`, a route handler, or any other out-of-scope file.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **What a reviewer should scrutinize**: the `connect-src`/`img-src` allowlist
  vs the real runtime origins. If a new external service is wired in later
  (e.g. DeepBook Predict is un-deferred — `web/lib/config.ts:149-163`; a new
  Walrus/Seal endpoint; a mainnet RPC; an analytics script), its origin **must**
  be added to the matching directive array in `web/next.config.ts` or it will be
  silently CSP-blocked in production. The new `securityHeaders.test.ts` will not
  catch a *missing* origin — only a browser/`curl` smoke does.
- **Env-overridable origins**: `WALRUS_PUBLISHER`, `WALRUS_AGGREGATOR`,
  `USDC_COIN_TYPE`, `SUI_NETWORK`, Enoki keys are overridable via `NEXT_PUBLIC_*`
  env vars (`web/lib/config.ts`). The CSP here hardcodes the **testnet** Walrus
  hosts and both Sui fullnodes; if a deploy overrides Walrus to a different host
  via env, the CSP must be updated to match (the header list is static, not
  derived from `process.env` at request time). Consider this when promoting to
  mainnet.
- **`'unsafe-inline'` on `script-src`/`style-src`** is a known weakening,
  accepted here because Next + `next/script` inline scripts and shadcn/next-themes
  inline styles make a nonce-based policy a much larger change. Tracked as the
  obvious hardening follow-up if a stricter posture is required.
- **DEFERRED to v2 (explicitly NOT in this plan)**: move the raw ed25519 staff
  signing key out of `localStorage` (`web/lib/staffKey.ts:30`, key
  `hostit.staffSigner.secret`) into a non-exfiltratable store (e.g. a
  non-extractable WebCrypto key, or signing inside a Web Worker / isolated
  origin so script-context XSS can't read the raw secret). This plan reduces XSS
  *delivery* (no remote `script-src`) and clickjacking, but a script that does
  run can still read `localStorage`. The file already documents this as an
  accepted CodeQL risk (`web/lib/staffKey.ts:13-22`); the deferral is intentional
  and should be filed as its own issue. No credential value appears in this plan;
  if/when the key store changes, rotate any staff keys that were ever persisted
  in plaintext `localStorage`.
- **HSTS `preload`**: the value includes `preload`. Only submit the domain to the
  HSTS preload list once you are certain every subdomain is HTTPS-only — otherwise
  drop `preload` from the directive in `web/next.config.ts`.
