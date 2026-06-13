/// Protocol-level singleton. Replaces the EVM Diamond's owner slot + global
/// HostIt-fee accounting + the `ticketId` counter. Created once at publish from
/// the one-time witness; also the place we claim the package `Publisher` and
/// stand up the `Display<Ticket>` and `TransferPolicy<Ticket>` (both need the
/// Publisher, which only exists in `init`).
#[allow(lint(share_owned, self_transfer))]
module hostit_ticket::hub;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::event;
use sui::package;
use sui::transfer_policy;
use std::ascii;
use std::type_name;
use hostit_ticket::ticket::{Self, Ticket};

// === Constants (parity with EVM, seconds→ms) ===

const HOSTIT_FEE_BPS: u64 = 300; // 3%
const REFUND_PERIOD_MS: u64 = 259_200_000; // 3 days
const ROYALTY_BPS: u64 = 500; // 5% default
const MAX_BPS: u64 = 10_000;

// === Errors ===

const E_INSUFFICIENT_BALANCE: u64 = 1;
const E_NO_BALANCE: u64 = 2;
const E_BPS_TOO_HIGH: u64 = 3;

// === One-time witness ===

public struct HUB has drop {}

// === Objects ===

/// Shared protocol config + platform-fee treasury. Platform fees are stored as
/// `Balance<T>` under dynamic fields keyed by `FeeBalanceKey<T>` — one bucket
/// per coin type, the Sui analogue of `mapping(FeeType => uint256) hostItBalance`.
public struct Hub has key {
    id: UID,
    fee_bps: u64,
    refund_period_ms: u64,
    royalty_bps: u64,
    /// Sequential event id source, for parity with the EVM `ticketId` counter.
    event_count: u64,
}

/// Protocol owner authority (EVM `onlyOwner`). Holding it lets you withdraw
/// platform fees and tune protocol parameters.
public struct PlatformCap has key, store { id: UID }

/// Dynamic-field key for the per-coin-type platform fee balance.
public struct FeeBalanceKey<phantom T> has copy, drop, store {}

// === Events ===

public struct PlatformBalanceWithdrawn has copy, drop {
    coin_type: ascii::String,
    amount: u64,
    to: address,
}

// === init ===

fun init(otw: HUB, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);

    // Display<Ticket> — renders every ticket regardless of event.
    let d = ticket::init_display(&publisher, ctx);
    transfer::public_transfer(d, ctx.sender());

    // TransferPolicy<Ticket> — shared so `Ticket` is Kiosk-tradable. Created
    // empty here (the Publisher only exists in `init`); the HostIt resale rules
    // (`policy_rules`: not_used + royalty + lock) are attached post-deploy by
    // the `TransferPolicyCap<Ticket>` holder via
    // `policy_rules::setup_ticket_policy`, which seeds the royalty bps from
    // `hub.royalty_bps`. Splitting attach out of `init` keeps the bps tunable
    // before bootstrap and avoids wiring `hub` into the OTW init ordering.
    let (policy, policy_cap) = transfer_policy::new<Ticket>(&publisher, ctx);
    transfer::public_share_object(policy);
    transfer::public_transfer(policy_cap, ctx.sender());

    let hub = Hub {
        id: object::new(ctx),
        fee_bps: HOSTIT_FEE_BPS,
        refund_period_ms: REFUND_PERIOD_MS,
        royalty_bps: ROYALTY_BPS,
        event_count: 0,
    };
    transfer::share_object(hub);

    transfer::transfer(PlatformCap { id: object::new(ctx) }, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
}

// === Config reads (package-internal consumers: market, event, checkin) ===

public(package) fun fee_bps(hub: &Hub): u64 { hub.fee_bps }
public(package) fun refund_period_ms(hub: &Hub): u64 { hub.refund_period_ms }
public fun royalty_bps(hub: &Hub): u64 { hub.royalty_bps }
public fun event_count(hub: &Hub): u64 { hub.event_count }

/// Allocate the next sequential event id (1-indexed, matching the EVM
/// pre-increment scheme).
public(package) fun next_event_seq(hub: &mut Hub): u64 {
    hub.event_count = hub.event_count + 1;
    hub.event_count
}

// === Platform-fee treasury ===

/// Credit the 3% platform fee for coin type `T`. Called by `market` at sale.
public(package) fun deposit_fee<T>(hub: &mut Hub, b: Balance<T>) {
    let key = FeeBalanceKey<T> {};
    if (df::exists_with_type<FeeBalanceKey<T>, Balance<T>>(&hub.id, key)) {
        balance::join(df::borrow_mut<FeeBalanceKey<T>, Balance<T>>(&mut hub.id, key), b);
    } else {
        df::add(&mut hub.id, key, b);
    }
}

public fun platform_balance<T>(hub: &Hub): u64 {
    let key = FeeBalanceKey<T> {};
    if (df::exists_with_type<FeeBalanceKey<T>, Balance<T>>(&hub.id, key)) {
        balance::value(df::borrow<FeeBalanceKey<T>, Balance<T>>(&hub.id, key))
    } else { 0 }
}

/// EVM `withdrawHostItBalance` — protocol owner withdraws accrued platform fees.
public fun withdraw_platform_balance<T>(
    hub: &mut Hub,
    _cap: &PlatformCap,
    amount: u64,
    to: address,
    ctx: &mut TxContext,
): Coin<T> {
    let key = FeeBalanceKey<T> {};
    assert!(df::exists_with_type<FeeBalanceKey<T>, Balance<T>>(&hub.id, key), E_NO_BALANCE);
    let bal = df::borrow_mut<FeeBalanceKey<T>, Balance<T>>(&mut hub.id, key);
    assert!(amount <= balance::value(bal), E_INSUFFICIENT_BALANCE);
    let out = balance::split(bal, amount);
    event::emit(PlatformBalanceWithdrawn {
        coin_type: type_name::with_defining_ids<T>().into_string(),
        amount,
        to,
    });
    coin::from_balance(out, ctx)
}

// === Param tuning (PlatformCap) ===

public fun set_fee_bps(hub: &mut Hub, _cap: &PlatformCap, bps: u64) {
    assert!(bps <= MAX_BPS, E_BPS_TOO_HIGH);
    hub.fee_bps = bps;
}

public fun set_royalty_bps(hub: &mut Hub, _cap: &PlatformCap, bps: u64) {
    assert!(bps <= MAX_BPS, E_BPS_TOO_HIGH);
    hub.royalty_bps = bps;
}

public fun set_refund_period_ms(hub: &mut Hub, _cap: &PlatformCap, ms: u64) {
    hub.refund_period_ms = ms;
}

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(HUB {}, ctx);
}
