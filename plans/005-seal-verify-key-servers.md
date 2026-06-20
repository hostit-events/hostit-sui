# Plan 005: Drive Seal `verifyKeyServers` off `NETWORK` instead of a hardcoded `false`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, do NOT create it;
> just report completion.)
>
> **Drift check (run first)**:
> ```bash
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- web/lib/seal.ts web/lib/config.ts
> ```
> If `web/lib/seal.ts` or `web/lib/config.ts` changed since this plan was
> written, compare the "Current state" excerpts below against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20

> NOTE FOR REVIEWER: this plan was authored against live `HEAD = 957206b`
> ("feat(forum): organizer admin — read, post-as-organizer, moderate [#37]"),
> NOT `9b169c0` as the planning brief assumed. The working tree was clean at
> author time and the two in-scope files match the excerpts below. The drift
> check above uses `957206b` deliberately.

## Why this matters

`web/lib/seal.ts` builds the one Seal `SealClient` used to **decrypt** every piece
of sensitive data in the app: forum message bodies (`forum.ts:138`), saved event
drafts (`drafts.ts:217`), and KYC/PII on the settings page
(`SettingsScreen.tsx:198`). That client is constructed with
`verifyKeyServers: false` as a **hardcoded literal** (`seal.ts:21`), with only a
`// true in production` comment — i.e. a dev shortcut that ships to production
unchanged. With verification off, the client trusts whatever key server the
configured object id resolves to without checking the server's authenticity,
weakening the threshold-encryption trust model on all three production decrypt
surfaces.

This plan makes verification **environment-driven**: ON whenever
`NETWORK !== "localnet"` (so testnet and mainnet both verify), with a localnet
escape hatch for offline dev. The change is one constant plus one field; the
risk is operational, not code: we must confirm the live MystenLabs testnet
key server actually *passes* verification with the installed `@mysten/seal`
version before relying on it (see STOP conditions — but note the SDK already
short-circuits verification for committee servers; details in "Current state").

## Current state

Files involved:

- `web/lib/seal.ts` — builds the shared `SealClient` via `makeSealClient`; the
  single place `verifyKeyServers` is set. Used by `sealEncrypt` (line 36) and
  `sealDecrypt` (line 98) in the same file.
- `web/lib/config.ts` — single source of truth for on-chain ids/targets/network.
  Exports `NETWORK` and the Seal constants `SEAL_KEY_SERVER_ID`,
  `SEAL_AGGREGATOR_URL`.
- (Not modified — these are the decrypt callers proving the blast radius:)
  `web/lib/forum.ts:138`, `web/lib/drafts.ts:217`,
  `web/components/screens/SettingsScreen.tsx:198`.

### `web/lib/seal.ts` — the hardcoded literal (lines 10–23)

```ts
10  import { PACKAGE_ID, SEAL_AGGREGATOR_URL, SEAL_KEY_SERVER_ID } from "./config";
11
12  export function makeSealClient(suiClient: any): SealClient {
13    return new SealClient({
14      suiClient,
15      // The MystenLabs testnet key server is a V2 *Committee* server, so its config
16      // MUST include the aggregator URL (the SDK throws "requires aggregatorUrl in
17      // config" otherwise). Independent/V1 servers must NOT set it.
18      serverConfigs: [
19        { objectId: SEAL_KEY_SERVER_ID, weight: 1, aggregatorUrl: SEAL_AGGREGATOR_URL },
20      ],
21      verifyKeyServers: false, // true in production
22    } as any);
23  }
```

This is the **only** occurrence of `verifyKeyServers` in app code (verified:
`grep -rn "verifyKeyServers" web/lib web/components web/app web/scripts` →
single hit at `seal.ts:21`).

### `web/lib/config.ts` — `NETWORK` (lines 12–16)

```ts
12  export const NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet") as
13    | "testnet"
14    | "mainnet"
15    | "devnet"
16    | "localnet";
```

### `web/lib/config.ts` — the Seal constants already exported (lines 91–96)

```ts
91  // === Seal testnet (threshold encryption for sensitive data) ===
92  export const SEAL_KEY_SERVER_ID =
93    "0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98";
94  export const SEAL_AGGREGATOR_URL = "https://seal-aggregator-testnet.mystenlabs.com";
95  // Seal policies live in OUR package (the seal_approve_* fns in `access`).
96  export const SEAL_POLICY_PACKAGE_ID = PACKAGE_ID;
```

### Why the MED risk is lower than it looks — installed SDK behavior

The installed SDK is `@mysten/seal@^1.1.3` (resolved to `1.1.3`; see
`web/package.json:20` and `web/node_modules/@mysten/seal/package.json`). Its key
server verification path **skips `/service` verification for committee-type
servers** — exactly the testnet server this app uses. From
`web/node_modules/@mysten/seal/dist/client.mjs:154-167`:

```js
154  async #loadKeyServers() {
...
160    if (keyServers.length === 0) throw new InvalidKeyServerError("No key servers found");
161    if (this.#verifyKeyServers) await Promise.all(keyServers.map(async (server) => {
162      if (server.serverType === "Committee") return;     // <-- committee: skip /service check
163      const config = this.#configs.get(server.objectId);
164      if (!await verifyKeyServer(server, this.#timeout, config?.apiKeyName, config?.apiKey)) throw new InvalidKeyServerError(`Key server ${server.objectId} is not valid`);
165    }));
166    return new Map(keyServers.map((server) => [server.objectId, server]));
167  }
```

And the default when the option is omitted is already `true`
(`client.mjs:27`: `this.#verifyKeyServers = options.verifyKeyServers ?? true;`),
so production code that simply *omits* the flag would verify. The option type is
`verifyKeyServers?: boolean` (`web/node_modules/@mysten/seal/dist/types.d.mts:24`).

**Implication for this plan**: flipping verification ON against the current
testnet committee server is expected to hit the `serverType === "Committee"`
early-return at line 162 and therefore NOT perform the network `/service`
check — i.e. it should not break decrypt today. The executor must still confirm
this empirically (Step 4 + STOP conditions), because the server's reported
`serverType` and the SDK version are external facts that can change.

### Repo conventions that apply

- **`config.ts` is the single source of truth** for network/ids/targets — derive
  the new flag there, not inline in `seal.ts`. (CLAUDE.md: "single source of
  truth for all on-chain IDs and Move targets".)
- **Package manager is `bun` only** — never `npm`/`pnpm`. Run frontend commands
  from `web/`.
- **Primary verification gate is `bunx tsc --noEmit`** (run from `web/`), then
  `bun run lint`, then `bun run test` (vitest). Do **NOT** run `bun run build`
  (it corrupts `.next/` if `bun run dev` is running).
- **Test pattern**: pure-logic unit tests live in `web/lib/__tests__/` and import
  the function under test directly. Model the new test after
  `web/lib/__tests__/config.test.ts` (imports `{ toUnits, fmtAmount } from "../config"`,
  uses `describe`/`it`/`expect` from `vitest`).

## Commands you will need

All run from `/Users/dadadave/Dev/HostIT/sui-ticket/web` unless noted.

| Purpose            | Command                                  | Expected on success            |
|--------------------|------------------------------------------|--------------------------------|
| Install (if needed)| `bun install`                            | exit 0                         |
| Typecheck (gate)   | `bunx tsc --noEmit`                       | exit 0, no errors              |
| Lint               | `bun run lint`                            | exit 0                         |
| Run one test file  | `bun run test seal`                       | the seal test file passes      |
| Run full test suite| `bun run test`                            | all pass (incl. new test)      |
| Confirm one literal | `grep -n "verifyKeyServers" lib/seal.ts` | shows the new env-driven value |

(Commands verified against this repo: `web/package.json` scripts are `dev`,
`build`, `lint`, `test` (vitest), etc.; the project uses bun. `bun run test`
forwards positional args to vitest, so `bun run test seal` filters by filename.)

## Scope

**In scope** (the only files you should modify or create):
- `web/lib/config.ts` — add a `SEAL_VERIFY_KEY_SERVERS` boolean derived from `NETWORK`.
- `web/lib/seal.ts` — consume that constant instead of the hardcoded `false`.
- `web/lib/__tests__/seal.test.ts` (**create**) — unit-test the new constant's
  truth table.

**Out of scope** (do NOT touch, even though they look related):
- `web/lib/forum.ts`, `web/lib/drafts.ts`,
  `web/components/screens/SettingsScreen.tsx` — they call `sealDecrypt`/
  `sealEncrypt`; the fix is entirely inside `makeSealClient`, so their call sites
  need no change. Editing them is unnecessary and widens the blast radius.
- `web/node_modules/**` — never edit vendored SDK code.
- The `SEAL_KEY_SERVER_ID` / `SEAL_AGGREGATOR_URL` values and the
  `serverConfigs` array shape — leave them exactly as-is; this plan only changes
  the `verifyKeyServers` field.
- The `@mysten/seal` dependency version in `package.json` — do NOT upgrade it as
  part of this plan.
- Any new env var plumbing beyond reading the existing `NETWORK`.

## Git workflow

- Branch: `advisor/005-seal-verify-key-servers`
  ```bash
  git -C /Users/dadadave/Dev/HostIT/sui-ticket checkout -b advisor/005-seal-verify-key-servers
  ```
- Commit per logical unit; conventional-commit messages (repo uses them — recent
  example: `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`).
  Suggested message:
  `security(seal): drive verifyKeyServers off NETWORK (on for non-localnet)`
- Do **NOT** push or open a PR. (Repo flow is issue → branch → PR and the `gh`
  CLI may hang; leave PR creation to the operator.)

## Steps

### Step 1: Add the `SEAL_VERIFY_KEY_SERVERS` constant in `config.ts`

In `web/lib/config.ts`, in the Seal block (right after `SEAL_AGGREGATOR_URL` on
line 94, before line 95's comment), add:

```ts
/**
 * Whether the Seal client verifies key-server authenticity. ON for every real
 * network (testnet/mainnet/devnet); OFF only on `localnet`, where there is no
 * reachable key server to verify against (dev escape hatch). Previously this
 * was a hardcoded `false` in lib/seal.ts shipped to prod.
 *
 * Note: the installed @mysten/seal SDK skips the /service check for
 * committee-type key servers even when this is true (it goes through the
 * aggregator), so enabling it does not add a network round-trip for the current
 * testnet committee server — it just stops trusting non-committee servers blindly.
 */
export const SEAL_VERIFY_KEY_SERVERS = NETWORK !== "localnet";
```

Place it logically with the other Seal exports so future readers find it next to
`SEAL_KEY_SERVER_ID`.

**Verify**:
```bash
grep -n "SEAL_VERIFY_KEY_SERVERS" lib/config.ts
```
→ prints the `export const SEAL_VERIFY_KEY_SERVERS = NETWORK !== "localnet";`
line (and any reference). At least one match.

### Step 2: Consume the constant in `seal.ts`

In `web/lib/seal.ts`:

1. Add `SEAL_VERIFY_KEY_SERVERS` to the existing import from `./config` (line 10),
   so it reads:
   ```ts
   import { PACKAGE_ID, SEAL_AGGREGATOR_URL, SEAL_KEY_SERVER_ID, SEAL_VERIFY_KEY_SERVERS } from "./config";
   ```
2. Replace the hardcoded field (line 21) — change exactly this line:
   ```ts
       verifyKeyServers: false, // true in production
   ```
   to:
   ```ts
       verifyKeyServers: SEAL_VERIFY_KEY_SERVERS, // on for every network except localnet
   ```

Leave the surrounding comment block (lines 15–17 about committee/aggregatorUrl)
and the `serverConfigs` array unchanged.

**Verify**:
```bash
grep -n "verifyKeyServers" lib/seal.ts
```
→ shows `verifyKeyServers: SEAL_VERIFY_KEY_SERVERS,` and NO occurrence of
`verifyKeyServers: false`.
```bash
grep -c "verifyKeyServers: false" lib/seal.ts
```
→ `0`.

### Step 3: Typecheck and lint

From `web/`:

**Verify**:
```bash
bunx tsc --noEmit && bun run lint
```
→ both exit 0 with no errors. (If `bun install` has never run in this checkout,
run it first.)

### Step 4: Add a unit test for the constant's truth table

Create `web/lib/__tests__/seal.test.ts`. Because `SEAL_VERIFY_KEY_SERVERS` is
evaluated at module-load time from `NETWORK` (itself read from
`process.env.NEXT_PUBLIC_SUI_NETWORK` at import), test it by setting the env var
and dynamically importing `../config` with a reset module registry, so each case
re-evaluates the constant. Model the file structure (vitest `describe`/`it`/
`expect`) on `web/lib/__tests__/config.test.ts`.

Target shape:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// SEAL_VERIFY_KEY_SERVERS is derived from NETWORK at module-load time, so each
// case sets the env var, resets the module registry, and re-imports config.
async function loadFlagFor(network: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (network === undefined) delete process.env.NEXT_PUBLIC_SUI_NETWORK;
  else process.env.NEXT_PUBLIC_SUI_NETWORK = network;
  const mod = await import("../config");
  return mod.SEAL_VERIFY_KEY_SERVERS;
}

describe("SEAL_VERIFY_KEY_SERVERS", () => {
  const original = process.env.NEXT_PUBLIC_SUI_NETWORK;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SUI_NETWORK;
    else process.env.NEXT_PUBLIC_SUI_NETWORK = original;
    vi.resetModules();
  });

  it("is true on testnet", async () => {
    expect(await loadFlagFor("testnet")).toBe(true);
  });
  it("is true on mainnet", async () => {
    expect(await loadFlagFor("mainnet")).toBe(true);
  });
  it("is true when network is unset (defaults to testnet)", async () => {
    expect(await loadFlagFor(undefined)).toBe(true);
  });
  it("is false only on localnet", async () => {
    expect(await loadFlagFor("localnet")).toBe(false);
  });
});
```

**Verify**:
```bash
bun run test seal
```
→ `seal.test.ts` runs and all 4 assertions pass. If the dynamic-import +
`vi.resetModules()` approach reports a flake or the constant doesn't re-evaluate,
see STOP conditions (do not weaken the assertions to force a pass).

### Step 5: Full test suite + final typecheck

**Verify**:
```bash
bunx tsc --noEmit && bun run test
```
→ `tsc` exits 0; the entire vitest suite passes including the new `seal.test.ts`.
The pre-existing files (`config.test.ts`, `drafts.test.ts`, `forum.test.ts`,
`predict.test.ts`, `sponsoredTargets.test.ts`, `moveErrors.test.ts`,
`pagination.test.ts`, `memwalAuth.test.ts`) must all still pass unchanged.

## Test plan

- **New file**: `web/lib/__tests__/seal.test.ts` (see Step 4). Cases:
  - happy path / production: `testnet` → `true`; `mainnet` → `true`.
  - default: env unset → `true` (because `NETWORK` defaults to `"testnet"`).
  - the regression this plan fixes / escape hatch: `localnet` → `false`.
- **Structural pattern**: model on `web/lib/__tests__/config.test.ts` (vitest,
  direct import of `../config`). The only addition is `vi.resetModules()` +
  dynamic `import` because the value is computed at module load from env.
- **Verification**: `bun run test` → all pass, including the 4 new assertions in
  `seal.test.ts`.
- **Note (not automatable here)**: there is no browser E2E layer in this repo, so
  the *runtime* "does the testnet committee server pass verification" check is a
  manual smoke step the owner performs in the running app (decrypt a forum
  message / draft / KYC blob on testnet and confirm it still succeeds). Capture
  the outcome in the PR description. See STOP conditions for what to do if it
  fails.

## Done criteria

Machine-checkable. ALL must hold (run from `web/` unless noted):

- [ ] `grep -n "export const SEAL_VERIFY_KEY_SERVERS = NETWORK !== \"localnet\";" lib/config.ts` returns exactly one match.
- [ ] `grep -c "verifyKeyServers: false" lib/seal.ts` returns `0`.
- [ ] `grep -n "verifyKeyServers: SEAL_VERIFY_KEY_SERVERS" lib/seal.ts` returns one match.
- [ ] `bunx tsc --noEmit` exits 0 with no errors.
- [ ] `bun run lint` exits 0.
- [ ] `bun run test` exits 0; `web/lib/__tests__/seal.test.ts` exists and its 4 assertions pass.
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows changes ONLY to `web/lib/config.ts`, `web/lib/seal.ts`, and `web/lib/__tests__/seal.test.ts` (no other files modified).
- [ ] `plans/README.md` status row updated (only if that file already exists).

## STOP conditions

Stop and report back (do not improvise) if:

- **Drift**: the code at `web/lib/seal.ts:10-23` or `web/lib/config.ts:12-16` /
  `:91-96` does not match the "Current state" excerpts (the codebase changed
  since `957206b`). In particular, if `verifyKeyServers` is already not `false`,
  or `SEAL_VERIFY_KEY_SERVERS` already exists.
- **The key assumption is false** — i.e. enabling verification breaks decrypt on
  testnet. Concretely, if after this change a Seal decrypt on **testnet** throws
  `InvalidKeyServerError` ("...is not valid" or "No key servers found") or the
  SDK reports the configured server's `serverType` as something OTHER than
  `"Committee"` (so the line-162 early-return does not apply and a real
  `/service` check runs and fails). Report the exact error and the observed
  `serverType`; do NOT revert to `verifyKeyServers: false` to "make it work" and
  do NOT bump the `@mysten/seal` version to chase it — both are out of scope and
  must be an explicit operator decision.
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching any out-of-scope file (e.g. you find a
  *second* `makeSealClient`-like client constructed elsewhere with its own
  `verifyKeyServers`). Report it instead of editing it.
- `bun install` / `bunx tsc` cannot run in the environment (missing toolchain) —
  report rather than guessing an alternative package manager (never use
  npm/pnpm).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **Runtime confirmation is the real gate.** The unit test only proves the
  *constant's* truth table; it does NOT prove the live testnet committee server
  passes verification. The reviewer should confirm a successful testnet decrypt
  (forum/draft/KYC) was performed with verification ON and noted in the PR.
- **SDK upgrades interact with this.** The safety of enabling verification rests
  on `@mysten/seal@1.1.3`'s `serverType === "Committee"` early-return
  (`client.mjs:162`) and on the testnet server actually being a committee server.
  If `@mysten/seal` is upgraded, or if a non-committee key server is added to
  `serverConfigs` in `config.ts`, re-validate that decrypt still works on every
  configured network — a future SDK could perform a `/service` check that the
  current server fails.
- **mainnet behavior is now load-bearing.** When the app points at mainnet,
  `SEAL_VERIFY_KEY_SERVERS` becomes `true` automatically. Ensure the mainnet Seal
  key-server id/aggregator configured in `config.ts` at that time is one that
  passes verification (or is committee-type) before flipping `NETWORK=mainnet`.
- **Deferred out of this plan** (intentionally): exposing the flag as its own
  `NEXT_PUBLIC_*` override env var. Deferred because `NETWORK` already captures
  the only distinction that matters (real network vs localnet) and adding a
  standalone override invites a footgun where someone disables verification in
  prod via env. Revisit only if a concrete need (e.g. a temporarily-broken
  mainnet key server) appears.
