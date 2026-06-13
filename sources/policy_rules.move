/// Custom `TransferPolicy<Ticket>` rules for HostIt secondary (Kiosk) sales.
///
/// The shared `TransferPolicy<Ticket>` is created in `hub::init`; this module
/// holds the rules that get attached to it so resales behave correctly:
///
/// - `not_used` (ISSUES #6): aborts the transfer/confirm of a CHECKED_IN
///   ("used") ticket. A used ticket is dead stock on the secondary market — you
///   shouldn't be able to resell a ticket that has already walked through the
///   door. This gates *transfer*, NOT check-in, so multi-day re-check-in is
///   untouched: a CHECKED_IN ticket can still be checked in again on a later
///   day (the per-day gate lives on the `Event`); it just can't be re-sold via
///   Kiosk.
///
/// - `royalty` (ISSUES #5): a fixed-basis-points fee on the `paid` amount of a
///   Kiosk sale, seeded from `hub.royalty_bps`. The fee accrues as `SUI` in the
///   `TransferPolicy` balance, withdrawable by the policy-cap holder.
///
/// - `lock` (ISSUES #5): requires the bought ticket to be `lock`ed back into a
///   Kiosk on purchase, so tickets stay inside the Kiosk/royalty system on
///   resale rather than being `take`n out and traded peer-to-peer fee-free.
///
/// These are self-contained rules built only on the Sui framework
/// (`sui::transfer_policy`, `sui::kiosk`) — no external `kiosk-rules`
/// dependency — to keep the package dependency-light and unit-testable.
///
/// Standard Kiosk resale flow once these are attached:
///   `(ticket, request) = kiosk::purchase(...)`
///   `royalty::pay(policy, &mut request, &mut sui_payment, ctx)`
///   `kiosk::lock(buyer_kiosk, buyer_cap, policy, ticket)`
///   `lock::prove(&mut request, buyer_kiosk)`
///   `not_used::prove(&mut request, &ticket_ref)`  // before lock consumes it
///   `transfer_policy::confirm_request(policy, request)`
module hostit_ticket::policy_rules;

use sui::coin::{Self, Coin};
use sui::kiosk::{Self, Kiosk};
use sui::sui::SUI;
use sui::transfer_policy::{
    Self as policy,
    TransferPolicy,
    TransferPolicyCap,
    TransferRequest,
};
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::ticket::{Self, Ticket};

// === Errors ===

/// The proven item does not match the `TransferRequest`'s item id.
const E_WRONG_ITEM: u64 = 1;
/// The ticket has been used (CHECKED_IN) and can no longer be transferred/sold.
const E_TICKET_USED: u64 = 2;
/// Royalty basis points exceed 100%.
const E_BPS_TOO_HIGH: u64 = 3;
/// The royalty payment coin is smaller than the required fee.
const E_INSUFFICIENT_ROYALTY: u64 = 4;
/// The purchased item was not locked back into a Kiosk.
const E_NOT_IN_KIOSK: u64 = 5;

const MAX_BPS: u16 = 10_000;

// === Rule witnesses ===

/// Witness for the "ticket must not be used" rule (ISSUES #6).
public struct NotUsedRule has drop {}

/// Witness for the royalty-fee rule (ISSUES #5).
public struct RoyaltyRule has drop {}

/// Witness for the lock requirement rule (ISSUES #5).
public struct LockRule has drop {}

/// Config for the royalty rule: fixed fee in basis points of the sale price.
public struct RoyaltyConfig has store, drop {
    amount_bp: u16,
}

// === Setup (policy-cap gated) ===

/// Attach the `not_used` rule (#6). Idempotent attachment is not allowed by the
/// framework (`add_rule` aborts if already set), matching every other rule.
public fun add_not_used_rule<T>(
    policy: &mut TransferPolicy<T>,
    cap: &TransferPolicyCap<T>,
) {
    policy::add_rule(NotUsedRule {}, policy, cap, true)
}

/// Attach the royalty rule (#5) with an explicit basis-points fee.
public fun add_royalty_rule<T>(
    policy: &mut TransferPolicy<T>,
    cap: &TransferPolicyCap<T>,
    amount_bp: u16,
) {
    assert!(amount_bp <= MAX_BPS, E_BPS_TOO_HIGH);
    policy::add_rule(RoyaltyRule {}, policy, cap, RoyaltyConfig { amount_bp })
}

/// Attach the lock rule (#5): purchased tickets must be locked into a Kiosk.
public fun add_lock_rule<T>(
    policy: &mut TransferPolicy<T>,
    cap: &TransferPolicyCap<T>,
) {
    policy::add_rule(LockRule {}, policy, cap, true)
}

/// Seed the full HostIt rule set onto the shared `TransferPolicy<Ticket>` in one
/// call: `not_used` + royalty (bps read from `hub.royalty_bps`) + lock. The
/// royalty bps is snapshotted at attach time; re-seeding after a `hub` change
/// means removing the royalty rule and re-adding (the framework forbids
/// double-add), so this is a one-shot bootstrap, typically run right after
/// deploy with the `TransferPolicyCap<Ticket>` held by the deployer.
public fun setup_ticket_policy(
    policy: &mut TransferPolicy<Ticket>,
    cap: &TransferPolicyCap<Ticket>,
    hub: &Hub,
) {
    add_not_used_rule(policy, cap);
    let bps = hub::royalty_bps(hub);
    add_royalty_rule(policy, cap, (bps as u16));
    add_lock_rule(policy, cap);
}

// === Buyer/resolver actions (called inside the resale PTB) ===

/// #6: prove the ticket being transferred has not been used (CHECKED_IN).
/// `ticket` must be the same object referenced by the `request`. Aborts if the
/// ticket is CHECKED_IN — a used ticket cannot be resold. REFUNDED tickets are
/// already terminal and never re-enter circulation, so only CHECKED_IN is
/// blocked here.
public fun prove_not_used(request: &mut TransferRequest<Ticket>, t: &Ticket) {
    assert!(object::id(t) == policy::item(request), E_WRONG_ITEM);
    assert!(!ticket::is_checked_in(t), E_TICKET_USED);
    policy::add_receipt(NotUsedRule {}, request)
}

/// #5: pay the royalty fee (bps of `request.paid`) in SUI. The fee is split off
/// `payment` (the remainder stays with the caller) and credited to the policy
/// balance. Rounds down; a zero fee (zero price or zero bps) still requires the
/// receipt so `confirm_request` is satisfiable.
public fun pay_royalty(
    policy: &mut TransferPolicy<Ticket>,
    request: &mut TransferRequest<Ticket>,
    payment: &mut Coin<SUI>,
    ctx: &mut TxContext,
) {
    let config: &RoyaltyConfig = policy::get_rule(RoyaltyRule {}, policy);
    let paid = policy::paid(request);
    let amount = (((paid as u128) * (config.amount_bp as u128)) / (MAX_BPS as u128)) as u64;
    assert!(coin::value(payment) >= amount, E_INSUFFICIENT_ROYALTY);
    let fee = coin::split(payment, amount, ctx);
    policy::add_to_balance(RoyaltyRule {}, policy, fee);
    policy::add_receipt(RoyaltyRule {}, request)
}

/// #5: prove the purchased ticket was locked into `kiosk`. Mirrors Mysten's
/// canonical lock rule: the item must be present AND locked in the destination
/// Kiosk, keeping resold tickets inside the Kiosk/royalty system.
public fun prove_locked(request: &mut TransferRequest<Ticket>, kiosk: &Kiosk) {
    let item = policy::item(request);
    assert!(kiosk::has_item(kiosk, item) && kiosk::is_locked(kiosk, item), E_NOT_IN_KIOSK);
    policy::add_receipt(LockRule {}, request)
}

// === Reads ===

public fun royalty_amount_bp(policy: &TransferPolicy<Ticket>): u16 {
    let config: &RoyaltyConfig = policy::get_rule(RoyaltyRule {}, policy);
    config.amount_bp
}
