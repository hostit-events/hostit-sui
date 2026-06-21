/// Sales, fees, escrow, refunds, withdrawals — generic over `Coin<T>`. Replaces
/// the EVM MarketplaceFacet. The 10-entry `FeeType` enum collapses into the type
/// parameter `T`; a coin type is "enabled" for an event iff a price was set for
/// it (see `event::set_price`).
///
/// Money flow (the spec's clean model): at sale we split the incoming coin into
/// `price` → the event's escrow `Balance<T>` and `hostit = price * fee_bps/1e4`
/// → the Hub's platform `Balance<T>`. Organizer withdrawal of the escrow is
/// gated on the refund window (if refundable); the platform fee is withdrawable
/// immediately by `PlatformCap`.
#[allow(lint(self_transfer))]
module hostit_ticket::market;

use std::ascii;
use std::type_name;
use sui::balance;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event as sui_event;
use sui::sui::SUI;
use hostit_ticket::hub::{Self, Hub};
use hostit_ticket::event::{Self, Event, OrganizerCap};
use hostit_ticket::ticket::{Self, Ticket};

const BPS_DENOM: u128 = 10_000;
const U64_MAX: u128 = 18446744073709551615;

// === Errors ===

const E_IS_FREE_EVENT: u64 = 1;
const E_NOT_FREE_EVENT: u64 = 2;
const E_PURCHASE_WINDOW: u64 = 3;
const E_SOLD_OUT: u64 = 4;
const E_MAX_TICKETS_HELD: u64 = 5;
const E_FEE_NOT_ENABLED: u64 = 6;
const E_INSUFFICIENT_PAYMENT: u64 = 7;
const E_NOT_REFUNDABLE: u64 = 8;
const E_WRONG_EVENT: u64 = 9;
const E_NOT_ISSUED: u64 = 10;
const E_WRONG_COIN: u64 = 11;
const E_REFUND_WINDOW_NOT_STARTED: u64 = 12;
const E_REFUND_WINDOW_EXPIRED: u64 = 13;
const E_WITHDRAW_PERIOD_NOT_REACHED: u64 = 14;
const E_NO_BALANCE: u64 = 15;
const E_PRICE_OVERFLOW: u64 = 16;

// === Events ===

public struct TicketMinted has copy, drop {
    event_seq: u64,
    event_id: ID,
    ticket_id: ID,
    serial: u64,
    buyer: address,
    recipient: address,
    coin_type: ascii::String,
    total_paid: u64,
}

public struct TicketRefunded has copy, drop {
    event_seq: u64,
    ticket_id: ID,
    holder: address,
    coin_type: ascii::String,
    amount: u64,         // refunded to the holder (= price)
    fee_forfeited: u64,  // platform fee retained by the Hub; NOT returned
}

public struct EventBalanceWithdrawn has copy, drop {
    event_seq: u64,
    coin_type: ascii::String,
    amount: u64,
    to: address,
}

// === Purchase ===

/// Buy a paid ticket in coin `T` for `recipient`. Returns change to the sender.
/// Mirrors EVM `mintTicket`: window `[purchaseStart, end]`, not sold out,
/// per-user cap, 3% platform fee on top of the price.
public fun buy<T>(
    event: &mut Event,
    hub: &mut Hub,
    payment: Coin<T>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(!event::is_free(event), E_IS_FREE_EVENT);
    let now = clock::timestamp_ms(clock);
    assert!(
        now >= event::purchase_start_ms(event) && now <= event::end_ms(event),
        E_PURCHASE_WINDOW,
    );
    assert!(event::minted(event) < event::max_tickets(event), E_SOLD_OUT);
    assert!(event::mint_count(event, recipient) < event::max_per_user(event), E_MAX_TICKETS_HELD);
    assert!(event::has_price<T>(event), E_FEE_NOT_ENABLED);

    let price = event::get_price<T>(event);
    let hostit = (((price as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
    let total_u128 = (price as u128) + (hostit as u128);
    assert!(total_u128 <= U64_MAX, E_PRICE_OVERFLOW);
    let total = total_u128 as u64;

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
    event::escrow_deposit(event, total_bal);

    mint_and_send(event, price, type_name::with_defining_ids<T>().into_string(), recipient, ctx);
}

/// Ergonomic SUI wrapper so PTBs/CLI need no type argument.
public fun buy_with_sui(
    event: &mut Event,
    hub: &mut Hub,
    payment: Coin<SUI>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    buy<SUI>(event, hub, payment, recipient, clock, ctx)
}

/// Claim a free ticket (EVM `mintTicket` with `isFree`). No payment, no coin type.
public fun claim_free(
    event: &mut Event,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(event::is_free(event), E_NOT_FREE_EVENT);
    let now = clock::timestamp_ms(clock);
    assert!(
        now >= event::purchase_start_ms(event) && now <= event::end_ms(event),
        E_PURCHASE_WINDOW,
    );
    assert!(event::minted(event) < event::max_tickets(event), E_SOLD_OUT);
    assert!(event::mint_count(event, recipient) < event::max_per_user(event), E_MAX_TICKETS_HELD);

    mint_and_send(event, 0, ascii::string(b""), recipient, ctx);
}

// === Refund ===

/// Holder reclaims their payment within `[end, end + refund_period]` for a
/// refundable event. The ticket is transferred to the organizer (EVM
/// `refundTicket(ticketAdmin)`) and marked refunded. Returns the refund coin.
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

    let amount = ticket::paid(&ticket);
    // The 3% platform fee paid at purchase is intentionally NON-REFUNDABLE: it
    // stays in the Hub (parity with the EVM Diamond). Only `price` (= amount) is
    // returned from escrow; we do NOT pull the fee back. We surface the retained
    // amount in TicketRefunded.fee_forfeited so the forfeit is visible on-chain.
    // Formula mirrors buy<T>'s fee split: price * fee_bps / 1e4.
    let fee_forfeited = (((amount as u128) * (hub::fee_bps(hub) as u128)) / BPS_DENOM) as u64;
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
        amount,
        fee_forfeited,
    });
    refund_coin
}

// === Withdrawals ===

/// Organizer withdraws all accrued revenue for coin type `T`. For refundable
/// events this is gated until the refund window closes (EVM
/// `withdrawTicketBalance`). Returns the coin.
public fun withdraw_event_balance<T>(
    cap: &OrganizerCap,
    event: &mut Event,
    hub: &Hub,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    event::assert_organizer(cap, event);
    if (event::is_refundable(event)) {
        let now = clock::timestamp_ms(clock);
        assert!(
            now >= event::end_ms(event) + hub::refund_period_ms(hub),
            E_WITHDRAW_PERIOD_NOT_REACHED,
        );
    };
    let amount = event::escrow_value<T>(event);
    assert!(amount > 0, E_NO_BALANCE);
    let out = coin::from_balance(event::escrow_take<T>(event, amount), ctx);
    sui_event::emit(EventBalanceWithdrawn {
        event_seq: event::event_seq(event),
        coin_type: type_name::with_defining_ids<T>().into_string(),
        amount,
        to: ctx.sender(),
    });
    out
}

// === Internal ===

fun mint_and_send(
    event: &mut Event,
    paid: u64,
    coin_type: ascii::String,
    recipient: address,
    ctx: &mut TxContext,
) {
    let serial = event::next_serial(event);
    event::inc_mint_count(event, recipient);
    let event_id = object::id(event);
    let ticket = ticket::mint(
        event::event_seq(event),
        event_id,
        serial,
        paid,
        coin_type,
        event::name_clone(event),
        event::uri_clone(event),
        ctx,
    );
    sui_event::emit(TicketMinted {
        event_seq: event::event_seq(event),
        event_id,
        ticket_id: object::id(&ticket),
        serial,
        buyer: ctx.sender(),
        recipient,
        coin_type,
        total_paid: paid,
    });
    transfer::public_transfer(ticket, recipient);
}
