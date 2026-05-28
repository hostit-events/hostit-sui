#[allow(lint(share_owned, custom_state_change, self_transfer))]
module sui_ticket::ticketing;

use std::string::{Self, String};
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::display;
use sui::event;
use sui::package;
use sui::transfer_policy;

// === Constants ===

const STATUS_ISSUED: u8 = 0;
const STATUS_USED: u8 = 1;

const REFUND_NONE: u8 = 0;
const REFUND_FULL_BEFORE_VALID_FROM: u8 = 1;

// === Errors ===

const E_SOLD_OUT: u64 = 1;
const E_KIND_PAUSED: u64 = 2;
const E_KIND_CLOSED: u64 = 3;
const E_INVALID_PAYMENT_AMOUNT: u64 = 4;
const E_INVALID_SUPPLY: u64 = 6;
const E_INVALID_REFUND_POLICY: u64 = 7;
const E_NOT_ISSUED: u64 = 10;
const E_NOT_REFUNDABLE: u64 = 11;
const E_REFUND_WINDOW_CLOSED: u64 = 12;
const E_WRONG_KIND: u64 = 13;
const E_BEFORE_VALID_FROM: u64 = 20;
const E_AFTER_VALID_UNTIL: u64 = 21;
const E_NOT_CREATOR: u64 = 30;
const E_WITHDRAW_EXCEEDS_BALANCE: u64 = 40;
const E_INVALID_TIME_WINDOW: u64 = 50;

// === One-time witness ===

public struct TICKETING has drop {}

// === Structs ===

/// A class of tickets. Self-contained: the wallet that called
/// `create_ticket_kind` is the `creator` and is the only address authorized to
/// pause / resume / close / update / withdraw. No separate Issuer object, no
/// IssuerCap to manage.
public struct TicketKind<phantom C> has key {
    id: UID,
    /// Address that created this kind. Admin auth checks `ctx.sender() == creator`.
    /// Also surfaced in the off-chain UI for suiNS-based verification badging.
    creator: address,
    /// Free-form brand name (e.g. "Acme Tickets", "MTA"). Used in displays.
    creator_name: String,
    name: String,
    description: String,
    image_url: String,
    supply_cap: u64,
    sold: u64,
    outstanding: u64,
    price: u64,
    valid_from_ms: u64,
    valid_until_ms: u64,
    refund_policy: u8,
    keep_as_souvenir: bool,
    paused: bool,
    closed: bool,
    balance: Balance<C>,
    version: u64,
}

public struct Ticket has key, store {
    id: UID,
    kind_id: ID,
    status: u8,
    issued_at_ms: u64,
    name: String,
    image_url: String,
}

// === Events ===

public struct TicketKindCreated has copy, drop {
    kind_id: ID,
    creator: address,
    creator_name: String,
    name: String,
    supply_cap: u64,
    price: u64,
    keep_as_souvenir: bool,
}

public struct TicketBought has copy, drop {
    ticket_id: ID,
    kind_id: ID,
    buyer: address,
    recipient: address,
    price: u64,
    timestamp_ms: u64,
}

public struct TicketUsed has copy, drop {
    ticket_id: ID,
    kind_id: ID,
    holder: address,
    timestamp_ms: u64,
    burned: bool,
}

public struct TicketRefunded has copy, drop {
    ticket_id: ID,
    kind_id: ID,
    holder: address,
    refund_amount: u64,
    timestamp_ms: u64,
}

public struct RevenueWithdrawn has copy, drop {
    kind_id: ID,
    creator: address,
    amount: u64,
}

// === init ===

fun init(witness: TICKETING, ctx: &mut TxContext) {
    let publisher = package::claim(witness, ctx);

    let keys = vector[
        string::utf8(b"name"),
        string::utf8(b"image_url"),
        string::utf8(b"description"),
        string::utf8(b"project_url"),
    ];
    let values = vector[
        string::utf8(b"{name}"),
        string::utf8(b"{image_url}"),
        string::utf8(b"Ticket on sui-ticket"),
        string::utf8(b"https://sui-ticket.app"),
    ];
    let mut d = display::new_with_fields<Ticket>(&publisher, keys, values, ctx);
    display::update_version(&mut d);
    transfer::public_transfer(d, ctx.sender());

    let (policy, policy_cap) = transfer_policy::new<Ticket>(&publisher, ctx);
    transfer::public_share_object(policy);
    transfer::public_transfer(policy_cap, ctx.sender());

    transfer::public_transfer(publisher, ctx.sender());
}

// === Create kind (the ONE primary action) ===

/// Permissionless. Anyone can create a ticket kind. The caller becomes the
/// `creator` and is the sole address authorized to administer this kind
/// (pause / resume / close / update / withdraw revenue).
public fun create_ticket_kind<C>(
    creator_name: String,
    name: String,
    description: String,
    image_url: String,
    supply_cap: u64,
    price: u64,
    valid_from_ms: u64,
    valid_until_ms: u64,
    refund_policy: u8,
    keep_as_souvenir: bool,
    ctx: &mut TxContext,
) {
    assert!(supply_cap > 0, E_INVALID_SUPPLY);
    assert!(valid_from_ms < valid_until_ms, E_INVALID_TIME_WINDOW);
    assert!(
        refund_policy == REFUND_NONE || refund_policy == REFUND_FULL_BEFORE_VALID_FROM,
        E_INVALID_REFUND_POLICY,
    );

    let creator = ctx.sender();
    let kind = TicketKind<C> {
        id: object::new(ctx),
        creator,
        creator_name,
        name,
        description,
        image_url,
        supply_cap,
        sold: 0,
        outstanding: 0,
        price,
        valid_from_ms,
        valid_until_ms,
        refund_policy,
        keep_as_souvenir,
        paused: false,
        closed: false,
        balance: balance::zero<C>(),
        version: 0,
    };

    event::emit(TicketKindCreated {
        kind_id: object::id(&kind),
        creator,
        creator_name: kind.creator_name,
        name: kind.name,
        supply_cap,
        price,
        keep_as_souvenir,
    });

    transfer::share_object(kind);
}

// === Kind admin (creator-authenticated via ctx.sender) ===

public fun update_kind_metadata<C>(
    kind: &mut TicketKind<C>,
    description: String,
    image_url: String,
    ctx: &mut TxContext,
) {
    assert!(kind.creator == ctx.sender(), E_NOT_CREATOR);
    kind.description = description;
    kind.image_url = image_url;
    kind.version = kind.version + 1;
}

public fun pause_kind<C>(kind: &mut TicketKind<C>, ctx: &mut TxContext) {
    assert!(kind.creator == ctx.sender(), E_NOT_CREATOR);
    kind.paused = true;
    kind.version = kind.version + 1;
}

public fun resume_kind<C>(kind: &mut TicketKind<C>, ctx: &mut TxContext) {
    assert!(kind.creator == ctx.sender(), E_NOT_CREATOR);
    kind.paused = false;
    kind.version = kind.version + 1;
}

public fun close_kind<C>(kind: &mut TicketKind<C>, ctx: &mut TxContext) {
    assert!(kind.creator == ctx.sender(), E_NOT_CREATOR);
    kind.closed = true;
    kind.version = kind.version + 1;
}

// === Buy ===

public fun buy_ticket<C>(
    kind: &mut TicketKind<C>,
    payment: Coin<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Ticket {
    let buyer = ctx.sender();
    buy_for_internal(kind, payment, buyer, clock, ctx)
}

public fun buy_ticket_for<C>(
    kind: &mut TicketKind<C>,
    payment: Coin<C>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
): Ticket {
    buy_for_internal(kind, payment, recipient, clock, ctx)
}

fun buy_for_internal<C>(
    kind: &mut TicketKind<C>,
    payment: Coin<C>,
    recipient: address,
    clock: &Clock,
    ctx: &mut TxContext,
): Ticket {
    assert!(!kind.paused, E_KIND_PAUSED);
    assert!(!kind.closed, E_KIND_CLOSED);
    assert!(kind.sold < kind.supply_cap, E_SOLD_OUT);
    assert!(coin::value(&payment) == kind.price, E_INVALID_PAYMENT_AMOUNT);

    let now = clock::timestamp_ms(clock);
    coin::put(&mut kind.balance, payment);
    kind.sold = kind.sold + 1;
    kind.outstanding = kind.outstanding + 1;

    let ticket = Ticket {
        id: object::new(ctx),
        kind_id: object::id(kind),
        status: STATUS_ISSUED,
        issued_at_ms: now,
        name: kind.name,
        image_url: kind.image_url,
    };

    event::emit(TicketBought {
        ticket_id: object::id(&ticket),
        kind_id: ticket.kind_id,
        buyer: ctx.sender(),
        recipient,
        price: kind.price,
        timestamp_ms: now,
    });

    ticket
}

// === Holder actions ===

public fun use_ticket<C>(
    ticket: Ticket,
    kind: &mut TicketKind<C>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(ticket.kind_id == object::id(kind), E_WRONG_KIND);
    assert!(ticket.status == STATUS_ISSUED, E_NOT_ISSUED);
    let now = clock::timestamp_ms(clock);
    assert!(now >= kind.valid_from_ms, E_BEFORE_VALID_FROM);
    assert!(now <= kind.valid_until_ms, E_AFTER_VALID_UNTIL);

    let ticket_id = object::id(&ticket);
    let kind_id = ticket.kind_id;
    let holder = ctx.sender();

    kind.outstanding = kind.outstanding - 1;
    let burned = !kind.keep_as_souvenir;

    if (kind.keep_as_souvenir) {
        let mut t = ticket;
        t.status = STATUS_USED;
        transfer::transfer(t, holder);
    } else {
        let Ticket { id, kind_id: _, status: _, issued_at_ms: _, name: _, image_url: _ } = ticket;
        object::delete(id);
    };

    event::emit(TicketUsed { ticket_id, kind_id, holder, timestamp_ms: now, burned });
}

public fun refund<C>(
    ticket: Ticket,
    kind: &mut TicketKind<C>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(ticket.kind_id == object::id(kind), E_WRONG_KIND);
    assert!(ticket.status == STATUS_ISSUED, E_NOT_REFUNDABLE);

    let now = clock::timestamp_ms(clock);
    let refund_amount = compute_refund(kind, now);
    assert!(refund_amount > 0, E_REFUND_WINDOW_CLOSED);

    kind.outstanding = kind.outstanding - 1;
    let refund_coin = coin::take(&mut kind.balance, refund_amount, ctx);

    let ticket_id = object::id(&ticket);
    let kind_id = ticket.kind_id;
    let holder = ctx.sender();

    let Ticket { id, kind_id: _, status: _, issued_at_ms: _, name: _, image_url: _ } = ticket;
    object::delete(id);

    event::emit(TicketRefunded { ticket_id, kind_id, holder, refund_amount, timestamp_ms: now });
    refund_coin
}

fun compute_refund<C>(kind: &TicketKind<C>, now: u64): u64 {
    if (kind.refund_policy == REFUND_FULL_BEFORE_VALID_FROM && now < kind.valid_from_ms) {
        kind.price
    } else {
        0
    }
}

// === Creator revenue ===

public fun withdraw_revenue<C>(
    kind: &mut TicketKind<C>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    assert!(kind.creator == ctx.sender(), E_NOT_CREATOR);
    assert!(amount <= balance::value(&kind.balance), E_WITHDRAW_EXCEEDS_BALANCE);
    let out = coin::take(&mut kind.balance, amount, ctx);
    event::emit(RevenueWithdrawn {
        kind_id: object::id(kind),
        creator: kind.creator,
        amount,
    });
    out
}

// === Read accessors ===

public fun kind_creator<C>(k: &TicketKind<C>): address { k.creator }
public fun kind_creator_name<C>(k: &TicketKind<C>): &String { &k.creator_name }
public fun kind_supply_cap<C>(k: &TicketKind<C>): u64 { k.supply_cap }
public fun kind_sold<C>(k: &TicketKind<C>): u64 { k.sold }
public fun kind_outstanding<C>(k: &TicketKind<C>): u64 { k.outstanding }
public fun kind_price<C>(k: &TicketKind<C>): u64 { k.price }
public fun kind_balance<C>(k: &TicketKind<C>): u64 { balance::value(&k.balance) }
public fun kind_paused<C>(k: &TicketKind<C>): bool { k.paused }
public fun kind_closed<C>(k: &TicketKind<C>): bool { k.closed }
public fun kind_keep_as_souvenir<C>(k: &TicketKind<C>): bool { k.keep_as_souvenir }

public fun ticket_status(t: &Ticket): u8 { t.status }
public fun ticket_kind_id(t: &Ticket): ID { t.kind_id }

public fun status_issued(): u8 { STATUS_ISSUED }
public fun status_used(): u8 { STATUS_USED }
public fun refund_policy_none(): u8 { REFUND_NONE }
public fun refund_policy_full_before_valid_from(): u8 { REFUND_FULL_BEFORE_VALID_FROM }

// === Test-only helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(TICKETING {}, ctx);
}

// Errors exposed for tests' #[expected_failure(abort_code = ...)]
#[test_only]
public fun e_sold_out(): u64 { E_SOLD_OUT }
#[test_only]
public fun e_kind_paused(): u64 { E_KIND_PAUSED }
#[test_only]
public fun e_invalid_payment_amount(): u64 { E_INVALID_PAYMENT_AMOUNT }
#[test_only]
public fun e_not_issued(): u64 { E_NOT_ISSUED }
#[test_only]
public fun e_before_valid_from(): u64 { E_BEFORE_VALID_FROM }
#[test_only]
public fun e_after_valid_until(): u64 { E_AFTER_VALID_UNTIL }
#[test_only]
public fun e_refund_window_closed(): u64 { E_REFUND_WINDOW_CLOSED }
#[test_only]
public fun e_not_creator(): u64 { E_NOT_CREATOR }
#[test_only]
public fun e_withdraw_exceeds_balance(): u64 { E_WITHDRAW_EXCEEDS_BALANCE }
#[test_only]
public fun e_invalid_time_window(): u64 { E_INVALID_TIME_WINDOW }
