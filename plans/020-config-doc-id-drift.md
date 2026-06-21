# Plan 020: Fix package-id drift across README/DEPLOYING/.env.local and pin the Move framework SHA

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```bash
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- README.md DEPLOYING.md Move.toml Move.lock Published.toml web/lib/config.ts
> ```
> If any of these tracked in-scope files changed since this plan was written,
> compare the "Current state" excerpts below against the live code before
> proceeding; on a mismatch, treat it as a STOP condition. (`web/.env.local`
> is git-ignored and will NOT appear in this diff — that is expected; see
> Step 3.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `957206b`, 2026-06-20
- **Issue**: —

> **Planning-note for the reviewer (not a task):** the dispatch brief for this
> plan referenced an SHA of `9b169c0`/`9cddf8b`, but the live `HEAD` at write
> time is `957206b` (working tree clean except the untracked `plans/`
> directory). All cited file contents below were read first-hand at `957206b`
> and match the finding evidence, so the plan stands. The "Planned at" SHA is
> the real one (`957206b`). If you rebased/branched between the brief and now,
> just confirm the drift check above is clean.

## Why this matters

Three independent "stale identifier" drifts make the on-chain deployment story
self-contradictory and set a footgun for the next deployer:

1. **`README.md:7` advertises a package id (`0xb5c952…dffcc0f`) that exists
   nowhere on chain or in this repo.** The repo's own source of truth
   (`Published.toml`, version 1 = `0x80ffb7c9…e3e3f0`) and README's own
   deployment table (`README.md:149`) disagree with the status line. A reader
   who copies the status-line id gets a non-existent package.
2. **`web/.env.local` overrides the package id under the wrong env var name
   (`NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID`).** The frontend (`web/lib/config.ts`)
   reads `NEXT_PUBLIC_HOSTIT_PACKAGE_ID`, so that override is silently ignored
   by the app. The committed template `web/.env.local.example:24` already uses
   the correct name — the local file simply drifted. **Caveat (read Step 3
   carefully):** that same old var name *is* still read by one script
   (`web/scripts/sponsor-smoke.ts:35`), so a blind rename changes what the
   smoke script targets. We fix the footgun without breaking the script.
3. **`Move.toml:11` pins the Sui framework to a moving branch
   (`rev = "framework/testnet"`)** while `Move.lock` has already resolved it to
   a concrete commit (`94ad8ccd…`). A moving branch means a fresh checkout can
   silently pick up a different framework, producing non-reproducible builds —
   exactly what `DEPLOYING.md:79` warns to fix before mainnet.

When this lands: the docs name the real deployed id, the local env override
actually takes effect (or is harmlessly removed), and the Move build is pinned
to a reproducible framework commit. This is documentation/operator-hygiene
only — **no Move source and no app logic changes**.

## Current state

Files in scope and their role:

- `README.md` — project readme; line 7 status line has the phantom id; the
  correct id lives in the table at line 149 and the versioning note at 155.
- `DEPLOYING.md` — deploy/upgrade guide; line 69 (type-origin example) cites
  the phantom `0xb5c952…` id and a stale "v3"; line 79 itself recommends the
  framework-SHA pin this plan performs.
- `Published.toml` — Sui automated address-management state; **authoritative**
  for the deployed id/version. Do NOT edit it; it is the source of truth we
  reconcile the docs against.
- `Move.toml` — Move package manifest; line 11 pins the framework to a branch.
- `Move.lock` — generated lockfile (do NOT hand-edit); holds the resolved
  framework commit SHA we copy into `Move.toml`.
- `web/lib/config.ts` — single source of truth for on-chain ids; reads the
  *correct* env var names. Do NOT edit; we reconcile `.env.local` to it.
- `web/.env.local.example` — committed env template; already correct (uses
  `NEXT_PUBLIC_HOSTIT_PACKAGE_ID`). Reference, not edited.
- `web/.env.local` — **git-ignored local file** with the wrong override name
  AND real-looking secrets. Edited as an operator-hygiene step (Step 3).
- `web/scripts/sponsor-smoke.ts` — reads the OLD var name; the reason Step 3 is
  careful rather than a blind rename. Reference, not edited.

### The phantom id (`0xb5c952…`) appears in exactly two places

```
README.md:7:> **Status:** live on **Sui testnet**. Move package `hostit_ticket`, latest version `0xb5c952…dffcc0f`. See [On-chain deployment](#on-chain-deployment).
DEPLOYING.md:69:... a `predict::RangeMarket` created after v3 reports `0xb5c952…::predict::RangeMarket<…>` — so `RANGE_MARKET_TYPE` must use `PACKAGE_ID_LATEST`, **not** the original `PACKAGE_ID`.
```
(Verified: `grep -rn "0xb5c952" .` returns only these two lines, both in docs —
nothing on chain, nothing in `config.ts`, nothing in `Published.toml`.)

### The authoritative deployed id (version 1, fresh publish)

`Published.toml`:
```
[published.testnet]
chain-id = "4c78adac"
published-at = "0x80ffb7c9ffe2eee4d69cb69f1bb7fb5403f90aa1492b91e4fdd9fa2dcde3e3f0"
original-id = "0x80ffb7c9ffe2eee4d69cb69f1bb7fb5403f90aa1492b91e4fdd9fa2dcde3e3f0"
version = 1
```

README's own (correct) table and note:
```
README.md:149:| Package (fresh v1 — original == latest; all calls + type origins) | `0x80ffb7c9ffe2eee4d69cb69f1bb7fb5403f90aa1492b91e4fdd9fa2dcde3e3f0` |
README.md:155:> **Package versioning (Sui upgrades):** this is a **fresh publish (version 1)** ...
```

`web/lib/config.ts` (also confirms the same id and the correct env var names):
```
web/lib/config.ts:24:export const PACKAGE_ID =
web/lib/config.ts:25:  process.env.NEXT_PUBLIC_HOSTIT_PACKAGE_ID ??
web/lib/config.ts:26:  "0x80ffb7c9ffe2eee4d69cb69f1bb7fb5403f90aa1492b91e4fdd9fa2dcde3e3f0";
web/lib/config.ts:37:  process.env.NEXT_PUBLIC_HOSTIT_PACKAGE_LATEST_ID ??
```

**Shortened form to use in prose:** write `0x80ffb7c9…e3e3f0` (matching the
existing `0x80ffb7c9…e3e3f0` style already used at `DEPLOYING.md:20-23`), not
the full 64-hex id, when replacing inline prose mentions. Use the full id only
where the doc already shows full ids (e.g. tables).

### The `.env.local` env-var-name drift

`web/.env.local` (git-ignored; line 17 — DO NOT copy its value into the plan or
into git):
```
web/.env.local:15:# Optional override for the deployed package id
web/.env.local:16:# (defaults to the testnet deploy recorded in lib/config.ts)
web/.env.local:17:NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID=0x6cf071ec...   (value redacted in this plan)
```

The committed template uses the correct name (blank value):
```
web/.env.local.example:22:# Optional overrides for the v3 (hostit_ticket) testnet deploy.
web/.env.local.example:23:# All default to the values recorded in lib/config.ts — leave unset to use them.
web/.env.local.example:24:NEXT_PUBLIC_HOSTIT_PACKAGE_ID=
```

**The old name is NOT fully dead** — one script still reads it:
```
web/scripts/sponsor-smoke.ts:34:const PACKAGE_ID =
web/scripts/sponsor-smoke.ts:35:  process.env.NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID ??
web/scripts/sponsor-smoke.ts:36:  "0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb";
```
So in `web/.env.local`, *renaming* the key (rather than adding the correct one)
would change which package `bun run smoke:sponsor` targets. Step 3 handles this
explicitly.

### The moving framework rev vs the resolved lock SHA

`Move.toml`:
```
Move.toml:11:Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/testnet" }
```

`Move.lock` (already resolved to a concrete commit — copy THIS SHA):
```
Move.lock:8:source = { git = "...move-stdlib", rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943" }
Move.lock:14:source = { git = "...sui-framework", rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943" }
```

`DEPLOYING.md` already prescribes this fix:
```
DEPLOYING.md:79:- Pin the `Sui` framework dependency in `Move.toml` to a specific commit SHA (currently `rev = "framework/testnet"`).
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Move build (from repo root) | `sui move build` | exit 0, "BUILDING hostit_ticket", no errors |
| Confirm phantom id gone | `grep -rn "0xb5c952" /Users/dadadave/Dev/HostIT/sui-ticket` (excl. this plan file) | only matches inside `plans/020-config-doc-id-drift.md`; no matches in `README.md`/`DEPLOYING.md` |
| Confirm framework rev pinned | `grep -n 'rev = ' /Users/dadadave/Dev/HostIT/sui-ticket/Move.toml` | shows `rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943"`, not `framework/testnet` |
| Frontend typecheck (from `web/`) | `bunx tsc --noEmit` | exit 0, no output |
| Frontend tests (from `web/`) | `bun run test` | all pass |
| Git status | `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` | only the in-scope tracked files + the untracked `plans/` (see Done criteria) |

Notes:
- Package manager is **bun only** — never `npm`/`pnpm`. Run `bunx tsc`/`bun run`
  from `/Users/dadadave/Dev/HostIT/sui-ticket/web`.
- **Never run `bun run build`** while a `bun run dev` is running — it corrupts
  `.next/`. This plan does not require any build; `bunx tsc --noEmit` is the
  frontend gate.
- `sui` CLI commands run from the repo root
  `/Users/dadadave/Dev/HostIT/sui-ticket`. If the `sui` CLI is not installed in
  your environment, see STOP conditions — do not skip the Move verification.

## Scope

**In scope** (the only files you should modify):
- `README.md` (Step 1)
- `DEPLOYING.md` (Step 2)
- `web/.env.local` (Step 3 — git-ignored local file; will not show in git diff)
- `Move.toml` (Step 4)
- `plans/README.md` (final status update, if it exists)

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/config.ts` — already correct; it is the source of truth we
  reconcile *to*, not change.
- `Published.toml` — Sui-generated authoritative publish state; never
  hand-edit. We read it; we do not write it.
- `Move.lock` — generated lockfile; never hand-edit. We copy its SHA into
  `Move.toml`; `sui move build` re-derives the lock.
- `web/.env.local.example` — already uses the correct var name; nothing to do.
- `web/scripts/sponsor-smoke.ts` — out of scope for THIS plan (it intentionally
  reads the old var name and has its own default). Do not "fix" it here; if its
  var name should be unified, that is a separate follow-up (see Maintenance
  notes). Touching it risks the smoke contract `bun run smoke:sponsor` relies
  on.
- Any `sources/*.move` or `tests/*.move` — no Move source changes; the only
  Move-tree edit is the `Move.toml` framework `rev`.
- `web/.gitignore` / git tracking of `.env.local` — leave it git-ignored.

## Git workflow

- Branch: `advisor/020-config-doc-id-drift`
  ```bash
  git -C /Users/dadadave/Dev/HostIT/sui-ticket checkout -b advisor/020-config-doc-id-drift
  ```
- Commit per logical unit; **conventional-commit** style (matches repo history,
  e.g. `aa1de4a chore(deploy): roll config to fresh v1 package 0xd61c2a`).
  Suggested messages:
  - `docs(readme): fix status-line package id to deployed v1 (0x80ffb7c9…)`
  - `docs(deploying): refresh type-origin example to deployed v1 id`
  - `build(move): pin Sui framework rev to lock SHA 94ad8ccd`
  - (`.env.local` is git-ignored, so it produces no commit — that is expected.)
- Do **NOT** push or open a PR. The repo flow is issue → branch → PR done by a
  human/maintainer; the `gh` CLI may hang in this environment. Leave the branch
  local.

## Steps

### Step 1: Fix the README status-line package id

In `README.md`, line 7, the status line names a non-existent id. Replace the
phantom id with the deployed v1 id and reword "latest version" (there are no
upgrades — it is a fresh v1).

Current line 7:
```
> **Status:** live on **Sui testnet**. Move package `hostit_ticket`, latest version `0xb5c952…dffcc0f`. See [On-chain deployment](#on-chain-deployment).
```

Change it to (uses the short `0x80ffb7c9…e3e3f0` form and "version 1", matching
the table at :149 and the note at :155):
```
> **Status:** live on **Sui testnet**. Move package `hostit_ticket`, version 1 (`0x80ffb7c9…e3e3f0`). See [On-chain deployment](#on-chain-deployment).
```

Do not touch lines 149 or 155 — they are already correct.

**Verify**:
```bash
grep -n "0xb5c952" /Users/dadadave/Dev/HostIT/sui-ticket/README.md ; echo "exit=$?"
```
→ no matching lines, `exit=1` (grep finds nothing).
```bash
grep -n "0x80ffb7c9…e3e3f0\|version 1" /Users/dadadave/Dev/HostIT/sui-ticket/README.md
```
→ line 7 now shows `version 1` and `0x80ffb7c9…e3e3f0`.

### Step 2: Refresh the DEPLOYING type-origin example

In `DEPLOYING.md`, line 69, the type-origin example cites the phantom
`0xb5c952…` id and a stale "v3". Update it to the deployed v1 id and drop the
"after v3" phrasing (this is a fresh v1; type origin equals `PACKAGE_ID` today).
Keep the pedagogical point intact (the example still teaches "match the on-chain
`objectType` to the `*_TYPE` constant").

Current line 69:
```
The most common upgrade bug is a frontend constant pointing at the wrong package version, which silently makes queries return nothing. After deploying, confirm a freshly created object's on-chain `objectType` exactly matches the `*_TYPE` constant the UI filters on. For example, a `predict::RangeMarket` created after v3 reports `0xb5c952…::predict::RangeMarket<…>` — so `RANGE_MARKET_TYPE` must use `PACKAGE_ID_LATEST`, **not** the original `PACKAGE_ID`.
```

Replace with (current-state-accurate; on a future upgrade `PACKAGE_ID_LATEST`
diverges, which is exactly when this rule bites — keep that framing):
```
The most common upgrade bug is a frontend constant pointing at the wrong package version, which silently makes queries return nothing. After deploying, confirm a freshly created object's on-chain `objectType` exactly matches the `*_TYPE` constant the UI filters on. Today (fresh v1) every type origin equals `0x80ffb7c9…e3e3f0`, so a `predict::RangeMarket` reports `0x80ffb7c9…::predict::RangeMarket<…>`. After the first in-place upgrade, newly created objects of an upgrade-introduced struct report the **new** package id — so that struct's `*_TYPE` must use `PACKAGE_ID_LATEST` (or its own pinned origin), **not** the original `PACKAGE_ID`.
```

Do not touch line 79 in this step — it is corrected implicitly by Step 4, but
the prose at :79 ("currently `rev = "framework/testnet"`") may be left as a
historical note OR updated; updating it is optional and low value. If you choose
to update it for accuracy, change `(currently \`rev = "framework/testnet"\`)` to
`(now pinned to the Move.lock commit SHA)`. Either is acceptable; prefer leaving
it unless trivially clean.

**Verify**:
```bash
grep -n "0xb5c952\|after v3" /Users/dadadave/Dev/HostIT/sui-ticket/DEPLOYING.md ; echo "exit=$?"
```
→ no matches, `exit=1`.
```bash
grep -n "0x80ffb7c9…e3e3f0" /Users/dadadave/Dev/HostIT/sui-ticket/DEPLOYING.md
```
→ shows the updated line 69 (in addition to the pre-existing lines 20–23).

### Step 3: Reconcile the `web/.env.local` package-id override (git-ignored)

> **This file is git-ignored** (`git check-ignore web/.env.local` → match).
> Editing it produces **no git diff and no commit** — that is expected, not a
> failure. It is an operator-hygiene edit so the local dev env behaves as the
> docs describe.
>
> **Secret-safety:** `web/.env.local` also contains real-looking secret values
> (an Enoki private key, a Google OAuth client secret, a MemWal delegate key, a
> Groq key). Do **not** print the file's contents to logs, do **not** copy any
> value into a commit, a PR, this plan, or any report, and confirm the file
> stays git-ignored before you finish (Done criteria has a check). Edit only the
> single package-id line; leave every secret line byte-for-byte unchanged.

The drift: line 17 sets the override under `NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID`,
but the app reads `NEXT_PUBLIC_HOSTIT_PACKAGE_ID` (see Current state). However,
`web/scripts/sponsor-smoke.ts:35` still reads the OLD name — so do **not** simply
delete or rename it blindly.

Choose ONE of these two safe resolutions (prefer **3a**):

**3a (recommended) — neutralize the dead app-override, leave the script var:**
The value at line 17 is a *stale* id that the app ignores anyway and that you
should not silently promote into the app. Comment the line out so neither the
app nor the smoke script picks up a stale package id (the smoke script then
falls back to its own in-file default at `sponsor-smoke.ts:36`):
- Change line 17 from
  `NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID=<stale-id>`
  to
  `# NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID=  # (removed: app reads NEXT_PUBLIC_HOSTIT_PACKAGE_ID; default lives in lib/config.ts)`
- Leave the value blank in the comment (do not re-record the stale id).

This makes the app use the correct default from `lib/config.ts` and leaves the
smoke script on its documented default — no surprise package switch.

**3b (only if you have an explicit current id to set) — add the correct key:**
If, and only if, the operator/you have a confirmed package id to override with,
add the correctly named line and remove the old one:
- Add `NEXT_PUBLIC_HOSTIT_PACKAGE_ID=<confirmed-id>`
- Comment out/remove `NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID` as in 3a.
Do not invent an id. If you do not have a confirmed id, use 3a.

**Verify** (no value echoed — only key presence/absence):
```bash
grep -c "^NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID=" /Users/dadadave/Dev/HostIT/sui-ticket/web/.env.local
```
→ `0` (the active, uncommented old key is gone).
```bash
git -C /Users/dadadave/Dev/HostIT/sui-ticket check-ignore web/.env.local ; echo "exit=$?"
```
→ prints `web/.env.local`, `exit=0` (still git-ignored).
```bash
git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain web/.env.local ; echo "(should be empty above)"
```
→ no output (git-ignored file, no staged/unstaged change tracked).

### Step 4: Pin the Move framework `rev` to the resolved lock SHA

In `Move.toml`, line 11, replace the moving branch `rev = "framework/testnet"`
with the concrete commit already resolved in `Move.lock` (lines 8 and 14):
`94ad8ccd0ed6c089a9fe072ff80c918b5ab44943`.

Current line 11:
```
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/testnet" }
```

Change `rev = "framework/testnet"` to:
```
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943" }
```

Do not change the `[addresses] hostit_ticket` line (line 16) — it must stay the
original published id `0x80ffb7c9…e3e3f0`.

**Verify**:
```bash
grep -n 'rev = ' /Users/dadadave/Dev/HostIT/sui-ticket/Move.toml
```
→ shows `rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943"`; no `framework/testnet`.
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move build
```
→ exit 0; builds `hostit_ticket` with no errors. (The build re-derives
`Move.lock`; the resolved Sui/MoveStdlib `rev` should remain
`94ad8ccd…` — i.e. `git diff -- Move.lock` shows no change to the pinned
revs. A diff that only normalizes formatting is acceptable; a diff that changes
the resolved commit is a STOP condition.)

### Step 5: Final repo-wide verification

Confirm the phantom id is gone everywhere except this plan file, and the
frontend still typechecks (the docs/env edits must not have touched app code).

**Verify**:
```bash
grep -rn "0xb5c952" /Users/dadadave/Dev/HostIT/sui-ticket --include="*.md" --include="*.ts" --include="*.toml" | grep -v "plans/020-config-doc-id-drift.md" ; echo "exit=$?"
```
→ no matches outside this plan file (the `| grep -v` removes this plan; the
pipeline exit is `1` when nothing else matches).
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit
```
→ exit 0, no output.
```bash
cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test
```
→ all tests pass (no test references the phantom id; this is a regression guard
that the env/doc edits didn't disturb the app).

## Test plan

No new automated tests — this is a docs + manifest + git-ignored-env change with
no app or Move logic delta. Verification is the existing gates:

- **Move:** `sui move build` (Step 4) proves the pinned `rev` still resolves and
  compiles. (Optionally `sui move test` — expected: all existing tests pass;
  not required since no `sources/`/`tests/` file changed.)
- **Frontend:** `bunx tsc --noEmit` and `bun run test` (Step 5) prove the
  `.env.local`/doc edits did not touch app behavior. Pattern reference for the
  test suite if you need to inspect it: `web/lib/__tests__/predict.test.ts`.
- **Doc correctness:** the `grep` gates in Steps 1, 2, 5 prove the phantom id is
  eradicated from tracked docs and that the deployed id is present.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "0xb5c952" /Users/dadadave/Dev/HostIT/sui-ticket --include="*.md" --include="*.ts" --include="*.toml" | grep -v "plans/020-config-doc-id-drift.md"` returns no lines (exit 1).
- [ ] `grep -n "version 1" /Users/dadadave/Dev/HostIT/sui-ticket/README.md` shows the updated line 7.
- [ ] `grep -n 'rev = ' /Users/dadadave/Dev/HostIT/sui-ticket/Move.toml` shows `rev = "94ad8ccd0ed6c089a9fe072ff80c918b5ab44943"` and no `framework/testnet`.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move build` exits 0.
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --name-only` shows only `README.md`, `DEPLOYING.md`, `Move.toml` (and `Move.lock` only if `sui move build` re-normalized it with the SAME pinned revs).
- [ ] `grep -c "^NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID=" /Users/dadadave/Dev/HostIT/sui-ticket/web/.env.local` returns `0`.
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket check-ignore web/.env.local` prints `web/.env.local` (still git-ignored; no secret committed).
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit` exits 0.
- [ ] `cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test` exits 0.
- [ ] No file outside the in-scope list is modified (`git status --porcelain`); `Published.toml`, `web/lib/config.ts`, `Move.lock` (beyond a same-rev re-normalization), and `web/scripts/sponsor-smoke.ts` are untouched.
- [ ] `plans/README.md` status row for plan 020 updated (if `plans/README.md` exists; if it does not exist, skip — do not create it).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows any in-scope tracked file changed since `957206b`, or
  any "Current state" excerpt does not match the live file (e.g. README:7 no
  longer contains `0xb5c952`, or `Published.toml` no longer says version 1 /
  `0x80ffb7c9…e3e3f0`). The codebase has drifted; re-derive the correct id from
  `Published.toml` before editing and report the mismatch.
- `sui move build` (Step 4) fails, OR it changes the resolved Sui/MoveStdlib
  commit in `Move.lock` to something other than
  `94ad8ccd0ed6c089a9fe072ff80c918b5ab44943` (the pin disagrees with the lock —
  do not paper over it).
- The `sui` CLI is not available in your environment, so Step 4's build cannot
  be verified. Do NOT pin the `rev` without being able to build it — report
  that Steps 1–3 are done and Step 4 needs an env with the Sui CLI.
- `web/.env.local` does not exist on this machine (it is git-ignored and
  per-developer). If it is absent, skip Step 3 and report that there was no
  local file to reconcile — do NOT create one (creating it risks materializing
  secret placeholders or a stale id).
- You discover the assumption "the old var name `NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID`
  is read only by `web/scripts/sponsor-smoke.ts`" is false — i.e.
  `grep -rn "NEXT_PUBLIC_SUI_TICKET_PACKAGE_ID" web/ --include="*.ts" --include="*.tsx"`
  returns a hit other than `web/scripts/sponsor-smoke.ts:35`. Then renaming in
  `.env.local` could affect app code; report before proceeding.
- Any verification fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **What a reviewer should scrutinize:** that the README/DEPLOYING ids now match
  `Published.toml` (`0x80ffb7c9…e3e3f0`, version 1) and that no Move source or
  app logic changed — this is a docs/manifest-only PR. The `.env.local` edit is
  invisible in the diff by design (git-ignored); the reviewer cannot see it, so
  the PR description should state it was done locally.
- **`Move.lock` interaction:** the framework `rev` is now pinned to
  `94ad8ccd…`. On the next intentional framework bump, update BOTH the
  `Move.toml` `rev` and let `sui move build` re-resolve `Move.lock`; keep them
  in sync. `DEPLOYING.md:79`'s mainnet checklist item is now partially
  satisfied (rev pinned); the remaining mainnet items there (UpgradeCap →
  multisig, mainnet re-publish) are out of this plan.
- **Deferred follow-up (intentionally NOT in this plan):** unify the package-id
  env var name in `web/scripts/sponsor-smoke.ts:35` to
  `NEXT_PUBLIC_HOSTIT_PACKAGE_ID` so there is a single override name across the
  app and scripts. Deferred because it changes the smoke-test contract
  (`bun run smoke:sponsor`) and warrants its own review; doing it here would
  widen scope past "docs/id drift."
- **Secret hygiene follow-up:** `web/.env.local` contains live-looking
  credentials (Enoki private key, Google client secret, MemWal delegate key,
  Groq key). They are git-ignored and were never in scope to commit. If any of
  these values were ever exposed (e.g. pasted into a log, PR, or shared
  channel), **rotate them** at their respective providers — do not reuse. This
  plan never reads or moves those values.
