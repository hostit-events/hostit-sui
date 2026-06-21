# Plan 010: Decide and implement the per-day check-in unit (per-ticket vs per-attendee)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. (If `plans/README.md` does not exist, do NOT create it;
> just report completion.)
>
> **This is a DECISION plan.** Step 1 is a hard STOP: a human maintainer must
> choose the intended check-in unit (PER-TICKET or PER-ATTENDEE) before any
> code changes. Do NOT pick one yourself. The two paths produce different code
> and a different test, so guessing wrong wastes the whole effort.
>
> **Drift check (run first)**:
> `git diff --stat 957206b..HEAD -- sources/event.move sources/checkin.move tests/hostit_ticket_tests.move web/lib/moveErrors.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20

> NOTE ON PLANNED-AT SHA: this plan was generated against the live working tree
> at `git rev-parse HEAD` = `957206bead12a13678d1675829b3abf341666d21`
> (short `957206b`), tree clean, date 2026-06-20. The task brief that requested
> this plan named a different SHA (`9b169c0` / `9cddf8b`); that SHA does not
> match this checkout. The "Current state" excerpts below were copied from the
> live files at `957206b`. If your `HEAD` differs, run the drift check above.

## Why this matters

A single wallet that legitimately holds several tickets — the common "I bought
4 tickets for my friends and we arrive together" case — can today check in only
**one** ticket per day; every further check-in by that wallet on the same day
aborts with `E_ALREADY_CHECKED_IN_DAY`. The once-per-day dedup is keyed on the
**wallet** (`ctx.sender()`), not on the **ticket**, so the per-day attendance
record also counts wallets, not tickets. This is purely a check-in / attendance
limitation: an access review for this codebase confirmed it does **not** corrupt
anything downstream — prediction markets settle on `event::minted()` (sales
count, untouched by check-in), and POAPs gate on `ticket::is_checked_in` (a
per-ticket flag, also untouched). The fix is to decide the intended unit and
either re-key to per-ticket or document per-wallet as a deliberate constraint.

## Current state

The facts the executor needs, inlined.

### Files in play

- `sources/event.move` — owns the `Event` object, the `DayKey` dedup type, the
  `day_attendees`/`attendees` tables, `record_checkin` (the dedup writer), and
  the `is_checked_in_for_day` reader. This is where the dedup unit is decided.
- `sources/checkin.move` — `check_in` (voucher-gated) and `self_check_in`
  (fallback) both funnel into `record_and_mark`, which computes `who =
  ctx.sender()` and calls `event::record_checkin(event, day, who)`.
- `tests/hostit_ticket_tests.move` — the Move contract test suite; one test
  (`self_checkin_twice_same_day_fails`) currently *encodes the buggy behavior as
  intended*, and several reader assertions use `is_checked_in_for_day(.., addr)`.
- `web/lib/moveErrors.ts` — maps Move abort codes to human strings;
  `event` code 13 is already mapped (see below). No code change required here for
  most paths, but the wording is relevant under PER-TICKET.

### The dedup writer — `sources/event.move:382-390`

```move
/// Records a check-in for `who` on `day`; aborts if already checked in that day.
public(package) fun record_checkin(event: &mut Event, day: u64, who: address) {
    let k = DayKey { day, attendee: who };
    assert!(!table::contains(&event.day_attendees, k), E_ALREADY_CHECKED_IN_DAY);
    table::add(&mut event.day_attendees, k, true);
    if (!table::contains(&event.attendees, who)) {
        table::add(&mut event.attendees, who, true);
    }
}
```

The dedup key is `DayKey { day, attendee: who }` where `who` is the wallet
(see next excerpt). So the guard is **per wallet per day**, not per ticket.

### `who` is the transaction sender — `sources/checkin.move:101-115`

```move
fun record_and_mark(event: &mut Event, ticket: &mut Ticket, now: u64, ctx: &TxContext) {
    let day = (now - event::start_ms(event)) / event::day_ms();
    let who = ctx.sender();
    // Aborts if `who` already checked in on `day` (once-per-day, EVM parity).
    event::record_checkin(event, day, who);
    ticket::set_checked_in(ticket);
    sui_event::emit(CheckedIn {
        event_seq: event::event_seq(event),
        event_id: object::id(event),
        ticket_id: object::id(ticket),
        attendee: who,
        day,
        serial: ticket::serial(ticket),
    });
}
```

Both `check_in` (voucher path, `sources/checkin.move:55-78`) and `self_check_in`
(`sources/checkin.move:82-97`) call `record_and_mark`. There is exactly **one**
caller of `record_checkin` in the whole repo (verified by grep — see Done
criteria). `ticket::set_checked_in` is idempotent (`sources/ticket.move:95-98`).

### The `DayKey` type and the two tables — `sources/event.move:74-90`, `:208-209`, `:419-424`

```move
    /// `DayKey -> true`; enforces once-per-day check-in.
    day_attendees: Table<DayKey, bool>,
    /// `address -> true`; "ever checked in" for this event.
    attendees: Table<address, bool>,
```
```move
public struct DayKey has copy, drop, store {
    day: u64,
    attendee: address,
}
```
Initialized in `create_event` (`sources/event.move:208-209`):
```move
        day_attendees: table::new(ctx),
        attendees: table::new(ctx),
```
The day reader (`sources/event.move:419-424`):
```move
public fun is_checked_in(event: &Event, who: address): bool {
    table::contains(&event.attendees, who)
}
public fun is_checked_in_for_day(event: &Event, day: u64, who: address): bool {
    table::contains(&event.day_attendees, DayKey { day, attendee: who })
}
```

### The test that encodes the current behavior as intended — `tests/hostit_ticket_tests.move:927-960`

```move
#[test, expected_failure(abort_code = hostit_ticket::event::E_ALREADY_CHECKED_IN_DAY)]
fun self_checkin_twice_same_day_fails() {
    let (mut sc, mut clock) = begin();
    clock.set_for_testing(CREATE_NOW);
    let cap = create_event(&mut sc, &clock, 100, 5, true, false);
    sc.next_tx(ORG);
    let mut ev = sc.take_shared<Event>();
    event::set_allow_self_checkin(&cap, &mut ev, true);
    ts::return_shared(ev);

    clock.set_for_testing(BUY_NOW);
    sc.next_tx(BUYER);
    let mut ev = sc.take_shared<Event>();
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
    ts::return_shared(ev);

    // BUYER holds two issued tickets for the same day. Check in #0 (records the
    // day), then #1 (same day, same attendee) must hit the once-per-day guard.
    clock.set_for_testing(USE_NOW);
    sc.next_tx(BUYER);
    let ids = ts::ids_for_sender<Ticket>(&sc);
    let mut ev = sc.take_shared<Event>();
    let mut t1 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(0));
    checkin::self_check_in(&mut ev, &mut t1, &clock, sc.ctx());
    sc.return_to_sender(t1);
    let mut t2 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(1));
    checkin::self_check_in(&mut ev, &mut t2, &clock, sc.ctx()); // abort
    sc.return_to_sender(t2);
    ts::return_shared(ev);
    destroy(cap);
    clock.destroy_for_testing();
    sc.end();
}
```

This is the test that must change under PER-TICKET (it currently asserts the
two-tickets-one-wallet check-in **fails**; under per-ticket the second check-in
**succeeds** because it is a different ticket).

### Reader assertions that depend on the `(day, address)` key shape

Five existing tests call `is_checked_in_for_day(&ev, day, BUYER)` — i.e. they
read the day record **by address**:

- `tests/hostit_ticket_tests.move:867` (`self_checkin_ok`)
- `tests/hostit_ticket_tests.move:1104` and `:1108` (`checkin_multiday_ok`)
- `tests/hostit_ticket_tests.move:1184` (`instant_free_claim_and_self_checkin_ok`)
- `tests/hostit_ticket_tests.move:1223` (`instant_paid_buy_and_self_checkin_ok`)

`checkin_multiday_ok` (`tests/hostit_ticket_tests.move:1082-1116`) checks in **the
same ticket** on day 0 and again on day 1 (`now == END → day 1`). It passes under
**both** options and MUST keep passing — multi-day check-in of one ticket is the
intended behavior and is not what this plan touches.

### The error mapping — `web/lib/moveErrors.ts:33-48`

```ts
  event: {
    ...
    13: "Already checked in for this day.",
    14: "Invalid signer key — must be a 32-byte ed25519 public key.",
  },
```
`event` abort code 13 = `E_ALREADY_CHECKED_IN_DAY` (`sources/event.move:44`).
It is already mapped. Under PER-TICKET the code is still emitted (when the *same
ticket* is re-presented the same day), so the mapping stays; you may optionally
sharpen the wording (see Step 3, PER-TICKET path).

### Conventions to honor

- Move edition is `2024.beta`; error constants are named `E_FOO` (see
  `sources/event.move:32-45`). Keep that style if you add a constant.
- This project is **permissionless**: there is no issuer/buyer role split. Do
  NOT add any role gate, allowlist, or per-organizer toggle for this behavior.
  The decision is a single global semantic, not a per-event configurable.
- Run Move commands from the **repo root** (`Move.toml`, `sources/`, `tests/`).
- Frontend uses **bun only** (never npm/pnpm). Frontend changes here are at most
  one string edit in `web/lib/moveErrors.ts`.
- There is **no frontend code** that reads the day key — verified by grep
  (`is_checked_in_for_day` / `day_attendees` / `record_checkin` have zero hits
  under `web/`). So no `lib/ticketing.ts` or screen change is needed.

## Commands you will need

| Purpose                  | Command                                                  | Expected on success           |
|--------------------------|----------------------------------------------------------|-------------------------------|
| Build Move package       | `sui move build`                                         | exit 0, "BUILDING" then done  |
| Run the relevant tests   | `sui move test checkin`                                  | all matched tests pass        |
| Run the full Move suite  | `sui move test`                                          | all tests pass                |
| Frontend typecheck (gate)| `cd web && bunx tsc --noEmit`                            | exit 0, no errors             |
| Frontend lint            | `cd web && bun run lint`                                 | exit 0                        |
| Frontend unit tests      | `cd web && bun run test`                                 | all pass                      |

(Move commands run from repo root; frontend commands from `web/`. All verified
during recon against this repo. NEVER run `bun run build` while `bun run dev` is
running — it corrupts `.next/`.)

## Scope

**In scope** (the only files you may modify):
- `sources/event.move` — only under the PER-TICKET path (re-key + reader); under
  PER-ATTENDEE only a doc-comment edit.
- `sources/checkin.move` — only under the PER-TICKET path (what key value is
  passed into `record_checkin`); under PER-ATTENDEE only a doc-comment edit.
- `tests/hostit_ticket_tests.move` — update/replace `self_checkin_twice_same_day_fails`
  and (PER-TICKET only) any reader assertion whose signature changed.
- `web/lib/moveErrors.ts` — optional wording tweak under PER-TICKET only.
- `plans/README.md` — status row only, **and only if it already exists**.

**Out of scope** (do NOT touch, even though they look related):
- `sources/poap.move`, `sources/predict.move`, `sources/market.move` — the
  access review confirmed they do not depend on the dedup unit (POAP reads
  `ticket::is_checked_in`; predict reads `event::minted()`). Do not "also fix"
  them.
- `sources/ticket.move` — the `CHECKED_IN` flag is per-ticket and idempotent
  already; leave it.
- `web/lib/config.ts`, `SPONSORED_TARGETS`, any deploy/upgrade step — this plan
  changes Move logic but **does not deploy**. No `published-at` / `PACKAGE_ID`
  edits. (Deploying is a separate, explicitly-authorized step; see Maintenance.)
- Any new per-event toggle or role gate (violates the permissionless model).

## Git workflow

- Branch: `advisor/010-checkin-dedup-unit` (create from current `HEAD`).
- Conventional-commit messages. Examples from recent history style:
  - PER-TICKET: `fix(checkin): key once-per-day dedup on ticket id, not wallet`
  - PER-ATTENDEE: `docs(checkin): document per-wallet once-per-day check-in limit`
- Commit per logical unit (code change, then test change, can be one commit).
- Do **NOT** push or open a PR. Repo flow is issue → branch → PR done by a human;
  `gh` CLI may hang. Leave the branch local for review.

## Steps

### Step 1 — STOP: get the maintainer's decision on the check-in unit

Do **not** write any code yet. Present the maintainer with exactly this choice
and wait for an explicit answer ("PER-TICKET" or "PER-ATTENDEE"):

> The once-per-day check-in guard is currently keyed on the **wallet**
> (`ctx.sender()`), so a wallet holding N tickets can check in only one per day.
> Two options:
>
> - **PER-TICKET** (behavior change, larger): re-key the dedup on
>   `(ticket_id, day)`. A wallet can then check in each ticket it holds once per
>   day. Per-day attendance counts tickets. Requires changing `DayKey`,
>   `record_checkin`, `is_checked_in_for_day`, the caller in `checkin.move`, and
>   updating the test that currently asserts the second check-in fails.
> - **PER-ATTENDEE** (keep behavior, smaller): a wallet may check in once per
>   day regardless of how many tickets it holds. Document this as intended and
>   convert the existing "fails" test into a documented-behavior test.

**Verify**: You have a written decision recorded (in your report / commit body).
If no decision is given, STOP and report — do not proceed to Step 2.

Then proceed to **Step 2A (PER-TICKET)** or **Step 2B (PER-ATTENDEE)** —
do exactly one of them, plus the shared Step 4.

---

### Step 2A — (PER-TICKET) Re-key the dedup on `(ticket_id, day)`

Make the dedup key the ticket object id, not the wallet, while keeping the
"ever checked in" `attendees` table keyed on wallet (it feeds Seal/UI "did this
person attend" and is not part of the bug).

1. In `sources/event.move`, change the `DayKey` struct (currently
   `sources/event.move:87-90`) so its discriminant is the ticket id:
   ```move
   public struct DayKey has copy, drop, store {
       day: u64,
       ticket: ID,
   }
   ```
   (`ID` is already in scope via `sui::object` usage in this module; if the
   compiler complains it is unbound, add `use sui::object::{Self, ID};` — but
   first confirm: `object::id(...)` is already used elsewhere in the file, so
   `ID` should resolve.)

2. Change `record_checkin` (`sources/event.move:382-390`) to take the ticket id
   and the wallet separately. Target shape:
   ```move
   /// Records a check-in for `ticket_id` on `day`; aborts if that ticket already
   /// checked in that day. `who` is recorded as an ever-attendee of the event.
   public(package) fun record_checkin(event: &mut Event, day: u64, ticket_id: ID, who: address) {
       let k = DayKey { day, ticket: ticket_id };
       assert!(!table::contains(&event.day_attendees, k), E_ALREADY_CHECKED_IN_DAY);
       table::add(&mut event.day_attendees, k, true);
       if (!table::contains(&event.attendees, who)) {
           table::add(&mut event.attendees, who, true);
       }
   }
   ```

3. Change the reader `is_checked_in_for_day` (`sources/event.move:422-424`) to
   key on the ticket id:
   ```move
   public fun is_checked_in_for_day(event: &Event, day: u64, ticket_id: ID): bool {
       table::contains(&event.day_attendees, DayKey { day, ticket: ticket_id })
   }
   ```
   Leave `is_checked_in(event, who: address)` (`sources/event.move:419-421`)
   unchanged — it reads the per-wallet `attendees` table.

4. In `sources/checkin.move`, update `record_and_mark`
   (`sources/checkin.move:101-115`) to pass the ticket id:
   ```move
   let who = ctx.sender();
   let ticket_id = object::id(ticket);
   // Aborts if THIS TICKET already checked in on `day` (once-per-day-per-ticket).
   event::record_checkin(event, day, ticket_id, who);
   ```
   Also update the now-stale comment on `sources/checkin.move:104` (it says
   "once-per-day, EVM parity" about the wallet — make it per-ticket). Update the
   module-level doc on `sources/checkin.move:14-18` which currently says the gate
   is "per-(day, attendee)" — change "attendee" to "ticket".

5. Update the field doc on `sources/event.move:74` from
   `` /// `DayKey -> true`; enforces once-per-day check-in. `` to note it is
   now per-(day, ticket).

**Verify**: `sui move build` → exit 0 (compiles). Do not run tests yet; the
reader-signature change will break test call sites until Step 3A.

---

### Step 2B — (PER-ATTENDEE) Keep behavior, document it as intended

No logic change. Make the intent explicit so this is not re-flagged as a bug.

1. In `sources/event.move`, update the doc comment above `record_checkin`
   (`sources/event.move:382`) to state the unit explicitly, e.g.:
   ```move
   /// Records a check-in for wallet `who` on `day`; aborts if THIS WALLET already
   /// checked in that day. Intentionally per-wallet, not per-ticket: a wallet may
   /// check in once per day regardless of how many tickets it holds. (Per-ticket
   /// attendance was considered and rejected — see plans/010.)
   ```
2. In `sources/checkin.move`, update the module doc (`sources/checkin.move:14-18`)
   and the inline comment at `sources/checkin.move:104` to say "per-wallet,
   once per day" explicitly (today they say "per-(day, attendee)" / "EVM
   parity", which is ambiguous about wallet vs ticket).

**Verify**: `sui move build` → exit 0. `git diff --stat` shows only doc/comment
lines changed in `sources/`.

---

### Step 3A — (PER-TICKET) Update the asserting test and reader call sites

1. Replace `self_checkin_twice_same_day_fails`
   (`tests/hostit_ticket_tests.move:927-960`) — which currently expects the
   second wallet check-in to abort — with a **passing** test that two distinct
   tickets held by one wallet both check in on the same day, and that a *single
   ticket re-presented the same day still aborts*. Target shape (rename the fn,
   drop the `expected_failure` attribute on the happy part, and add a separate
   `expected_failure` test for the same-ticket-twice case):

   ```move
   #[test]
   fun two_tickets_one_wallet_same_day_ok() {
       let (mut sc, mut clock) = begin();
       clock.set_for_testing(CREATE_NOW);
       let cap = create_event(&mut sc, &clock, 100, 5, true, false);
       sc.next_tx(ORG);
       let mut ev = sc.take_shared<Event>();
       event::set_allow_self_checkin(&cap, &mut ev, true);
       ts::return_shared(ev);

       clock.set_for_testing(BUY_NOW);
       sc.next_tx(BUYER);
       let mut ev = sc.take_shared<Event>();
       market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
       market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
       ts::return_shared(ev);

       clock.set_for_testing(USE_NOW);
       sc.next_tx(BUYER);
       let ids = ts::ids_for_sender<Ticket>(&sc);
       let mut ev = sc.take_shared<Event>();
       let mut t1 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(0));
       checkin::self_check_in(&mut ev, &mut t1, &clock, sc.ctx());
       assert!(event::is_checked_in_for_day(&ev, 0, object::id(&t1)), 0);
       sc.return_to_sender(t1);
       let mut t2 = sc.take_from_sender_by_id<Ticket>(*ids.borrow(1));
       // Different ticket, same wallet, same day → now succeeds.
       checkin::self_check_in(&mut ev, &mut t2, &clock, sc.ctx());
       assert!(event::is_checked_in_for_day(&ev, 0, object::id(&t2)), 1);
       sc.return_to_sender(t2);
       ts::return_shared(ev);
       destroy(cap);
       clock.destroy_for_testing();
       sc.end();
   }

   #[test, expected_failure(abort_code = hostit_ticket::event::E_ALREADY_CHECKED_IN_DAY)]
   fun same_ticket_twice_same_day_fails() {
       let (mut sc, mut clock) = begin();
       clock.set_for_testing(CREATE_NOW);
       let cap = create_event(&mut sc, &clock, 100, 5, true, false);
       sc.next_tx(ORG);
       let mut ev = sc.take_shared<Event>();
       event::set_allow_self_checkin(&cap, &mut ev, true);
       ts::return_shared(ev);

       clock.set_for_testing(BUY_NOW);
       sc.next_tx(BUYER);
       let mut ev = sc.take_shared<Event>();
       market::claim_free(&mut ev, BUYER, &clock, sc.ctx());
       ts::return_shared(ev);

       clock.set_for_testing(USE_NOW);
       sc.next_tx(BUYER);
       let mut ev = sc.take_shared<Event>();
       let mut t = sc.take_from_sender<Ticket>();
       checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx());
       checkin::self_check_in(&mut ev, &mut t, &clock, sc.ctx()); // same ticket, same day → abort
       sc.return_to_sender(t);
       ts::return_shared(ev);
       destroy(cap);
       clock.destroy_for_testing();
       sc.end();
   }
   ```

2. Fix the four other reader call sites whose signature changed from
   `(.., day, BUYER)` to `(.., day, <ticket id>)`. In each, you already have the
   ticket object `t` in scope — pass `object::id(&t)`:
   - `tests/hostit_ticket_tests.move:867` in `self_checkin_ok` → `object::id(&t)`
   - `tests/hostit_ticket_tests.move:1104` and `:1108` in `checkin_multiday_ok`
     → `object::id(&t)` (same ticket across both days)
   - `tests/hostit_ticket_tests.move:1184` in `instant_free_claim_and_self_checkin_ok`
     → `object::id(&t)`
   - `tests/hostit_ticket_tests.move:1223` in `instant_paid_buy_and_self_checkin_ok`
     → `object::id(&t)`

   (Find them all — they should be the only remaining `is_checked_in_for_day`
   callers; the grep in Done criteria confirms none take a bare `BUYER` after
   this step.)

**Verify**: `sui move test checkin` → all matched tests pass (including the two
rewritten tests). Then `sui move test` → full suite passes.

---

### Step 3B — (PER-ATTENDEE) Convert the asserting test into a documented-behavior test

Keep the abort expectation but rename it and update its comment so it reads as a
*deliberate* constraint, not an incidental bug. Edit
`tests/hostit_ticket_tests.move:927-960`:

1. Rename `self_checkin_twice_same_day_fails` →
   `second_ticket_same_wallet_same_day_blocked_by_design` (keep the
   `#[test, expected_failure(abort_code = hostit_ticket::event::E_ALREADY_CHECKED_IN_DAY)]`
   attribute exactly as is).
2. Replace the inline comment block at `tests/hostit_ticket_tests.move:944-945`
   with one that states the intent, e.g.:
   ```move
   // PER-WALLET once-per-day (by design — see plans/010): a wallet checks in once
   // per day regardless of how many tickets it holds. The 2nd check-in by the
   // same wallet on the same day aborts even though it is a different ticket.
   ```

No reader call sites change under PER-ATTENDEE (the `is_checked_in_for_day(.., addr)`
signature is unchanged).

**Verify**: `sui move test checkin` → all matched tests pass. Then `sui move test`
→ full suite passes.

---

### Step 4 — (shared, PER-TICKET only) Optional error-wording sharpen + frontend gates

PER-ATTENDEE: skip the wording change (the existing string is already correct);
go straight to the frontend gates below.

PER-TICKET (optional, recommended): the abort now fires only when the **same
ticket** is re-presented the same day. The existing `web/lib/moveErrors.ts:46`
string `"Already checked in for this day."` is still accurate but you may
sharpen it to `"This ticket is already checked in for today."` Edit only that
one line; do not touch any other entry.

Then, regardless of path, run the frontend gates (the Move change does not touch
frontend logic, but confirm nothing regressed and any moveErrors edit typechecks):

**Verify**:
- `cd web && bunx tsc --noEmit` → exit 0
- `cd web && bun run lint` → exit 0
- `cd web && bun run test` → all pass

## Test plan

- **PER-TICKET**: in `tests/hostit_ticket_tests.move`, replace
  `self_checkin_twice_same_day_fails` with two tests —
  `two_tickets_one_wallet_same_day_ok` (happy path: the bug this plan fixes —
  two distinct tickets, one wallet, same day, both succeed) and
  `same_ticket_twice_same_day_fails` (regression guard: re-presenting the *same*
  ticket the same day still aborts `E_ALREADY_CHECKED_IN_DAY`). Update the four
  reader call sites (`:867, :1104, :1108, :1184, :1223`) to pass a ticket id.
  Model the new tests structurally after the existing `self_checkin_ok`
  (`tests/hostit_ticket_tests.move:844-874`) and the original
  `self_checkin_twice_same_day_fails`.
- **PER-ATTENDEE**: rename the existing test to
  `second_ticket_same_wallet_same_day_blocked_by_design` and restate its comment;
  no new tests, no reader changes.
- **Both**: `checkin_multiday_ok` (`tests/hostit_ticket_tests.move:1082-1116`)
  must still pass — it is the same-ticket-across-days case and is the guardrail
  that the fix did not break multi-day.
- Verification: `sui move test` → all tests pass (PER-TICKET adds one net test;
  PER-ATTENDEE keeps the count the same).

## Done criteria

Machine-checkable. ALL must hold.

Shared:
- [ ] A maintainer decision (PER-TICKET or PER-ATTENDEE) is recorded in the
      commit body / your report (Step 1).
- [ ] `sui move build` exits 0.
- [ ] `sui move test` exits 0; all tests pass.
- [ ] `cd web && bunx tsc --noEmit` exits 0.
- [ ] `cd web && bun run lint` exits 0.
- [ ] `cd web && bun run test` exits 0.
- [ ] `git status --porcelain` shows changes ONLY in files from the In-scope
      list (plus `plans/README.md` if it exists). No `sources/poap.move`,
      `sources/predict.move`, `sources/market.move`, `sources/ticket.move`,
      `web/lib/config.ts`, or `Move.toml` changes.
- [ ] `plans/README.md` status row updated **iff** that file exists (it does not
      exist at planning time — if still absent, this item is N/A).

PER-TICKET only:
- [ ] `grep -n "record_checkin" sources/` shows the writer takes a ticket id
      and the single caller (`sources/checkin.move`) passes `object::id(ticket)`.
- [ ] `grep -n "is_checked_in_for_day" tests/hostit_ticket_tests.move` shows
      **zero** call sites passing a bare address (`BUYER`/`BUYER2`); every call
      passes `object::id(&...)`.
- [ ] `grep -n "self_checkin_twice_same_day_fails" tests/` returns no matches
      (the old buggy-behavior test is gone), and both
      `two_tickets_one_wallet_same_day_ok` and `same_ticket_twice_same_day_fails`
      exist.

PER-ATTENDEE only:
- [ ] `grep -n "attendee: who\|DayKey { day, attendee" sources/event.move` still
      shows the wallet-keyed dedup (logic unchanged).
- [ ] The renamed test `second_ticket_same_wallet_same_day_blocked_by_design`
      exists with `expected_failure(abort_code = hostit_ticket::event::E_ALREADY_CHECKED_IN_DAY)`.

## STOP conditions

Stop and report back (do not improvise) if:

- **No decision is given in Step 1.** This plan cannot proceed without the
  PER-TICKET vs PER-ATTENDEE choice — do not pick one yourself.
- The drift check shows any in-scope file changed since `957206b`, or the code
  at the cited `file:line` locations does not match the "Current state"
  excerpts (the codebase drifted). In particular: `record_checkin` no longer
  keys on `DayKey { day, attendee: who }`, or `is_checked_in_for_day` no longer
  takes an `address` — both mean someone already touched this; reconcile first.
- (PER-TICKET) After the re-key, `ID` does not resolve in `event.move` and
  adding `use sui::object::{Self, ID};` does not fix it, OR `object::id(ticket)`
  is not available in `checkin.move`'s `record_and_mark` — report the compile
  error rather than reshaping the API.
- (PER-TICKET) You discover a **second** caller of `record_checkin` beyond
  `sources/checkin.move:105` (the API signature change would ripple) — report it.
- You find any frontend code that reads `is_checked_in_for_day` /
  `day_attendees` (planning-time grep found none) — its signature changes under
  PER-TICKET and that caller is out of this plan's scope; report it.
- A verification command fails twice after a reasonable fix attempt.
- The fix appears to require editing an out-of-scope file (e.g. a deploy/upgrade
  to `config.ts` or `Move.toml`) — this plan deliberately does NOT deploy.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **This plan does not deploy.** The Move logic changes here only take effect
  on-chain after a package **upgrade** (`sui client upgrade`), which is a
  separate, explicitly-authorized step. Per CLAUDE.md, on-chain upgrades require
  per-deploy user authorization and a `Move.toml` `published-at` / `config.ts`
  `PACKAGE_ID_LATEST` roll. Treat the deploy as a follow-up.
- **PER-TICKET storage-identity note**: `DayKey` is a `store` struct used as a
  `Table` key. Changing its field from `attendee: address` to `ticket: ID`
  changes its serialized layout. Existing on-chain `Event` objects created by
  the pre-upgrade package already hold a `day_attendees` table with the old key
  layout. On Sui this is generally compatible because the table is keyed by the
  *new* type after upgrade and the old per-wallet entries become unreachable
  dead weight rather than corrupting reads — but a reviewer should confirm there
  is no live event mid-window at upgrade time whose attendees would suddenly be
  able to "re-check-in" because old wallet-keyed entries no longer block them.
  For a fresh testnet package this is moot.
- **PER-ATTENDEE follow-up**: if product later wants group check-in, revisit
  this decision; the cleanest future shape is the PER-TICKET re-key described in
  Step 2A. Leave a TODO pointing here.
- A reviewer should scrutinize: (1) that `attendees` (ever-checked-in, per
  wallet) was left untouched — it feeds Seal `seal_approve_self` / UI "did this
  person attend"; (2) under PER-TICKET, that `checkin_multiday_ok` still passes
  unchanged in spirit (same ticket, two days); (3) no role gate crept in.
