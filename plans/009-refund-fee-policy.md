# Plan 009: Decide and implement the refund fee policy (refundable vs disclosed-forfeit)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` (create that file if it does not exist — a template is
> in the "Maintenance notes" section) — unless a reviewer dispatched you and
> told you they maintain the index.
>
> **This is a DECISION plan.** Step 1 is a hard STOP: you must get an explicit
> policy choice (Option A or Option B) from the maintainer before writing any
> code. Both implementation branches are fully specified below; you implement
> exactly ONE of them, the one chosen in Step 1.
>
> **Drift check (run first)**:
> `git diff --stat 957206b..HEAD -- sources/market.move sources/hub.move sources/ticket.move sources/event.move web/components/screens/EventPageScreen.tsx web/lib/ticketing.ts web/lib/moveErrors.ts tests/hostit_ticket_tests.move`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `957206b`, 2026-06-20

## Why this matters

On a refundable event, the buyer pays `price + 3% platform fee`. When they
refund, the contract returns only `price` — the 3% fee that was routed to the
`Hub` at sale is **never** returned, and the `TicketRefunded` event emits only
the returned `price`, so the loss is **invisible on-chain**. Every refunding
buyer silently forfeits 3% with no record and no disclosure. This is a
correctness/honesty defect: either the buyer should be made whole (the platform
should not keep a fee on a sale that was unwound), or — if a non-refundable fee
is the intended product behaviour, as the EVM Diamond port may dictate — that
forfeit must be **explicit in code, visible in the on-chain event, and disclosed
in the buy UI before purchase**. Right now it is none of those. We will not
guess the intended policy; Step 1 forces the choice, then this plan executes the
matching branch so the chosen behaviour is correct and auditable.

## Current state

This is a two-tree repo (see `/Users/dadadave/Dev/HostIT/sui-ticket/CLAUDE.md`):
the **Move package** lives at the repo root (`sources/*.move`, `tests/*.move`,
Move edition `2024.beta`); the **Next.js app** lives in `web/`.

### The fee is charged on top, then split Hub + escrow — `sources/market.move:96-117`

```move
let price = event::get_price<T>(event);
let hostit = (((price as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
let total = price + hostit;

let mut payment = payment;
assert!(coin::value(&payment) >= total, E_INSUFFICIENT_PAYMENT);
let total_coin = coin::split(&mut payment, total, ctx);
// Return change (or destroy an exact-payment zero coin).
if (coin::value(&payment) == 0) {
    coin::destroy_zero(payment);
} else {
    transfer::public_transfer(payment, ctx.sender());
};

// Route: hostit → Hub platform balance, price → event escrow.
let mut total_bal = coin::into_balance(total_coin);
let hostit_bal = balance::split(&mut total_bal, hostit);
hub::deposit_fee(hub, hostit_bal);
event::escrow_deposit(event, total_bal);   // only `price` lands in escrow

mint_and_send(event, price, type_name::with_defining_ids<T>().into_string(), recipient, ctx);
```

So after a sale: **escrow holds `price`**, **Hub holds `hostit`**, and the
ticket's stored `paid` field is `price` (the value passed to `mint_and_send`).

### Refund returns only `paid` (= price) and emits only that — `sources/market.move:155-189`

```move
public fun refund<T>(
    event: &mut Event,
    hub: &Hub,
    ticket: Ticket,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(event::is_refundable(event), E_NOT_REFUNDABLE);
    assert!(ticket::event_id(&ticket) == object::id(event), E_WRONG_EVENT);
    assert!(ticket::is_issued(&ticket), E_NOT_ISSUED);
    let coin_type = type_name::with_defining_ids<T>().into_string();
    assert!(ticket::paid_type(&ticket) == coin_type, E_WRONG_COIN);

    let now = clock::timestamp_ms(clock);
    let end = event::end_ms(event);
    assert!(now >= end, E_REFUND_WINDOW_NOT_STARTED);
    assert!(now <= end + hub::refund_period_ms(hub), E_REFUND_WINDOW_EXPIRED);

    let amount = ticket::paid(&ticket);                                 // = price only
    let refund_coin = coin::from_balance(event::escrow_take<T>(event, amount), ctx);

    let mut t = ticket;
    ticket::set_refunded(&mut t);
    let ticket_id = object::id(&t);
    transfer::public_transfer(t, event::organizer(event));

    sui_event::emit(TicketRefunded {
        event_seq: event::event_seq(event),
        ticket_id,
        holder: ctx.sender(),
        coin_type,
        amount,                                                          // = price only; fee loss invisible
    });
    refund_coin
}
```

Note the signature: refund takes `hub: &Hub` (an **immutable** reference). Option
A's "pull the fee back from the Hub" branch requires `&mut Hub` and a new Hub
function — see Step A2.

### The event struct has no field for retained fee — `sources/market.move:58-64`

```move
public struct TicketRefunded has copy, drop {
    event_seq: u64,
    ticket_id: ID,
    holder: address,
    coin_type: ascii::String,
    amount: u64,
}
```

### Error constants live at the top of the module — `sources/market.move:27-43`

```move
const E_IS_FREE_EVENT: u64 = 1;
// ...
const E_WITHDRAW_PERIOD_NOT_REACHED: u64 = 14;
const E_NO_BALANCE: u64 = 15;
```
Convention: error consts are named `E_FOO` and are sequential `u64`s. A new code
would be `const E_... : u64 = 16;`. (Only Option A's "refund the fee" path may
need a new code — see Step A2.)

### Hub holds platform fees per coin type and only `PlatformCap` can withdraw — `sources/hub.move:100, 115-122, 132-150`

```move
public(package) fun fee_bps(hub: &Hub): u64 { hub.fee_bps }
// ...
/// Credit the 3% platform fee for coin type `T`. Called by `market` at sale.
public(package) fun deposit_fee<T>(hub: &mut Hub, b: Balance<T>) {
    let key = FeeBalanceKey<T> {};
    if (df::exists_with_type<FeeBalanceKey<T>, Balance<T>>(&hub.id, key)) {
        balance::join(df::borrow_mut<FeeBalanceKey<T>, Balance<T>>(&mut hub.id, key), b);
    } else {
        df::add(&mut hub.id, key, b);
    }
}
```
There is **no** `public(package)` function today that lets `market` withdraw a
fee back out of the Hub (only `withdraw_platform_balance` exists, and it requires
`&PlatformCap`). Option A's Hub-refund path adds one — see Step A2.

### The ticket stores `paid` (= price) and its coin type — `sources/ticket.move:37-43, 111-112`

```move
/// Amount paid at mint, in the coin's smallest unit (0 for free tickets).
paid: u64,
/// Fully-qualified coin type the ticket was paid in (e.g. `0x2::sui::SUI`).
paid_type: ascii::String,
// ...
public fun paid(t: &Ticket): u64 { t.paid }
public fun paid_type(t: &Ticket): ascii::String { t.paid_type }
```
`paid` is `price` (not `price + fee`). To make a buyer whole, the fee must be
recomputed at refund time (Option A1) or pulled from the Hub (Option A2) — the
ticket does not store the fee.

### Hub fee rate is 3% — `sources/hub.move:21`

```move
const HOSTIT_FEE_BPS: u64 = 300; // 3%
```
**Caveat for Option A1** (recompute fee at refund): `fee_bps` is tunable via
`hub::set_fee_bps` (`sources/hub.move:154-157`). If the rate changed between a
buyer's purchase and their refund, recomputing `price * fee_bps / 1e4` at refund
time would refund the *wrong* fee. The Hub-pull path (Option A2) avoids this by
moving the exact `hostit` that was deposited — but it cannot know per-ticket how
much fee a specific ticket contributed (the Hub pools fees per coin type). See
the Option A decision sub-note in Step 1.

### The existing Move test suite is the contract test bed — `tests/hostit_ticket_tests.move`

There is **no** separate `market` test file; all market/refund tests live in
`tests/hostit_ticket_tests.move`. Reuse its helpers and constants. Relevant
existing pieces:

Constants and helpers (`tests/hostit_ticket_tests.move:18-81`):
```move
const ADMIN: address = @0xA1;
const ORG: address = @0x0123;
const BUYER: address = @0xB0B;
const PRICE: u64 = 1_000_000;
const HOSTIT_FEE: u64 = 30_000; // PRICE * 300 / 10000
// ...
const REFUND_NOW: u64 = 250_000_000; // in [END, END + 3d]
fun begin(): (Scenario, Clock) { /* hub::init_for_testing + clock */ }
fun create_event(sc, clock, max_tickets, max_per_user, is_free, is_refundable): OrganizerCap { ... }
fun mint(amount: u64, sc: &mut Scenario): Coin<SUI> { coin::mint_for_testing<SUI>(amount, sc.ctx()) }
```

The existing happy-path refund test (`tests/hostit_ticket_tests.move:474-515`)
**currently asserts the bug**: it expects the buyer to get back only `PRICE`.

```move
#[test]
fun refund_ok() {
    // ... buy with `mint(PRICE + HOSTIT_FEE, ...)`, then:
    let refunded = market::refund<SUI>(&mut ev, &hub, t, &clock, sc.ctx());
    assert!(coin::value(&refunded) == PRICE, 0);          // <-- Option A must change to PRICE + HOSTIT_FEE
    assert!(event::escrow_value<SUI>(&ev) == 0, 1);       // <-- still true under A1; under A2 escrow drains price, Hub drains fee
    coin::burn_for_testing(refunded);
    // ...
}
```

Test style to copy: `#[test]` for happy paths with `assert!(cond, N)` numeric
codes; `#[test, expected_failure(abort_code = hostit_ticket::market::E_FOO)]`
for abort cases. Each test calls `clock.destroy_for_testing()` and `sc.end()` at
the end and `destroy(cap)` for the OrganizerCap.

### Move error codes are mirrored to the frontend — `web/lib/moveErrors.ts:16-32`

```ts
market: {
  1: "This is a free event — use Claim, not Buy.",
  // ...
  14: "Revenue can't be withdrawn until the refund window closes.",
  15: "No balance to withdraw.",
},
```
**Rule (from CLAUDE.md):** when you add a Move error code, add its human-text
mapping here under the matching module key. (Only Option A2 may add a code.)

### The buy UI already discloses the buy-side fee, but the Refunds tile is wrong — `web/components/screens/EventPageScreen.tsx`

The buy panel already shows the fee at purchase time
(`web/components/screens/EventPageScreen.tsx:438-454`):
```tsx
{buying ? "Buying…" : canAct ? `Buy · ${fmtAmount(total, ci.decimals)} ${ci.symbol}` : statusLabel()}
// tooltip:
Total incl. 3% fee: {fmtAmount(total, ci.decimals)} {ci.symbol}
// helper line:
<div className="text-[11px]" style={{ color: "var(--fg3)" }}>
  A 3% platform fee is added at checkout.
</div>
```

The "Refunds" Good-to-know tile is the misleading part
(`web/components/screens/EventPageScreen.tsx:317-325`):
```tsx
<GoodToKnow
  icon="mdi:cash-refund"
  title="Refunds"
  value={
    isRefundable
      ? `Refundable up to ${Math.round(REFUND_PERIOD_MS / 86_400_000)} days before`
      : "Non-refundable"
  }
/>
```
This string is wrong on two counts: (a) the refund window is `[end, end +
refund_period]` — i.e. *after* the event ends, **not** "before"; and (b) it does
not say the 3% fee is non-refundable. `REFUND_PERIOD_MS` and `coinInfo`/`fmtAmount`
are already imported (`web/components/screens/EventPageScreen.tsx:7`). Tokens
like `var(--fg3)` and the `<GoodToKnow>` component are the existing UI vocabulary
— reuse them; do not introduce new components or raw hex colors.

`totalWithFee(priceUnits)` (`web/lib/ticketing.ts:82-85`) returns
`price + price*FEE_BPS/1e4` and is the canonical fee math on the frontend; reuse
it rather than recomputing.

## Commands you will need

Run **Move** commands from the repo root `/Users/dadadave/Dev/HostIT/sui-ticket`.
Run **frontend** commands from `/Users/dadadave/Dev/HostIT/sui-ticket/web`.
Package manager is **bun** only — never npm/pnpm.

| Purpose | Command | Expected on success |
|---|---|---|
| Build Move | `sui move build` | exit 0, `BUILDING hostit_ticket`, no errors |
| Run all Move tests | `sui move test` | exit 0, all tests `[ PASS ]`, `Test result: OK` |
| Run a Move test subset | `sui move test refund` | exit 0, the matched tests PASS |
| Frontend deps (if needed) | `bun install` | exit 0 |
| Frontend typecheck (PRIMARY gate) | `bunx tsc --noEmit` | exit 0, no output |
| Frontend lint | `bun run lint` | exit 0 |
| Frontend unit tests | `bun run test` | exit 0, all vitest tests pass |

**Do NOT run `bun run build`** while a dev server is running — it corrupts
`.next/` (CLAUDE.md). The frontend gate is `bunx tsc --noEmit`, not a build.

## Scope

The in-scope set depends on the Option chosen in Step 1.

**Option A (fees refundable) — in scope:**
- `sources/market.move` — make refund return the full amount.
- `sources/hub.move` — **only if you choose the A2 Hub-pull variant** (add a
  `public(package)` refund-fee function + possibly a new error const).
- `tests/hostit_ticket_tests.move` — update `refund_ok` and add a
  "made-whole" assertion test.
- `web/lib/moveErrors.ts` — **only if A2 adds a new error code.**

**Option B (fees intentionally non-refundable) — in scope:**
- `sources/market.move` — add an explicit forfeit comment in `refund<T>` and a
  `fee_forfeited` field on `TicketRefunded`.
- `tests/hostit_ticket_tests.move` — assert the event now carries the forfeited
  amount.
- `web/components/screens/EventPageScreen.tsx` — fix the Refunds tile copy to
  disclose the non-refundable fee (and correct the "before" wording).

**Out of scope (both options — do NOT touch):**
- `web/lib/config.ts` — `FEE_BPS`/`REFUND_PERIOD_MS` are mirrors of Hub
  constants; this plan does not change the fee rate or window, only refund
  behaviour. Changing them would silently desync the UI from the chain.
- `sources/event.move`, `sources/ticket.move` — the escrow/`paid` plumbing is
  correct as-is; refund-amount logic belongs in `market`/`hub`, not here.
- Any **on-chain deploy / package upgrade** (`sui client upgrade`/`publish`).
  Deploys are separately gated and require explicit per-deploy authorization
  (CLAUDE.md). This plan ends at a green local build + tests; it does NOT roll
  `PACKAGE_ID_LATEST` or publish.
- The buy-side fee disclosure (`EventPageScreen.tsx:438-454`) — already correct;
  leave it.
- `SPONSORED_TARGETS` in `web/lib/config.ts` — neither option adds or renames a
  Move entry function, so the allowlist is unaffected. Do not touch it.

## Git workflow

(Match the repo's observed conventions — conventional commits; see
`git log --oneline -5`, e.g. `chore(deploy): roll config to fresh v1 package`.)

- Branch: `advisor/009-refund-fee-policy`
- Commit per logical unit; conventional-commit messages, e.g.
  `fix(market): refund the platform fee on refundable events` (Option A) or
  `fix(market): record forfeited fee on refund and disclose it in buy UI` (Option B).
- Do **NOT** push or open a PR (the repo flow is issue → branch → PR and the
  maintainer drives that; `gh` CLI may hang). Stop after local verification.

## Steps

### Step 1 (BLOCKING DECISION — STOP here first)

Do not edit any file yet. Present the following choice to the maintainer and
**wait for an explicit answer ("Option A" or "Option B")**. A general
"continue" / "go ahead" is **not** a sufficient answer to this step — you need
the policy choice spelled out, because the EVM Diamond port may intend the fee
to be non-refundable.

Present this summary verbatim:

> **Refund fee policy decision (plan 009).** On a refundable event, a buyer pays
> `price + 3% fee`; on refund they get back only `price`. The 3% fee stays in
> the Hub and the `TicketRefunded` event hides the loss.
>
> - **Option A — fees are refundable (buyer made whole).** Refund returns
>   `price + fee`. Two sub-variants:
>   - **A1 (recompute):** at refund, recompute `fee = price * hub.fee_bps / 1e4`
>     and pay `price + fee` out of escrow. Requires that escrow hold the full
>     `price + fee` at sale (change the sale-time split so the fee also lands in
>     escrow, OR keep the Hub split and instead pull the fee back in A2).
>     **Risk:** if `fee_bps` was changed between buy and refund, the recomputed
>     fee is wrong.
>   - **A2 (Hub-pull):** keep the sale-time split as-is (fee → Hub), and at
>     refund pull the fee back out of the Hub. Avoids the rate-drift bug but
>     needs a new `public(package)` Hub function and changes `refund`'s `&Hub`
>     to `&mut Hub`.
> - **Option B — fee is intentionally non-refundable (parity with EVM).** Keep
>   the money flow, but make the forfeit explicit: add a `fee_forfeited` field to
>   `TicketRefunded` so the retained amount is visible on-chain, comment the
>   forfeit in `refund<T>`, and fix the buy UI's Refunds tile to disclose that
>   the 3% fee is non-refundable.
>
> Which option (and for A, which sub-variant) should I implement?

**Verify**: You have a written choice from the maintainer naming exactly one of
`A1`, `A2`, or `B`. If you do not, STOP — do not proceed to any code step.

---

## Branch A — fees refundable (implement ONLY if Step 1 chose A1 or A2)

### Step A1 (variant A1 only): make escrow hold the full amount and refund it

In `sources/market.move`, change the sale-time routing so the **full `total`**
(`price + hostit`) is escrowed instead of splitting the fee out to the Hub.
Replace the routing block at `sources/market.move:110-116`:

```move
// Route: hostit → Hub platform balance, price → event escrow.
let mut total_bal = coin::into_balance(total_coin);
let hostit_bal = balance::split(&mut total_bal, hostit);
hub::deposit_fee(hub, hostit_bal);
event::escrow_deposit(event, total_bal);

mint_and_send(event, price, ...);
```
with: escrow the entire `total_coin` and do **not** deposit to the Hub at sale.
Then in `refund<T>` (`sources/market.move:173`) refund `ticket::paid + fee`,
where `fee = paid * hub::fee_bps(hub) / 1e4` (reuse `BPS_DENOM`).

**Decision conflict to surface, do not silently resolve:** moving the fee into
escrow means the platform only earns its fee when the organizer withdraws
(non-refunded sales) — i.e. it changes *when/where* the platform fee is held for
**all** paid events, not just refunded ones, and `withdraw_event_balance` would
then pay the organizer the fee too unless you also net it out there. **This is a
larger money-flow change than A2.** If Step 1 chose A1, confirm with the
maintainer that this Hub-vs-escrow accounting change is acceptable before
writing it; if it is not, fall back to A2. (This is why A2 is the recommended
default — it is a localized change.)

**Verify**: `sui move build` → exit 0, no errors.

### Step A2 (variant A2 only): pull the fee back from the Hub at refund

1. In `sources/hub.move`, add a `public(package)` function that removes a given
   `amount` of coin `T` from the platform fee balance and returns it as a
   `Balance<T>`, for `market` to hand back to the refunder. Model it on
   `deposit_fee` (`sources/hub.move:115-122`) and `withdraw_platform_balance`
   (`sources/hub.move:132-150`) but with **no `PlatformCap`** (it is package-
   internal, called by `market::refund`). Shape:

   ```move
   /// Reclaim `amount` of the platform fee for coin `T` back out of the Hub so
   /// `market::refund` can make a refunding buyer whole. Package-internal: the
   /// only caller is market::refund, which has already validated the refund.
   public(package) fun refund_fee<T>(hub: &mut Hub, amount: u64): Balance<T> {
       let key = FeeBalanceKey<T> {};
       assert!(df::exists_with_type<FeeBalanceKey<T>, Balance<T>>(&hub.id, key), E_NO_BALANCE);
       let bal = df::borrow_mut<FeeBalanceKey<T>, Balance<T>>(&mut hub.id, key);
       assert!(amount <= balance::value(bal), E_INSUFFICIENT_BALANCE);
       balance::split(bal, amount)
   }
   ```
   `E_NO_BALANCE` (=2) and `E_INSUFFICIENT_BALANCE` (=1) already exist in
   `sources/hub.move:28-29` — reuse them; you should **not** need a new error
   const here. (If your final implementation does introduce a new `market` error
   code for any reason, add its human text to `web/lib/moveErrors.ts` under the
   `market` key per CLAUDE.md — but the shape above avoids that.)

2. In `sources/market.move`, change `refund<T>`'s `hub: &Hub` parameter to
   `hub: &mut Hub` (`sources/market.move:157`), compute
   `let fee = (((amount as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;`
   then build the refund coin from **both** the escrowed price and the pulled
   fee. Concretely, replace `sources/market.move:173-174`:
   ```move
   let amount = ticket::paid(&ticket);
   let refund_coin = coin::from_balance(event::escrow_take<T>(event, amount), ctx);
   ```
   with something like:
   ```move
   let price = ticket::paid(&ticket);
   let fee = (((price as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
   let mut bal = event::escrow_take<T>(event, price);
   balance::join(&mut bal, hub::refund_fee<T>(hub, fee));
   let total = price + fee;
   let refund_coin = coin::from_balance(bal, ctx);
   ```
   and emit `amount: total` in `TicketRefunded` (`sources/market.move:181-187`)
   so the event reflects the full refund. (`balance` is already imported at
   `sources/market.move:16`.)

   **Same rate-drift caveat as A1:** this recomputes `fee` from the *current*
   `fee_bps`. If the rate was lowered after the buyer paid, `refund_fee` pulls
   less than they paid; if raised, it could over-pull (and abort if the Hub
   bucket lacks balance). For v1 this is acceptable because `fee_bps` is not
   expected to change mid-event; note it in the PR (see Maintenance notes). Do
   not try to store per-ticket fee unless the maintainer asks — that is a
   `ticket.move` change and out of scope here.

3. Update the call sites of `refund` in tests to pass `&mut hub` (the tests
   currently take `let hub = sc.take_shared<Hub>();` immutably before refund,
   e.g. `tests/hostit_ticket_tests.move:496`). Change those `let hub` to
   `let mut hub` and pass `&mut hub`.

**Verify**: `sui move build` → exit 0, no errors.

### Step A3 (A1 or A2): update tests to assert the buyer is made whole

In `tests/hostit_ticket_tests.move`:

1. Fix `refund_ok` (`tests/hostit_ticket_tests.move:474-515`): change
   `assert!(coin::value(&refunded) == PRICE, 0);` to
   `assert!(coin::value(&refunded) == PRICE + HOSTIT_FEE, 0);`. The buy already
   pays `mint(PRICE + HOSTIT_FEE, ...)`. For A2, the platform-fee bucket should
   now be empty after the refund — add
   `assert!(hub::platform_balance<SUI>(&hub) == 0, ...);` (the `hub` is in scope
   in that block). For A1, escrow held the full amount so
   `assert!(event::escrow_value<SUI>(&ev) == 0, 1);` stays valid; keep it.

2. Add a new dedicated test `refund_makes_buyer_whole` immediately after
   `refund_ok`, modeled on it, that asserts the refunded coin equals exactly the
   total the buyer paid:
   ```move
   #[test]
   fun refund_makes_buyer_whole() {
       // buy with mint(PRICE + HOSTIT_FEE), advance to REFUND_NOW, refund,
       // assert coin::value(&refunded) == PRICE + HOSTIT_FEE.
       // (For A2 also assert hub::platform_balance<SUI>(&hub) == 0 afterward.)
   }
   ```

**Verify**: `sui move test refund` → exit 0, `refund_ok` and
`refund_makes_buyer_whole` both `[ PASS ]`; then `sui move test` → exit 0,
`Test result: OK` (no other test regressed). Then, if you touched
`web/lib/moveErrors.ts` at all: `cd web && bunx tsc --noEmit` → exit 0 and
`bun run lint` → exit 0 and `bun run test` → exit 0.

**Skip the rest of Branch B.** Go to "Done criteria".

---

## Branch B — fee intentionally non-refundable (implement ONLY if Step 1 chose B)

### Step B1: record the forfeited fee on-chain and comment the forfeit

In `sources/market.move`:

1. Add a `fee_forfeited: u64` field to the `TicketRefunded` struct
   (`sources/market.move:58-64`):
   ```move
   public struct TicketRefunded has copy, drop {
       event_seq: u64,
       ticket_id: ID,
       holder: address,
       coin_type: ascii::String,
       amount: u64,         // refunded to the holder (= price)
       fee_forfeited: u64,  // platform fee retained by the Hub; NOT returned
   }
   ```

2. In `refund<T>`, compute the forfeited fee and populate the new field. The fee
   the buyer originally paid was `price * fee_bps / 1e4`; `price` is
   `ticket::paid`. Insert after `let amount = ticket::paid(&ticket);`
   (`sources/market.move:173`):
   ```move
   // The 3% platform fee paid at purchase is intentionally NON-REFUNDABLE: it
   // stays in the Hub (parity with the EVM Diamond). We surface the retained
   // amount in TicketRefunded.fee_forfeited so the forfeit is visible on-chain.
   let fee_forfeited = (((amount as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
   ```
   and add `fee_forfeited` to the emitted event (`sources/market.move:181-187`).
   `hub` is already an immutable `&Hub` param here, and `hub::fee_bps` takes
   `&Hub` — no signature change needed. `BPS_DENOM` is already defined
   (`sources/market.move:25`).

**Verify**: `sui move build` → exit 0, no errors.

### Step B2: assert the forfeited fee in tests

In `tests/hostit_ticket_tests.move`, the on-chain `TicketRefunded` event is not
directly asserted today, but the **money** is: after `refund_ok`
(`tests/hostit_ticket_tests.move:474-515`) the Hub still holds the fee. Add an
assertion in `refund_ok` that the platform fee is retained (it is — refund does
not touch the Hub): in the refund block where `hub` is in scope, add
`assert!(hub::platform_balance<SUI>(&hub) == HOSTIT_FEE, 3);` (the buyer paid
`PRICE + HOSTIT_FEE`, escrow had `PRICE`, refund returns `PRICE`, Hub keeps
`HOSTIT_FEE`). Keep the existing `assert!(coin::value(&refunded) == PRICE, 0);`
— under Option B that is the **correct** behaviour, not a bug.

This pins the invariant "the fee equal to `fee_forfeited` remains in the Hub
after a refund," which is the on-chain meaning of the new field.

**Verify**: `sui move test refund` → exit 0, `refund_ok` PASSes with the new
assertion; `sui move test` → exit 0, `Test result: OK`.

### Step B3: disclose the non-refundable fee in the buy UI and fix the wording

In `web/components/screens/EventPageScreen.tsx`, fix the Refunds Good-to-know
tile (`web/components/screens/EventPageScreen.tsx:317-325`). The current string
says "Refundable up to N days before" — that is wrong (the window is *after* the
event) and silent on the fee. Replace the `value` expression so it:
- for a refundable event, states the window is **after the event ends** and that
  the **3% platform fee is non-refundable**, e.g.
  `Refundable for ${Math.round(REFUND_PERIOD_MS / 86_400_000)} days after the event ends — the 3% platform fee is non-refundable`;
- for a non-refundable event, keeps `"Non-refundable"`.

Reuse the already-imported `REFUND_PERIOD_MS` (`EventPageScreen.tsx:7`) and the
existing `<GoodToKnow>` component and `var(--fg*)` tokens. Do **not** add new
components, new imports beyond what exists, or raw hex colors. Do **not** touch
the buy-button fee disclosure at `EventPageScreen.tsx:438-454` — it is already
correct.

**Verify**: from `web/`: `bunx tsc --noEmit` → exit 0 (no output); `bun run lint`
→ exit 0; `bun run test` → exit 0 (all vitest pass). Optionally
`grep -n "non-refundable" web/components/screens/EventPageScreen.tsx` → matches
your new copy.

## Test plan

- **Option A (A1 or A2):**
  - Update `refund_ok` (`tests/hostit_ticket_tests.move`) to expect
    `PRICE + HOSTIT_FEE` returned; for A2 also assert
    `hub::platform_balance<SUI> == 0` post-refund.
  - Add `refund_makes_buyer_whole` — happy path asserting the refund equals the
    exact total paid. Model after `refund_ok`
    (`tests/hostit_ticket_tests.move:474-515`).
  - All existing market/refund/withdraw tests must still pass unchanged in
    intent (the `refund_*_fails` abort tests at lines 517-614 and the withdraw
    tests at 616-840 should be unaffected; if A1's money-flow change breaks
    `withdraw_nonrefundable_immediate` at line 618 — because escrow now includes
    the fee — that is a signal A1 needs the withdraw-side netting discussed in
    Step A1; STOP and report rather than loosening the assertion).
  - Verification: `sui move test` → `Test result: OK`, including the 1 new test.
- **Option B:**
  - Augment `refund_ok` to assert `hub::platform_balance<SUI> == HOSTIT_FEE`
    after refund (the on-chain meaning of `fee_forfeited`).
  - Frontend: existing vitest suite must still pass (the change is copy-only);
    no new frontend test is required, but `bun run test` must stay green.
  - Verification: `sui move test` → `Test result: OK`; `bunx tsc --noEmit`,
    `bun run lint`, `bun run test` all exit 0.

## Done criteria

Machine-checkable. The applicable set depends on the chosen option.

**Always:**
- [ ] A written Option choice (A1 / A2 / B) from the maintainer is recorded
      (Step 1) before any code change.
- [ ] `sui move build` exits 0 with no errors.
- [ ] `sui move test` exits 0 and prints `Test result: OK`.
- [ ] No files outside this plan's in-scope list for the chosen option are
      modified: `git status --porcelain` shows only the expected paths (and the
      new `plans/009-refund-fee-policy.md` / `plans/README.md`).
- [ ] `plans/README.md` status row for plan 009 updated.

**If Option A (A1 or A2):**
- [ ] `sui move test refund` shows `refund_ok` **and** `refund_makes_buyer_whole`
      `[ PASS ]`.
- [ ] `grep -n "PRICE + HOSTIT_FEE" tests/hostit_ticket_tests.move` matches the
      updated `refund_ok` assertion.
- [ ] (A2 only) `grep -n "refund_fee" sources/hub.move` matches the new
      `public(package)` function and `refund<T>` takes `hub: &mut Hub`
      (`grep -n "hub: &mut Hub" sources/market.move`).
- [ ] If `web/lib/moveErrors.ts` was touched: `cd web && bunx tsc --noEmit`,
      `bun run lint`, `bun run test` all exit 0.

**If Option B:**
- [ ] `grep -n "fee_forfeited" sources/market.move` matches both the struct
      field and the emit.
- [ ] `grep -n "platform_balance<SUI>(&hub) == HOSTIT_FEE" tests/hostit_ticket_tests.move`
      matches the new assertion.
- [ ] `web/components/screens/EventPageScreen.tsx` Refunds tile no longer
      contains the string "days before"
      (`grep -n "days before" web/components/screens/EventPageScreen.tsx` → no
      match) and contains a non-refundable-fee disclosure.
- [ ] From `web/`: `bunx tsc --noEmit` exits 0, `bun run lint` exits 0,
      `bun run test` exits 0.

## STOP conditions

Stop and report back (do not improvise) if:

- **No explicit option choice.** Step 1 did not yield a clear A1 / A2 / B answer.
  Never pick a policy yourself — the EVM port may intend the non-refundable fee.
- **Drift:** the code at the cited `file:line` locations does not match the
  "Current state" excerpts (e.g. `market.move` refund logic, `TicketRefunded`
  struct, the `refund_ok` test, or the `EventPageScreen.tsx` Refunds tile have
  changed since commit `957206b`).
- **A1 money-flow conflict:** implementing A1 would require also changing
  `withdraw_event_balance` to net the fee out of the organizer's payout (an
  out-of-scope `market` accounting change), or breaks
  `withdraw_nonrefundable_immediate`. Report and recommend A2 instead.
- **A2 rate-drift exposure deemed unacceptable:** if the maintainer signals
  `fee_bps` may change mid-event, the recompute approach is unsafe and storing
  per-ticket fee (a `ticket.move` change) is needed — that is out of scope here;
  report and propose a follow-up plan.
- A verification command fails twice after a reasonable fix attempt.
- The fix appears to require touching a file not in the chosen option's in-scope
  list (especially `web/lib/config.ts` `FEE_BPS`/`REFUND_PERIOD_MS`,
  `sources/event.move`, `sources/ticket.move`, or a deploy/upgrade).
- You find yourself about to run `sui client upgrade` or `sui client publish`.
  Deploys are out of scope and separately authorized — STOP.

## Maintenance notes

For the human/agent who owns this after the change lands:

- **This was a policy decision** (recorded in Step 1). The PR description must
  state which option was chosen and why, so future readers know the fee
  behaviour is intentional.
- **Deploy is a separate, gated step.** This plan stops at green local
  build/tests. The Move change only takes effect after a package upgrade
  (`sui client upgrade`) plus rolling `PACKAGE_ID_LATEST` in `web/lib/config.ts`
  and re-`tsc` — all of which require explicit per-deploy authorization
  (CLAUDE.md). Schedule that separately.
- **(Option A2/A1) Rate-drift:** refund recomputes the fee from the *current*
  `hub.fee_bps`. If the platform ever changes `fee_bps` while events with
  outstanding refundable tickets exist, refunds will use the new rate. If that
  becomes a real scenario, the durable fix is to store the fee paid on the
  `Ticket` at mint (a `ticket.move` field) and refund that exact value — a
  separate plan. Reviewer should scrutinize the fee recompute and, for A2, that
  `refund_fee` cannot underflow the Hub bucket (it asserts `amount <= balance`).
- **(Option B) Indexers/clients:** adding `fee_forfeited` to `TicketRefunded` is
  an additive event-schema change. Any off-chain indexer parsing `TicketRefunded`
  should be updated to read the new field; confirm none breaks on the extra
  field. The frontend does not currently parse this event, so no frontend read
  change is required.
- **Reviewer focus:** (A) the money is conserved — buyer made whole, no value
  minted or stranded; (B) the refunded amount is unchanged (still `price`) and
  the new field equals the fee actually retained in the Hub; the UI copy matches
  the on-chain behaviour (window is *after* the event; fee non-refundable).

---

### `plans/README.md` template (create if missing)

```markdown
# Implementation Plans

Generated by the improve skill. Execute in the order below unless dependencies
say otherwise. Each executor: read the plan fully before starting, honor its
STOP conditions, and update your row when done.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 009  | Decide and implement the refund fee policy (refundable vs disclosed-forfeit) | P1 | M | — | TODO |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (reason) | REJECTED (rationale)
```
