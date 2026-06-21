# Plan 001: Add a frontend CI workflow that gates `web/` changes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist yet, do NOT create
> it as part of this plan — just report that it is missing; the index is owned
> by whoever generated this plan set.)
>
> **Drift check (run first)**: from the repo root
> `/Users/dadadave/Dev/HostIT/sui-ticket`, run
> `git diff --stat 957206b..HEAD -- .github/workflows/ web/package.json`
> If either in-scope-adjacent file changed since this plan was written, compare
> the "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Note: a NEW, untracked
> `.github/workflows/web.yml` is expected to be absent — this plan creates it.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: (none)

> **Planning note (read once, then proceed)**: This plan was commissioned
> against SHA `9b169c0`, but at authoring time the live `HEAD` was `957206b`
> (one commit ahead: `feat(forum): organizer admin … [#37]`). The working tree
> was clean at `957206b`. The commit between the two (`957206b`) touched
> `sources/forum.move`, `tests/forum_tests.move`, and several `web/lib/*` files
> but did **NOT** touch `.github/workflows/move.yml` or `web/package.json` — the
> two files this plan cites. So every "Current state" excerpt below is accurate
> as of `957206b`, and that is the SHA stamped above and used in the drift
> check. If your `HEAD` is something other than `957206b`, run the drift check
> and reconcile before proceeding.

## Why this matters

The repository has Move-package CI (`.github/workflows/move.yml`) but **no CI
for the `web/` Next.js app**. The Move workflow's path filter only fires on
`sources/**`, `tests/**`, `Move.toml`, `Move.lock`, `Published.toml`, and the
workflow file itself — `web/**` is deliberately excluded (see excerpt below).
That means the documented frontend correctness gates — `bunx tsc --noEmit`
(the primary gate), `bun run lint`, and `bun run test` (vitest) — **never run
in CI**. Frontend regressions on money/sponsor/predict code paths (the on-chain
write flow, the Enoki `SPONSORED_TARGETS` allowlist, the prediction-market PTB
constructors) can merge to `main` completely unguarded.

This plan adds a sibling workflow, `.github/workflows/web.yml`, that runs those
three gates on every push/PR touching `web/**`. It is the **prerequisite** that
turns every later test-adding plan into a real merge gate: without it, new
vitest tests are never executed by CI and provide no protection.

## Current state

### `.github/workflows/move.yml` — the ONLY workflow today (mirror its conventions)

The full file (`.github/workflows/move.yml:1-71`). Reproduce its style — comment
header explaining the path filter, `concurrency` with `cancel-in-progress`,
least-privilege `permissions`, `timeout-minutes`, pinned tool version, and
`actions/cache@v4` keyed on a lockfile hash:

```yaml
# .github/workflows/move.yml:1-31
name: Move CI

# Lint + test the Move package on every push/PR that touches the Move tree.
# The package lives at the repo ROOT (Move.toml, sources/, tests/), so no
# working-directory is needed. web/-only changes don't trigger this (path filter).

on:
  push:
    branches: [main]
    paths: [sources/**, tests/**, Move.toml, Move.lock, Published.toml, .github/workflows/move.yml]
  pull_request:
    paths: [sources/**, tests/**, Move.toml, Move.lock, Published.toml, .github/workflows/move.yml]

concurrency:
  group: move-ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  move:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      SUI_VERSION: testnet-v1.73.1
    steps:
      - uses: actions/checkout@v4
```

The caching block to mirror (`.github/workflows/move.yml:60-64`) — note the
`hashFiles(...)` key pattern, which the new workflow reuses against the bun
lockfile:

```yaml
      - name: Cache Move git deps (~/.move)
        uses: actions/cache@v4
        with:
          path: ~/.move
          key: move-${{ runner.os }}-${{ hashFiles('Move.toml', 'Move.lock') }}
```

The two run steps (`.github/workflows/move.yml:66-71`) are plain `run:` shell —
the web workflow follows the same shape, one named step per gate:

```yaml
      - name: Lint
        run: sui move build --lint --warnings-are-errors

      - name: Test
        run: sui move test
```

**Confirmation that `web/**` is excluded**: the `paths:` arrays above contain no
`web/` entry, so editing any frontend file does not trigger `Move CI`, and there
is no other workflow. Verified at authoring time:

```
$ ls .github/workflows/
move.yml            # ← only file; no web.yml
$ grep -rn "setup-bun\|oven-sh\|bunx tsc" .github
(no matches)
```

### `web/package.json` — exact script names the workflow invokes (`web/package.json:6-14`)

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "smoke:sponsor": "bun run scripts/sponsor-smoke.ts"
  },
```

So the gates are: `bunx tsc --noEmit` (typecheck — there is **no** `typecheck`
npm script; call `tsc` directly), `bun run lint` (→ `eslint .`), and
`bun run test` (→ `vitest run`, the non-watch runner). There is **no** `engines`
field and **no** `packageManager` field in `web/package.json`, and there is no
`.nvmrc` / `.node-version` / `.tool-versions` anywhere in the repo, so the
workflow must pin its own Node/bun versions explicitly (see Step 1).

### Lockfile — for `--frozen-lockfile` (verified)

The frontend lockfile is `web/bun.lock` (text, `lockfileVersion: 1`) — NOT
`bun.lockb` (binary) and NOT npm/pnpm/yarn. Confirmed:

```
$ head -3 web/bun.lock
{
  "lockfileVersion": 1,
  "configVersion": 1,
```

`bun install --frozen-lockfile` requires this file to be present and in sync.

### `web/tsconfig.json` — typecheck config (`web/tsconfig.json:1-41`)

`"noEmit": true`, `"strict": true`, `"skipLibCheck": true`,
`"moduleResolution": "bundler"`, Next plugin enabled. `bunx tsc --noEmit` from
within `web/` picks this up automatically — no extra flags needed.

### Test suite that CI will run (`bun run test` → `vitest run`)

`web/lib/__tests__/` contains: `config.test.ts`, `drafts.test.ts`,
`forum.test.ts`, `memwalAuth.test.ts`, `moveErrors.test.ts`,
`pagination.test.ts`, `predict.test.ts`, `sponsoredTargets.test.ts`; plus
`web/components/__tests__/TxLink.test.tsx`. These are chain-free unit tests (no
wallet/network) — see `web/lib/__tests__/predict.test.ts:52-63`, which asserts a
PTB constructor returns a `Transaction` whose `tx.getData().commands` has the
expected shape. They run headlessly in CI with no secrets.

### Repo conventions that apply here

- **Package manager is bun ONLY** — never `npm`/`pnpm`/`yarn` anywhere in the
  workflow. (Project rule from `CLAUDE.md` and user memory.)
- The frontend "primary verification gate" is `bunx tsc --noEmit`
  (`CLAUDE.md` → "Frontend correctness is verified with `bunx tsc --noEmit`
  + `bun run lint` + `bun run test`").
- **Never run `bun run build` in this workflow** — `CLAUDE.md` calls it out as a
  dev gotcha (it corrupts `.next/`); CI verification uses `tsc`, not a
  production build. This plan deliberately omits any `next build` step.
- Match `move.yml`'s structural conventions (comment header, `concurrency`,
  `permissions: contents: read`, `timeout-minutes`, pinned tool versions,
  `actions/cache@v4` keyed on a lockfile hash).

## Commands you will need

Run all of these from **`/Users/dadadave/Dev/HostIT/sui-ticket/web`** unless a
command is prefixed with "(repo root)".

| Purpose            | Command                                   | Expected on success                          |
|--------------------|-------------------------------------------|----------------------------------------------|
| Install (frozen)   | `bun install --frozen-lockfile`           | exit 0; "Saved lockfile" NOT printed         |
| Typecheck (gate 1) | `bunx tsc --noEmit`                        | exit 0, no errors                            |
| Lint (gate 2)      | `bun run lint`                             | exit 0                                       |
| Tests (gate 3)     | `bun run test`                             | all tests pass, exit 0                       |
| YAML well-formed   | (repo root) `bunx -y js-yaml .github/workflows/web.yml` | exit 0, prints parsed YAML; no parse error |
| Actionlint (opt.)  | (repo root) `actionlint .github/workflows/web.yml` | exit 0 if `actionlint` is installed (skip if not) |
| Drift check        | (repo root) `git diff --stat 957206b..HEAD -- .github/workflows/ web/package.json` | empty (no in-scope drift)        |
| Scope check        | (repo root) `git status --porcelain`      | exactly one new file: `.github/workflows/web.yml` |

Note: `bunx tsc`, `bun run lint`, and `bun run test` require dependencies
installed first (`bun install`). If `node_modules/` is missing locally, run
`bun install` before the three gates.

## Suggested executor toolkit

- This is a CI/YAML task — no project skill is required. Do NOT use any
  framework/codegen skill.
- Reference: the existing `.github/workflows/move.yml` is the canonical style
  exemplar in this repo. Read it in full before writing `web.yml`.
- GitHub Actions reference for the actions used: `actions/checkout@v4`,
  `oven-sh/setup-bun@v2`, `actions/cache@v4`, `actions/setup-node@v4`.

## Scope

**In scope** (the only file you create/modify):

- `.github/workflows/web.yml` (**create** — does not exist yet)

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/move.yml` — the Move workflow is correct as-is; do not edit
  its path filter or add web steps to it. Frontend CI is a separate workflow so
  the two job matrices, caches, and required-check names stay independent.
- `web/package.json` — do NOT add a `typecheck`, `ci`, or `engines` script. The
  workflow calls `bunx tsc --noEmit` directly; introducing scripts is a
  separate change and would widen this plan's blast radius.
- `web/bun.lock` — must NOT change. `bun install --frozen-lockfile` is read-only
  against it; if it gets rewritten, that is a STOP condition (see below).
- Any source file under `web/lib/`, `web/components/`, `web/app/`, or `sources/`.
- GitHub branch-protection settings (the "required check" step is a manual,
  out-of-band action documented in Step 4 — it is NOT a file change and is not
  performed by this plan).
- `plans/README.md` — do not create it if absent (see Executor instructions).

## Git workflow

Match the repo's observed conventions (recent log uses Conventional Commits with
a trailing issue ref, e.g. `957206b feat(forum): organizer admin … [#37]` and
`abab571 ci: extract sui CLI into an owned dir … [#43]`).

- Branch: `advisor/001-frontend-ci`
  - (repo root) `git checkout -b advisor/001-frontend-ci`
- One commit for the single new file. Message style — Conventional Commits:
  - `ci: add frontend CI workflow gating web/ changes`
  - Per repo policy, end the commit message body with the required
    `Co-Authored-By:` trailer if your harness adds one; otherwise a plain
    one-line message is fine.
- Do **NOT** push or open a PR unless the operator explicitly instructs it.
  (Repo flow is issue → branch → PR, and the `gh` CLI is known to hang in this
  environment — leave PR creation to the human.)

## Steps

### Step 1: Create `.github/workflows/web.yml`

Create the file at `/Users/dadadave/Dev/HostIT/sui-ticket/.github/workflows/web.yml`
with the content below. It mirrors `move.yml`: a comment header explaining the
path filter, `concurrency` with `cancel-in-progress`, `permissions: contents:
read`, `timeout-minutes`, pinned action versions, and `actions/cache@v4` keyed on
`hashFiles('web/bun.lock')`. The three gate steps are each a named `run:` step,
all using `working-directory: web` so `tsc`/`eslint`/`vitest` resolve the
frontend config and `node_modules`.

Pin a fixed bun version (do NOT use `latest` — pinning matches `move.yml`'s
`SUI_VERSION` discipline and keeps CI reproducible). Use Node 24 to match the
`@types/node` major in `web/package.json` (`"@types/node": "^24.0.0"`).

```yaml
name: Web CI

# Typecheck + lint + unit-test the Next.js app on every push/PR that touches
# the frontend tree. The app lives under web/ (its own package.json, tsconfig,
# and bun.lock), so every step runs with `working-directory: web`. Move-only
# changes don't trigger this (path filter); the Move package is gated by
# move.yml instead.

on:
  push:
    branches: [main]
    paths: [web/**, .github/workflows/web.yml]
  pull_request:
    paths: [web/**, .github/workflows/web.yml]

concurrency:
  group: web-ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  web:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4

      # Pin bun + Node so CI is reproducible (mirrors move.yml's pinned
      # SUI_VERSION). Bump these deliberately, in lockstep with the toolchain.
      - name: Set up bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.2.18

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24

      # Cache bun's global module store, keyed on the frozen lockfile.
      - name: Cache bun install (~/.bun/install/cache)
        uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: bun-${{ runner.os }}-${{ hashFiles('web/bun.lock') }}
          restore-keys: |
            bun-${{ runner.os }}-

      - name: Install dependencies
        run: bun install --frozen-lockfile

      # Primary gate (per CLAUDE.md): typecheck with the project tsconfig.
      - name: Typecheck
        run: bunx tsc --noEmit

      - name: Lint
        run: bun run lint

      - name: Unit tests (vitest)
        run: bun run test
```

Notes for the executor:

- The `bun-version: 1.2.18` above is a concrete pin. If `oven-sh/setup-bun`
  rejects that exact patch (rare), pick the nearest available 1.2.x release and
  note the substitution in your report — do NOT switch to `latest`.
- `hashFiles('web/bun.lock')` is repo-root-relative (GitHub evaluates
  `hashFiles` from the workspace root, **not** from `working-directory`), so the
  path must include the `web/` prefix even though job steps run inside `web/`.
- Keep the four substantive steps in this order: install → typecheck → lint →
  test (cheapest-failing-first puts the primary gate early; tests last).

**Verify**: from repo root,
`test -f .github/workflows/web.yml && echo EXISTS`
→ prints `EXISTS`.

### Step 2: Confirm the workflow YAML is well-formed

A malformed workflow silently never runs on GitHub, which would defeat the whole
plan. Validate it parses as YAML locally.

**Verify**: from repo root, `bunx -y js-yaml .github/workflows/web.yml`
→ exit 0 and prints the parsed structure (a JSON-ish dump of the `on`, `jobs`,
etc.). Any `YAMLException`/parse error → fix indentation and re-run.

(Optional, only if `actionlint` is already installed — do NOT install it:
`actionlint .github/workflows/web.yml` → exit 0, no diagnostics.)

### Step 3: Reproduce CI locally — run the three gates exactly as the workflow will

From `/Users/dadadave/Dev/HostIT/sui-ticket/web`, run the same commands the
workflow runs, to prove the gates are green at this SHA (so a freshly-added
workflow won't immediately fail `main`):

```bash
bun install --frozen-lockfile
bunx tsc --noEmit
bun run lint
bun run test
```

**Verify**: each command exits 0. In particular:
- `bun install --frozen-lockfile` must NOT print "Saved lockfile" and must NOT
  modify `web/bun.lock` (confirm with `git status --porcelain web/bun.lock` →
  empty).
- `bun run test` ends with vitest reporting all test files passed (the suite
  includes `predict.test.ts`, `sponsoredTargets.test.ts`, `forum.test.ts`,
  `config.test.ts`, `drafts.test.ts`, `memwalAuth.test.ts`,
  `moveErrors.test.ts`, `pagination.test.ts`, and `TxLink.test.tsx`).

If `bunx tsc --noEmit`, `bun run lint`, or `bun run test` fails at this SHA, that
is a pre-existing breakage, not something this plan introduced → **STOP** and
report (see STOP conditions); do not "fix" frontend source under this plan.

### Step 4: (Manual, out-of-band — NOT a file change) Mark "Web CI / web" as a required check

This step does not modify any file and is optional for plan completion — record
it for the repo owner. After the workflow has run once on a PR (so GitHub knows
the check name), a maintainer should add **`web`** (job id; displayed as
`Web CI / web`) to the branch-protection required status checks for `main`,
alongside the existing Move check. This is what makes the gate blocking.

- Path in GitHub UI: Settings → Branches → branch protection rule for `main` →
  "Require status checks to pass before merging" → add `web`.
- The `gh` CLI is known to hang in this environment; do this in the web UI or
  leave it for the human operator. Do NOT attempt to script branch protection.

**Verify**: not machine-checkable from the working tree; note in your report
whether this was done or deferred to the maintainer.

## Test plan

This plan adds CI infrastructure, not application code, so there are **no new
unit tests** to write — the "tests" are the existing vitest suite that the new
workflow now runs, plus the YAML-parse check.

- Existing suite is the structural reference for what CI executes: `bun run test`
  → `vitest run` over `web/lib/__tests__/*` and `web/components/__tests__/*`.
  Pattern exemplar: `web/lib/__tests__/predict.test.ts` (chain-free, asserts
  `tx.getData().commands` shape).
- Workflow validation: `bunx -y js-yaml .github/workflows/web.yml` parses
  cleanly (Step 2).
- Local CI dry-run: the four commands in Step 3 all exit 0.
- Final gate from repo root:
  `git status --porcelain` shows exactly one added file
  (`?? .github/workflows/web.yml`) and nothing else.

## Done criteria

Machine-checkable. ALL must hold (run from the indicated directory):

- [ ] (repo root) `test -f .github/workflows/web.yml && echo OK` → prints `OK`
- [ ] (repo root) `bunx -y js-yaml .github/workflows/web.yml` exits 0 (valid YAML)
- [ ] (repo root) `grep -q 'paths: \[web/\*\*' .github/workflows/web.yml && echo OK`
      → prints `OK` (push path filter targets `web/**`)
- [ ] (repo root) `grep -q "bun install --frozen-lockfile" .github/workflows/web.yml && grep -q "bunx tsc --noEmit" .github/workflows/web.yml && grep -q "bun run lint" .github/workflows/web.yml && grep -q "bun run test" .github/workflows/web.yml && echo OK`
      → prints `OK` (all three gates plus frozen install are present)
- [ ] (repo root) `grep -q "hashFiles('web/bun.lock')" .github/workflows/web.yml && echo OK` → prints `OK` (cache keyed on the bun lockfile)
- [ ] (repo root) `grep -Eq "npm |pnpm|yarn" .github/workflows/web.yml; test $? -ne 0 && echo OK`
      → prints `OK` (no npm/pnpm/yarn anywhere — bun only)
- [ ] (repo root) `grep -q "next build" .github/workflows/web.yml; test $? -ne 0 && echo OK`
      → prints `OK` (no production build step — avoids the `.next/` gotcha)
- [ ] (web) `bun install --frozen-lockfile` exits 0 and `git status --porcelain web/bun.lock` is empty (lockfile unchanged)
- [ ] (web) `bunx tsc --noEmit` exits 0
- [ ] (web) `bun run lint` exits 0
- [ ] (web) `bun run test` exits 0 (all existing vitest files pass)
- [ ] (repo root) `git status --porcelain` lists exactly one new file: `.github/workflows/web.yml` (no other file created/modified/deleted)

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check (`git diff --stat 957206b..HEAD -- .github/workflows/ web/package.json`)
  shows `.github/workflows/move.yml` or `web/package.json` changed, and the
  "Current state" excerpts no longer match the live files (the codebase drifted
  since this plan was written) — in particular if `web/package.json` no longer
  has `"test": "vitest run"` / `"lint": "eslint ."`, or if a second workflow now
  exists that already covers `web/**`.
- `.github/workflows/web.yml` already exists when you start (someone added web
  CI independently) — do not overwrite it; report and stop.
- `bun install --frozen-lockfile` fails because `web/bun.lock` is out of sync
  with `web/package.json`, OR running it rewrites `web/bun.lock`
  (`git status` shows it modified). That signals a lockfile/manifest mismatch
  that is out of this plan's scope — STOP and report; do not commit a changed
  lockfile.
- Any of `bunx tsc --noEmit`, `bun run lint`, or `bun run test` fails at the
  current SHA (Step 3) for reasons unrelated to your new file. This plan must
  NOT modify frontend source to make a pre-existing failure pass — report the
  failing output and stop.
- A step's verification fails twice after a reasonable fix attempt.
- Completing the task appears to require touching any out-of-scope file
  (e.g. adding a `typecheck` script to `web/package.json`, or editing
  `move.yml`).

## Maintenance notes

For the human/agent who owns this after the change lands:

- **Required-check wiring is manual** (Step 4): the workflow only *blocks*
  merges once `web` is added to `main`'s branch-protection required checks. Until
  then it runs but is advisory. A reviewer should confirm this was done.
- **Version pins drift**: `bun-version: 1.2.18` and `node-version: 24` are
  explicit pins mirroring `move.yml`'s `SUI_VERSION` discipline. Bump them
  deliberately; if `web/package.json`'s `@types/node` major changes, revisit
  `node-version`.
- **This is the gate-enabler for later plans**: any subsequent plan that adds
  vitest tests under `web/` relies on this workflow to actually execute them in
  CI. If this workflow is ever removed or its `web/**` path filter narrowed,
  those tests silently stop gating merges.
- **Path-filter caveat**: the `web/**` filter means a change that affects the
  frontend but lives *outside* `web/` (none exist today) would not trigger this
  job. If shared tooling moves to the repo root later, widen the filter.
- **What a reviewer should scrutinize in the PR**: (1) no `npm`/`pnpm`/`yarn`
  and no `next build`; (2) `working-directory: web` on the job (or per step) so
  `tsc`/`eslint`/`vitest` resolve the right config; (3) `hashFiles('web/bun.lock')`
  uses the repo-root-relative path; (4) `permissions: contents: read` and
  `concurrency` present, matching `move.yml`.
- **Deferred out of this plan** (intentionally): adding a `next build` smoke,
  uploading coverage, a `bun run smoke:sponsor` job (needs `ENOKI_PRIVATE_API_KEY`
  — a server-only secret; keep it out of PR CI), and any matrix across Node
  versions. Add later as separate plans if desired.
