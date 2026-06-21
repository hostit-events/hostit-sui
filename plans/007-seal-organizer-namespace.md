# Plan 007: Domain-separate the organizer Seal identity so ticket holders cannot decrypt organizer-gated data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, you may create a
> minimal one with just this plan's row, or skip — do not invent rows for
> other plans you have not seen.)
>
> **Drift check (run first)**:
> ```
> git -C /Users/dadadave/Dev/HostIT/sui-ticket diff --stat 957206b..HEAD -- sources/access.move web/lib/seal.ts web/lib/forum.ts tests/hostit_ticket_tests.move
> ```
> Expected: empty output (no in-scope file changed since this plan was written).
> If any in-scope file changed, compare the "Current state" excerpts below
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `957206b`, 2026-06-20

> **PLANNED-AT SHA NOTE (read before the drift check).** The task that
> generated this plan stated "working tree clean at commit `9b169c0`" and asked
> to stamp `9b169c0`. That is **inaccurate for the TS-side evidence**: the live
> `HEAD` is `957206b` ("feat(forum): organizer admin — read, post-as-organizer,
> moderate [#37]"), exactly **one commit ahead** of `9b169c0`. Verified facts:
> - `sources/access.move` is **byte-identical** at `9b169c0` and `957206b`
>   (`git diff 9b169c0..957206b -- sources/access.move` is empty). The core Move
>   finding holds at both SHAs.
> - `web/lib/seal.ts` did **not** contain `approveOrganizer` at `9b169c0`; it and
>   `web/lib/forum.ts`'s organizer path were introduced in `957206b`.
> Because the executor's clean working tree will match `957206b` (the real
> `HEAD`), this plan is stamped at `957206b` so its drift check passes against
> live code. If your `HEAD` is neither `957206b` nor a clean descendant of it,
> STOP and report.

## Why this matters

`sources/access.move` exposes two Seal decryption policies — `seal_approve_ticket`
(any ticket holder for the event) and `seal_approve_organizer` (the event's
`OrganizerCap` holder) — but **both gate on the same identity namespace**: the
bare event-id bytes as a prefix of the Seal id. Because the namespaces are
identical, every Seal id that satisfies the organizer policy *also* satisfies the
ticket policy. So anyone holding a ticket for the event — including someone who
claimed a **free ($0) ticket** — can decrypt anything encrypted under the
organizer policy.

Today this leaks nothing: the only organizer-policy ciphertext is shared **forum
messages**, which are intentionally readable by both tickets and the organizer
(`web/lib/forum.ts:39-40`). But the `access.move` module doc advertises
`seal_approve_organizer` for the **"attendee/KYC list"** (`sources/access.move:8-13`),
inviting an organizer to encrypt attendee PII that any ticket holder could then
read. This plan domain-separates the organizer identity namespace (a
1-byte tag prefixed before the event id) so the ticket policy's event-id prefix
check can never match an organizer-only identity, and updates the doc to state
the two policies are **not** interchangeable. It is a latent-bug / defense-in-depth
fix that must land **before** any organizer-only PII feature is built on this
policy.

## Current state

Files involved and their roles:

- `sources/access.move` — the four Seal `seal_approve_*` policies. **This is the
  bug site.** Identical at `9b169c0` and `957206b`.
- `web/lib/seal.ts` — TS helpers: `sealEncrypt` (builds the Seal id), the
  `approve*` PTB builders that the Seal key servers dry-run. The organizer
  ciphertext id is built here.
- `web/lib/forum.ts` — the **only** consumer of the organizer policy today:
  encrypts forum bodies (`encryptForumMessage`) and decrypts with either the
  ticket or organizer credential.
- `tests/hostit_ticket_tests.move` — the Move test suite that already exercises
  `access::check_prefix`; the new negative test goes here.
- `web/lib/config.ts` — single source of truth for package ids/targets. Relevant
  here only because deploying the Move change is a **package upgrade** (see
  "Out of scope" + "STOP conditions").

### The bug (identical namespace) — `sources/access.move:34-44`

```move
entry fun seal_approve_ticket(id: vector<u8>, ticket: &Ticket, event: &Event) {
    let eid = object::id(event);
    assert!(ticket::event_id(ticket) == eid, E_NO_ACCESS);
    assert!(is_prefix(&object::id_to_bytes(&eid), &id), E_NO_ACCESS);
}

entry fun seal_approve_organizer(id: vector<u8>, cap: &OrganizerCap, event: &Event) {
    event::assert_organizer(cap, event);
    let eid = object::id(event);
    assert!(is_prefix(&object::id_to_bytes(&eid), &id), E_NO_ACCESS);   // <-- SAME namespace as ticket
}
```

Both call `is_prefix(&object::id_to_bytes(&eid), &id)`. Any `id` accepted by
`seal_approve_organizer` is therefore also accepted by `seal_approve_ticket`.

The error constant and prefix helper (same file):

```move
// sources/access.move:20
const E_NO_ACCESS: u64 = 1;

// sources/access.move:22-32
/// True iff `prefix` is a prefix of `id`.
fun is_prefix(prefix: &vector<u8>, id: &vector<u8>): bool { ... }

// sources/access.move:52-53  (test-only escape hatch already present)
#[test_only]
public fun check_prefix(prefix: vector<u8>, id: vector<u8>): bool { is_prefix(&prefix, &id) }
```

Module doc to update — `sources/access.move:1-13`:

```move
/// - `seal_approve_ticket`   → ticket-holder-gated content (event forum, gated
///   info): caller owns a Ticket for the event, id namespaced to the event.
/// - `seal_approve_organizer`→ organizer-gated data (attendee/KYC list): caller
///   holds the event's OrganizerCap.
```

### TS side — `web/lib/seal.ts`

The Seal id is `policy-object-id (or addr) bytes ‖ random nonce` (`seal.ts:25-29`):

```ts
// web/lib/seal.ts:26-29
export function makeSealId(policyObjectIdOrAddr: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(5));
  return toHex(new Uint8Array([...fromHex(policyObjectIdOrAddr), ...nonce]));
}
```

`sealEncrypt` takes a `policyObjectIdOrAddr` and uses `makeSealId` (`seal.ts:31-45`).

The organizer approve builder, and its **inaccurate** header comment that this
plan corrects — `web/lib/seal.ts:82-90`:

```ts
/** Organizer-gated decrypt: caller holds the event's OrganizerCap. Same original
 *  `access` module as the ticket policy (exists at PACKAGE_ID). The ciphertext is
 *  the SAME as the ticket path — both check `is_prefix(event_id, id)`. */
export function approveOrganizer(tx: Transaction, id: string, capId: string, eventId: string) {
  tx.moveCall({
    target: `${PACKAGE_ID}::access::seal_approve_organizer`,
    arguments: [tx.pure.vector("u8", Array.from(fromHex(id))), tx.object(capId), tx.object(eventId)],
  });
}
```

The ticket approve builder for contrast — `web/lib/seal.ts:68-73`:

```ts
export function approveTicket(tx: Transaction, id: string, ticketId: string, eventId: string) {
  tx.moveCall({
    target: `${PACKAGE_ID}::access::seal_approve_ticket`,
    arguments: [tx.pure.vector("u8", Array.from(fromHex(id))), tx.object(ticketId), tx.object(eventId)],
  });
}
```

### The only organizer-policy consumer today — `web/lib/forum.ts`

Forum content is **intentionally shared** between tickets and organizers
(`forum.ts:39-43`):

```ts
/** The credential a caller decrypts/posts with: a Ticket for the event, or the
 *  event's OrganizerCap. Both satisfy the Seal policy on the same ciphertext. */
export type ForumCredential =
  | { kind: "ticket"; ticketId: string }
  | { kind: "organizer"; capId: string };
```

Forum messages are encrypted under the **bare eventId** (`forum.ts:46-58`):

```ts
export async function encryptForumMessage(suiClient, eventId, body): Promise<string> {
  const { id, ciphertext } = await sealEncrypt(
    suiClient,
    eventId,                                  // <-- bare event id = ticket/shared namespace
    new TextEncoder().encode(JSON.stringify(body)),
  );
  ...
}
```

Decrypt picks the builder by credential kind (`forum.ts:138-142`):

```ts
const pt = await sealDecrypt(suiClient, sessionKey, ct, (tx) =>
  cred.kind === "ticket"
    ? approveTicket(tx, env.id, cred.ticketId, eventId)
    : approveOrganizer(tx, env.id, cred.capId, eventId),
);
```

**Why forum must KEEP working after this change**: forum bodies are encrypted
under the *bare event id* (ticket/shared namespace) and are decrypted by BOTH
ticket holders (`approveTicket`) and organizers (`approveOrganizer`). The
organizer therefore decrypts *shared* (event-id-namespaced) ciphertext, NOT
organizer-only ciphertext. So `seal_approve_organizer` must continue to accept
the **bare event-id** namespace (for shared forum reads) **in addition to** the
new organizer-only namespace. If you make `seal_approve_organizer` accept ONLY
the new namespace, organizer forum reads break. Implement it as **accept either**.

### Other Seal encrypt sites (NOT organizer policy — do not touch)

- `web/lib/drafts.ts:159` — `sealEncrypt(client, addr, ...)` → **self** policy
  (`approveSelf`), namespaced to the caller address. Unaffected.
- `web/components/screens/SettingsScreen.tsx:154` — `sealEncrypt(suiClient, addr, ...)`
  → **self** policy. Unaffected.
- No screen encrypts PII/KYC under the organizer policy today (verified by
  `grep -rn "sealEncrypt|encryptForumMessage"` over `web/`). This is why the bug
  is latent.

### Conventions to honor

- **Move**: edition `2024.beta`; error constants are `E_FOO: u64` (e.g.
  `E_NO_ACCESS: u64 = 1`). Run Move commands from the repo **root**. Negative
  tests use `#[test, expected_failure(abort_code = hostit_ticket::<module>::E_FOO)]`
  — see `tests/hostit_ticket_tests.move:455` (`set_price_wrong_cap_fails`) and the
  pure-helper test at `tests/hostit_ticket_tests.move:1337-1343`
  (`access_prefix_works`). Model the new negative test on these.
- **TS**: package manager is **bun only** (never npm/pnpm), run from `web/`. The
  primary gate is `bunx tsc --noEmit`. Vitest tests live under
  `web/lib/__tests__/`.
- **Permissionless model**: do NOT add any issuer/buyer role gate. This change is
  purely a Seal namespace separation; it does not introduce roles.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Move build (repo root) | `sui move build` | ends `BUILDING hostit_ticket`, no error |
| Move tests, filtered | `sui move test access` | runs `access_*` tests, `0 failure(s)` |
| Move tests, full | `sui move test` | all tests pass, `0 failure(s)` |
| TS typecheck (in `web/`) | `bunx tsc --noEmit` | exit 0, no output |
| TS lint (in `web/`) | `bun run lint` | exit 0 |
| TS unit tests (in `web/`) | `bun run test` | all pass |
| Drift check | see top of file | empty diff |

Run `sui move *` from `/Users/dadadave/Dev/HostIT/sui-ticket`. Run `bun*`/`bunx`
from `/Users/dadadave/Dev/HostIT/sui-ticket/web`. Because agent shells reset cwd
between calls, use a compound command that sets the directory inline, e.g.
`(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move build)`.

> **Do NOT run `bun run build`** (production build) — it corrupts `.next/` if a
> dev server is running. Verify the frontend with `bunx tsc --noEmit` only.

## Scope

**In scope** (the only files you may modify):
- `sources/access.move` — add the organizer domain-separation tag + update doc.
- `web/lib/seal.ts` — build the organizer Seal id with the matching tag; fix the
  `approveOrganizer` header comment.
- `web/lib/forum.ts` — only if Step 3 shows the organizer/forum encrypt path must
  change to stay consistent (see Step 3 — likely **no change**, because forum uses
  the shared event-id namespace which both policies still accept).
- `tests/hostit_ticket_tests.move` — add the negative + positive Move tests.
- `plans/README.md` — status row (create-or-skip per executor instructions).

**Out of scope** (do NOT touch, even though they look related):
- **Deploying / upgrading the package.** Rolling `PACKAGE_ID` / `PACKAGE_ID_LATEST`
  in `web/lib/config.ts`, editing `Move.toml` `published-at`, and running
  `sui client upgrade` are **gated, explicit-authorization-required** operations
  (CLAUDE.md: "On-chain upgrades require explicit, per-deploy user authorization").
  This is a **fresh v1 publish** (`web/lib/config.ts:6-10`: `PACKAGE_ID ==
  PACKAGE_ID_LATEST`, no upgrades yet), so this change would be the FIRST upgrade.
  **You do NOT deploy.** You land the source + tests; deployment is a separate,
  human-authorized step. See "Maintenance notes" and "STOP conditions".
- `web/lib/config.ts` — no edit. The Seal target string
  (`${PACKAGE_ID}::access::seal_approve_organizer`) is unchanged by this plan;
  only the *id bytes* passed to it change. The `PACKAGE_ID` roll happens at deploy
  time (out of scope).
- `web/lib/moveErrors.ts` — no edit. This plan reuses the existing `E_NO_ACCESS`
  abort and adds **no new error code**, so there is nothing to map. (Note:
  `access::E_NO_ACCESS` is not currently mapped in `moveErrors.ts` — the file only
  maps the `forum` module at `web/lib/moveErrors.ts:54`. Adding an `access`
  mapping is an explicitly deferred, optional follow-up — see Maintenance notes —
  not part of this plan.)
- `web/lib/drafts.ts`, `web/components/screens/SettingsScreen.tsx` — use the
  **self** policy, unaffected.

## Git workflow

- Branch: `advisor/007-seal-organizer-namespace` (create from `main`/current HEAD).
- Commit per logical unit; conventional-commit style — match the repo. Examples
  from `git log`: `feat(forum): organizer admin — read, post-as-organizer, moderate [#37]`,
  `fix(web): enumerate all Discover events via cursor, not just newest 50 [#32]`.
  Suggested messages here:
  - `fix(access): domain-separate organizer Seal identity from ticket namespace`
  - `test(access): assert ticket namespace cannot satisfy organizer-only id`
- Do **NOT** push or open a PR (repo flow is issue → branch → PR, and `gh` may
  hang). Leave the branch local for review.

## Steps

Implement the Move change and its tests first (the contract is the source of
truth), then mirror the namespace on the TS side, then verify everything.

### Step 1: Add a domain-separation tag to the organizer policy in `sources/access.move`

Introduce a 1-byte organizer domain tag and make `seal_approve_organizer` accept
**either** the tagged organizer namespace **or** the bare event-id namespace
(the latter keeps shared forum reads working — see "Why forum must KEEP working"
above). Leave `seal_approve_ticket` unchanged so it accepts ONLY the bare event-id
namespace and therefore can never match a tagged organizer-only id.

1. Add a tag constant near `E_NO_ACCESS` (top of module body, after line 20):

   ```move
   /// Domain-separation tag prefixed before the event-id bytes to form the
   /// ORGANIZER-ONLY Seal identity namespace. A ticket holder's policy
   /// (`seal_approve_ticket`) checks `is_prefix(event_id, id)` and can never
   /// match an id that begins with this tag, so organizer-only ciphertext is
   /// NOT decryptable by ticket holders. MUST match `ORG_NS_TAG` in
   /// web/lib/seal.ts.
   const ORG_NS_TAG: vector<u8> = b"hostit-org:";
   ```

   (Any fixed, non-empty byte string works as long as TS uses the identical bytes.
   `b"hostit-org:"` is self-documenting. Whatever you choose, the TS constant in
   Step 3 MUST be byte-identical.)

2. Add a helper that builds the tagged organizer namespace prefix from the event
   id, and rewrite `seal_approve_organizer` to accept tagged-OR-bare:

   ```move
   /// The organizer-only identity prefix: ORG_NS_TAG ‖ event_id bytes.
   fun organizer_ns(eid: &ID): vector<u8> {
       let mut ns = ORG_NS_TAG;
       ns.append(object::id_to_bytes(eid));
       ns
   }

   entry fun seal_approve_organizer(id: vector<u8>, cap: &OrganizerCap, event: &Event) {
       event::assert_organizer(cap, event);
       let eid = object::id(event);
       // Accept the organizer-only namespace (tag ‖ event_id) OR the bare
       // event-id namespace (shared forum content the organizer also reads).
       let ok = is_prefix(&organizer_ns(&eid), &id)
           || is_prefix(&object::id_to_bytes(&eid), &id);
       assert!(ok, E_NO_ACCESS);
   }
   ```

   - `ID` is already in scope via `use ... event::{... Event, OrganizerCap}` and
     `object::id(event)` returns `ID` (mirrors existing usage at lines 35 & 42).
     `object::id_to_bytes(&ID)` is already used in this file.
   - `vector::append` is available in edition 2024.beta as the method
     `ns.append(...)` (the codebase uses `.append(...)` on vectors in
     `tests/hostit_ticket_tests.move:1029-1031`).
   - **Do NOT change `seal_approve_ticket` or `seal_approve_self`.**

**Verify**: `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move build)` →
ends with `BUILDING hostit_ticket` and **no** `error[` lines.

### Step 2: Update the `access.move` module doc + add Move tests

1. **Doc** — replace the two policy bullet lines (`sources/access.move:8-13`) so
   they state the namespaces are NOT interchangeable. Target wording:

   ```move
   /// - `seal_approve_ticket`   → ticket-holder-gated / SHARED content (event
   ///   forum, gated info): caller owns a Ticket for the event; id namespaced to
   ///   the BARE event id. Any ticket holder (incl. a free-ticket claimer) passes.
   /// - `seal_approve_organizer`→ organizer-gated data (attendee/KYC list): caller
   ///   holds the event's OrganizerCap. ORGANIZER-ONLY ciphertext is namespaced
   ///   `ORG_NS_TAG ‖ event_id` so `seal_approve_ticket` can NOT decrypt it. (This
   ///   policy ALSO accepts the bare event-id namespace so the organizer can read
   ///   shared forum content.) The two policies are NOT interchangeable for
   ///   organizer-only data.
   ```

2. **Tests** — add to `tests/hostit_ticket_tests.move`. The suite already
   `use hostit_ticket::access;` (line 16) and has `access_prefix_works` at
   line 1337. Add **next to it** two pure tests that exercise the namespace logic
   via the existing `check_prefix` escape hatch (no on-chain Seal dry-run needed):

   ```move
   // The tagged organizer namespace must NOT be a prefix-match for the bare
   // event-id namespace the ticket policy checks — i.e. a ticket holder cannot
   // satisfy an organizer-only identity. (Domain separation, plan 007.)
   #[test]
   fun organizer_ns_not_ticket_decryptable() {
       let eid = object::id_from_address(@0x0a);
       let eid_bytes = object::id_to_bytes(&eid);

       // Build an organizer-only id: ORG_NS_TAG ‖ event_id ‖ nonce.
       let mut org_id = b"hostit-org:";        // MUST equal ORG_NS_TAG in access.move
       org_id.append(eid_bytes);
       org_id.append(b"\x01\x02\x03\x04\x05"); // 5-byte nonce, like makeSealId

       // The TICKET policy checks is_prefix(event_id, id). It must FAIL on the
       // organizer-only id (event_id is not a prefix of "hostit-org:"||...).
       assert!(!access::check_prefix(eid_bytes, org_id), 0);

       // Sanity: the SHARED (bare event-id) id the ticket policy *does* accept.
       let mut shared_id = eid_bytes;
       shared_id.append(b"\x01\x02\x03\x04\x05");
       assert!(access::check_prefix(eid_bytes, shared_id), 1);
   }

   // The organizer-only id IS accepted under the organizer namespace prefix
   // (tag ‖ event_id), confirming organizers can still decrypt their own data.
   #[test]
   fun organizer_ns_matches_organizer_prefix() {
       let eid = object::id_from_address(@0x0a);
       let mut org_ns = b"hostit-org:";
       org_ns.append(object::id_to_bytes(&eid));

       let mut org_id = org_ns;                 // tag ‖ event_id
       org_id.append(b"\x01\x02\x03\x04\x05");  // ‖ nonce
       assert!(access::check_prefix(org_ns, org_id), 0);
   }
   ```

   - These reuse `access::check_prefix` (the `#[test_only] public fun` at
     `sources/access.move:52-53`) — the same primitive `access_prefix_works`
     already tests. They do not need an `Event`/`OrganizerCap`, keeping them as
     fast unit tests. A full on-chain `seal_approve_organizer` dry-run test is an
     **optional** stretch (see Maintenance notes) and is NOT required here.
   - `eid_bytes` is consumed by `append`/passed by value; if the compiler
     complains about a moved value, rebuild it (`let eid_bytes2 = object::id_to_bytes(&eid);`)
     rather than borrowing — `check_prefix` takes `vector<u8>` by value.

**Verify**: `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move test access)` →
output lists `access_prefix_works`, `organizer_ns_not_ticket_decryptable`,
`organizer_ns_matches_organizer_prefix` (and any other `access`-name-matching
tests) and ends `Test result: OK. Total tests: <n>; passed: <n>; failed: 0`.

Then full suite: `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move test)` →
`0 failure(s)`.

### Step 3: Mirror the namespace on the TS side in `web/lib/seal.ts`

The Move policy now distinguishes organizer-only ids by the `ORG_NS_TAG` prefix.
The TS code that *encrypts organizer-only data* must build its Seal id with the
identical tag. **Important**: today the only organizer-policy ciphertext is shared
forum content encrypted under the **bare event id** (`forum.ts:51-55`), which the
updated `seal_approve_organizer` still accepts — so **forum keeps working with no
change to `forum.ts`'s encrypt call**. This step adds the *building block* for
future organizer-only encryption and fixes the misleading comment; it does NOT
re-namespace forum messages (doing so would make them undecryptable by ticket
holders, breaking the shared forum).

1. Add the tag constant + an organizer-id builder to `web/lib/seal.ts`, near
   `makeSealId` (after line 29):

   ```ts
   /** Domain-separation tag for ORGANIZER-ONLY Seal identities. MUST equal
    *  `ORG_NS_TAG` in sources/access.move so the on-chain policy matches. A Seal
    *  id built with this tag satisfies `seal_approve_organizer` but NOT
    *  `seal_approve_ticket` (whose check is `is_prefix(event_id, id)`), so a
    *  ticket holder cannot decrypt organizer-only ciphertext. */
   export const ORG_NS_TAG = new TextEncoder().encode("hostit-org:"); // == b"hostit-org:" in access.move

   /** Seal identity for ORGANIZER-ONLY data: ORG_NS_TAG ‖ event-id bytes ‖ nonce.
    *  Use this (not the bare event id) whenever you encrypt data that ONLY the
    *  organizer may read (e.g. an attendee/KYC list). Shared content readable by
    *  ticket holders must keep using the bare event id (see makeSealId). */
   export function makeOrganizerSealId(eventId: string): string {
     const nonce = crypto.getRandomValues(new Uint8Array(5));
     return toHex(new Uint8Array([...ORG_NS_TAG, ...fromHex(eventId), ...nonce]));
   }
   ```

   - `toHex`, `fromHex` are already imported (`seal.ts:9`).
   - The byte string passed to `TextEncoder().encode(...)` MUST exactly equal the
     bytes of `ORG_NS_TAG` in `access.move` (UTF-8 of `hostit-org:`).

2. Fix the now-incorrect `approveOrganizer` header comment (`seal.ts:82-84`) to
   describe the real (post-change) behavior:

   ```ts
   /** Organizer-gated decrypt: caller holds the event's OrganizerCap. Lives in the
    *  `access` module at PACKAGE_ID. `seal_approve_organizer` accepts the
    *  organizer-only namespace (ORG_NS_TAG ‖ event_id; see makeOrganizerSealId)
    *  AND the bare event-id namespace (shared forum content). It is NOT
    *  interchangeable with the ticket policy for organizer-only ids: a tagged
    *  organizer id does NOT satisfy seal_approve_ticket. */
   ```

   Leave the `approveOrganizer` function body unchanged — its target string and
   arguments are correct.

3. Do **NOT** change `encryptForumMessage` / the `forum.ts` encrypt or decrypt
   calls. Forum stays on the bare event-id (shared) namespace, which both policies
   still accept. (If you find a code path that encrypts attendee PII under the
   organizer policy using the bare event id — there is none today, verified by
   grep — that would be the one to switch to `makeOrganizerSealId`; if you see one,
   STOP and report rather than guessing.)

**Verify (typecheck)**: `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit)`
→ exit 0, no output.

### Step 4: Lint + TS unit tests

`makeOrganizerSealId` is currently unreferenced by app code (it is a building
block for future organizer-only encryption). That is fine because it is
**exported** (eslint's no-unused-vars does not flag exports). Confirm lint and the
existing vitest suite still pass.

**Verify (lint)**: `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint)`
→ exit 0.

**Verify (tests)**: `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test)`
→ all pass (no regressions). No new TS test is required by this plan (the security
invariant is proven by the Move tests in Step 2); a TS test is an optional
follow-up (see Maintenance notes). If you add one, model it on
`web/lib/__tests__/predict.test.ts` (pure, chain-free assertions) and assert that
`makeOrganizerSealId(eventId)` returns a hex string whose decoded bytes START with
the UTF-8 of `hostit-org:` and that `makeSealId(eventId)` does NOT.

### Step 5: Confirm the bug-fix invariant by inspection

Re-read `seal_approve_ticket` and `seal_approve_organizer` in `sources/access.move`
and confirm:
- `seal_approve_ticket` still checks ONLY `is_prefix(event_id, id)` (unchanged).
- `seal_approve_organizer` accepts tagged-OR-bare.
- The Move test `organizer_ns_not_ticket_decryptable` passed in Step 2.

**Verify**: `grep -n "ORG_NS_TAG\|organizer_ns\|is_prefix" /Users/dadadave/Dev/HostIT/sui-ticket/sources/access.move`
→ shows the new `ORG_NS_TAG` constant, the `organizer_ns` helper, the tagged-OR-bare
check inside `seal_approve_organizer`, and the unchanged `is_prefix` call inside
`seal_approve_ticket`.

## Test plan

- **New Move tests** in `tests/hostit_ticket_tests.move` (next to
  `access_prefix_works`, modeled on it):
  - `organizer_ns_not_ticket_decryptable` — **the regression test for this bug**:
    an organizer-only id (`ORG_NS_TAG ‖ event_id ‖ nonce`) is NOT a prefix-match
    for the bare event-id namespace the ticket policy enforces; the shared
    (bare event-id) id still is.
  - `organizer_ns_matches_organizer_prefix` — happy path: the organizer-only id is
    accepted under its own (`ORG_NS_TAG ‖ event_id`) prefix.
- **Structural pattern**: `tests/hostit_ticket_tests.move:1337-1343`
  (`access_prefix_works`, uses `access::check_prefix`).
- **No new TS test required** (optional follow-up modeled on
  `web/lib/__tests__/predict.test.ts`).
- **Verification**:
  - `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move test)` → `0 failure(s)`,
    including the 2 new tests.
  - `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit)` → exit 0.
  - `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test)` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move build)` ends with `BUILDING hostit_ticket` and prints no `error[` line.
- [ ] `(cd /Users/dadadave/Dev/HostIT/sui-ticket && sui move test)` reports `failed: 0` and the run includes `organizer_ns_not_ticket_decryptable` and `organizer_ns_matches_organizer_prefix`.
- [ ] `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bunx tsc --noEmit)` exits 0 with no output.
- [ ] `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run lint)` exits 0.
- [ ] `(cd /Users/dadadave/Dev/HostIT/sui-ticket/web && bun run test)` exits 0; existing tests still pass.
- [ ] `grep -n "ORG_NS_TAG" /Users/dadadave/Dev/HostIT/sui-ticket/sources/access.move /Users/dadadave/Dev/HostIT/sui-ticket/web/lib/seal.ts` returns matches in BOTH files, and the tag byte string is identical in both (`hostit-org:`).
- [ ] `git -C /Users/dadadave/Dev/HostIT/sui-ticket status --porcelain` shows changes ONLY in: `sources/access.move`, `web/lib/seal.ts`, `tests/hostit_ticket_tests.move`, `plans/README.md` (and `web/lib/forum.ts` only if Step 3.3 forced it — it should not have). No other files modified. In particular, `web/lib/config.ts` and `Move.toml` are UNCHANGED.
- [ ] `plans/README.md` status row for plan 007 updated to DONE (or created with just this row).

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check at the top is non-empty, OR `sources/access.move:34-44` does not
  match the "Current state" excerpt (the codebase drifted since this plan was
  written).
- Your `HEAD` is not `957206b` and not a clean descendant of it (see the
  PLANNED-AT SHA NOTE) — the TS excerpts may not match your tree.
- `sui move build` or `sui move test` fails twice after a reasonable fix attempt
  (e.g. a `vector::append` borrow/move error you cannot resolve by rebuilding the
  bytes).
- You find ANY code path that encrypts attendee PII / KYC under the organizer
  policy using the **bare event id** today (grep shows none) — switching it is a
  behavior change that needs human review.
- The fix appears to require editing `web/lib/config.ts`, `Move.toml`,
  `web/lib/moveErrors.ts`, or running `sui client upgrade` / `sui client publish`.
  **Package upgrades and config/version rolls are explicitly out of scope and
  require per-deploy human authorization** — do NOT perform them. Land the source
  + tests on the branch and report that deployment is pending.
- Changing `seal_approve_organizer` to accept tagged-OR-bare turns out to break a
  forum test or the forum decrypt flow (it should not, since forum uses the bare
  event id) — stop and report rather than re-namespacing forum content.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **DEPLOYMENT IS REQUIRED FOR THE FIX TO TAKE EFFECT, AND IS GATED.** The Seal
  key servers dry-run the **on-chain** `seal_approve_organizer`. Until the package
  is upgraded and `web/lib/config.ts`'s `PACKAGE_ID`/`PACKAGE_ID_LATEST` (and the
  `SEAL_POLICY_PACKAGE_ID = PACKAGE_ID` derived constant) roll to the new version,
  the live policy is the OLD one and any newly tagged organizer ciphertext would be
  **undecryptable** (no live policy accepts the tag yet). Therefore: (a) merge this
  source+tests change, (b) get explicit per-deploy authorization and run the FIRST
  package upgrade (`sui client upgrade`; set `Move.toml`/`Published.toml`
  `published-at` to current latest, keep `[addresses] hostit_ticket` at the
  original id — see CLAUDE.md "Deploys are package upgrades"), (c) roll
  `PACKAGE_ID_LATEST` in `config.ts`, then re-`tsc`, (d) ONLY THEN start encrypting
  organizer-only data via `makeOrganizerSealId`. Do not ship an organizer-only PII
  feature before (b)-(c) land.
- A reviewer should scrutinize: that `seal_approve_ticket` is **unchanged**; that
  `seal_approve_organizer` accepts BOTH namespaces (so forum still works); that the
  `ORG_NS_TAG` bytes are byte-identical in `access.move` and `seal.ts`; and that
  the regression test actually asserts the *negative* (ticket policy rejects the
  tagged id).
- **Deferred follow-ups (not in this plan):**
  - Optional: add an on-chain `seal_approve_organizer` dry-run negative test using
    a real `Event` + `OrganizerCap` + a wrong-namespace `id` (asserting
    `E_NO_ACCESS`), beyond the pure `check_prefix` tests here.
  - Optional: map `access::E_NO_ACCESS` in `web/lib/moveErrors.ts` (currently only
    the `forum` module is mapped at line 54) so a denied decrypt surfaces a human
    message via `humanizeError`.
  - When a real organizer-only PII feature is built, switch its encrypt call to
    `makeOrganizerSealId(eventId)` and add a forum-vs-organizer end-to-end decrypt
    test proving a free-ticket holder cannot read it.
