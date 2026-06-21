/// One shared `Event` object per event — the Sui replacement for the EVM's
/// per-event cloned ERC721 contract. Holds the lifecycle parameters, the
/// per-coin-type price/escrow buckets (dynamic fields), per-user mint counts,
/// the revocable check-in signer set, and per-day attendance records.
///
/// Authority: the `OrganizerCap` (returned at creation) is the non-revocable
/// per-event owner (EVM "main admin"). Revocable check-in staff are the
/// `checkin_signers` ed25519 pubkey set (EVM `add/removeTicketAdmins`).
module hostit_ticket::event;

use std::ascii;
use std::string::{Self, String};
use std::type_name;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::dynamic_field as df;
use sui::event;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use hostit_ticket::hub::{Self, Hub};

// === Constants ===

const DAY_MS: u64 = 86_400_000;

/// The all-zero ed25519 point: a degenerate key that verifies *any* message
/// under cofactored verification. Rejected at signer registration.
const ZERO_PUBKEY: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000000";

// === Errors ===

const E_EMPTY_NAME: u64 = 1;
const E_EMPTY_URI: u64 = 2;
const E_START_MUST_BE_AHEAD: u64 = 3;
const E_END_TOO_EARLY: u64 = 4;
const E_PURCHASE_START_TOO_LATE: u64 = 5;
const E_MAX_TICKETS_ZERO: u64 = 6;
const E_MAX_PER_USER_ZERO: u64 = 7;
const E_MAX_LT_SUPPLY: u64 = 8;
const E_WRONG_CAP: u64 = 9;
const E_EVENT_IS_FREE: u64 = 10;
const E_ZERO_PRICE: u64 = 11;
const E_PRICE_NOT_SET: u64 = 12;
const E_ALREADY_CHECKED_IN_DAY: u64 = 13;
const E_INVALID_SIGNER_KEY: u64 = 14;
const E_SIGNER_NOT_FOUND: u64 = 15;

// === Objects ===

public struct Event has key {
    id: UID,
    event_seq: u64,
    organizer: address,
    created_at_ms: u64,
    updated_at_ms: u64,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    max_tickets: u64,
    /// == sold; monotonic serial source. Never decremented (matches EVM
    /// `soldTickets`: refunded slots are not resold).
    minted: u64,
    max_per_user: u64,
    is_free: bool,
    is_refundable: bool,
    allow_self_checkin: bool,
    name: String,
    symbol: String,
    uri: String,
    /// Per-address mint count (caps mints-per-address; the EVM capped live
    /// `balanceOf`, which isn't trackable on Sui post-transfer).
    mint_counts: Table<address, u64>,
    /// ed25519 public keys of authorized check-in staff devices (revocable).
    checkin_signers: VecSet<vector<u8>>,
    /// `DayKey{day, ticket} -> true`; enforces once-per-day check-in per ticket.
    day_attendees: Table<DayKey, bool>,
    /// `address -> true`; "ever checked in" for this event.
    attendees: Table<address, bool>,
    // dynamic fields: PriceKey<T> -> u64, EscrowKey<T> -> Balance<T>
}

/// Per-event owner authority (EVM main admin). Returned by `create_event`.
public struct OrganizerCap has key, store {
    id: UID,
    event_id: ID,
}

public struct DayKey has copy, drop, store {
    day: u64,
    ticket: ID,
}

public struct PriceKey<phantom T> has copy, drop, store {}

public struct EscrowKey<phantom T> has copy, drop, store {}

// === Events ===

public struct EventCreated has copy, drop {
    event_seq: u64,
    event_id: ID,
    organizer: address,
    name: String,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    max_tickets: u64,
    max_per_user: u64,
    is_free: bool,
    is_refundable: bool,
}

public struct EventUpdated has copy, drop {
    event_seq: u64,
    organizer: address,
}

public struct PriceSet has copy, drop {
    event_seq: u64,
    coin_type: ascii::String,
    price: u64,
}

public struct CheckinSignerAdded has copy, drop {
    event_seq: u64,
    pubkey: vector<u8>,
}

public struct CheckinSignerRemoved has copy, drop {
    event_seq: u64,
    pubkey: vector<u8>,
}

// === Create ===

/// Permissionless: anyone can create an event. The caller becomes `organizer`
/// and receives the returned `OrganizerCap`. Validations mirror
/// `LibFactory._createTicket` (seconds → ms).
public fun create_event(
    hub: &mut Hub,
    name: String,
    symbol: String,
    uri: String,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    max_tickets: u64,
    max_per_user: u64,
    is_free: bool,
    is_refundable: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): OrganizerCap {
    let (event, cap) = build_event(
        hub,
        name,
        symbol,
        uri,
        start_ms,
        end_ms,
        purchase_start_ms,
        max_tickets,
        max_per_user,
        is_free,
        is_refundable,
        clock,
        ctx,
    );
    transfer::share_object(event);
    cap
}

/// Atomic paid-event creation (issue #68): build the event, set the `T` price,
/// and share — all in one transaction. A paid event can therefore never end up
/// priced-less (the partial-failure window of separate `create_event` +
/// `set_price` txs, which left an un-buyable "Price not set" event). Inherently
/// paid (`is_free = false`); free events keep using `create_event`.
public fun create_event_with_price<T>(
    hub: &mut Hub,
    name: String,
    symbol: String,
    uri: String,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    max_tickets: u64,
    max_per_user: u64,
    is_refundable: bool,
    price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): OrganizerCap {
    assert!(price > 0, E_ZERO_PRICE);
    let (mut event, cap) = build_event(
        hub,
        name,
        symbol,
        uri,
        start_ms,
        end_ms,
        purchase_start_ms,
        max_tickets,
        max_per_user,
        false, // paid
        is_refundable,
        clock,
        ctx,
    );
    // Price the not-yet-shared event directly — no shared-object PTB constraint
    // (the very reason a client-side create+set_price PTB can't be atomic).
    df::add(&mut event.id, PriceKey<T> {}, price);
    event::emit(PriceSet {
        event_seq: event.event_seq,
        coin_type: type_name::with_defining_ids<T>().into_string(),
        price,
    });
    transfer::share_object(event);
    cap
}

/// Validate inputs, emit `EventCreated`, and build the `Event` + its
/// `OrganizerCap` **without sharing** — the shared core of `create_event` and
/// `create_event_with_price`.
fun build_event(
    hub: &mut Hub,
    name: String,
    symbol: String,
    uri: String,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    max_tickets: u64,
    max_per_user: u64,
    is_free: bool,
    is_refundable: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): (Event, OrganizerCap) {
    assert!(string::length(&name) > 0, E_EMPTY_NAME);
    assert!(string::length(&uri) > 0, E_EMPTY_URI);
    let now = clock::timestamp_ms(clock);
    // Allow same-instant start (start_ms == now): an event can open and be
    // checked into the moment it's created (no minimum lead).
    assert!(start_ms >= now, E_START_MUST_BE_AHEAD);
    // Any positive duration is valid (no minimum-duration floor).
    assert!(end_ms > start_ms, E_END_TOO_EARLY);
    // Purchases may open as late as start_ms (no minimum purchase lead) and
    // must not open after the event ends.
    assert!(purchase_start_ms <= start_ms, E_PURCHASE_START_TOO_LATE);
    assert!(purchase_start_ms <= end_ms, E_PURCHASE_START_TOO_LATE);
    assert!(max_tickets > 0, E_MAX_TICKETS_ZERO);
    assert!(max_per_user > 0, E_MAX_PER_USER_ZERO);

    let organizer = ctx.sender();
    let seq = hub::next_event_seq(hub);

    let uid = object::new(ctx);
    let event_id = object::uid_to_inner(&uid);

    event::emit(EventCreated {
        event_seq: seq,
        event_id,
        organizer,
        name: clone_string(&name),
        start_ms,
        end_ms,
        purchase_start_ms,
        max_tickets,
        max_per_user,
        is_free,
        is_refundable,
    });

    let event = Event {
        id: uid,
        event_seq: seq,
        organizer,
        created_at_ms: now,
        updated_at_ms: now,
        start_ms,
        end_ms,
        purchase_start_ms,
        max_tickets,
        minted: 0,
        max_per_user,
        is_free,
        is_refundable,
        allow_self_checkin: false,
        name,
        symbol,
        uri,
        mint_counts: table::new(ctx),
        checkin_signers: vec_set::empty(),
        day_attendees: table::new(ctx),
        attendees: table::new(ctx),
    };

    (event, OrganizerCap { id: object::new(ctx), event_id })
}

// === Organizer updates (granular setters; compose in a PTB) ===

public fun update_times(
    cap: &OrganizerCap,
    event: &mut Event,
    start_ms: u64,
    end_ms: u64,
    purchase_start_ms: u64,
    clock: &Clock,
) {
    assert_organizer(cap, event);
    let now = clock::timestamp_ms(clock);
    // Same semantics as create_event: allow same-instant start, any positive
    // duration, and purchases opening as late as start_ms but no later than end.
    assert!(start_ms >= now, E_START_MUST_BE_AHEAD);
    assert!(end_ms > start_ms, E_END_TOO_EARLY);
    assert!(purchase_start_ms <= start_ms, E_PURCHASE_START_TOO_LATE);
    assert!(purchase_start_ms <= end_ms, E_PURCHASE_START_TOO_LATE);
    event.start_ms = start_ms;
    event.end_ms = end_ms;
    event.purchase_start_ms = purchase_start_ms;
    event.updated_at_ms = now;
    emit_updated(event);
}

public fun update_max_tickets(cap: &OrganizerCap, event: &mut Event, max_tickets: u64) {
    assert_organizer(cap, event);
    assert!(max_tickets >= event.minted, E_MAX_LT_SUPPLY);
    event.max_tickets = max_tickets;
    emit_updated(event);
}

public fun update_max_per_user(cap: &OrganizerCap, event: &mut Event, max_per_user: u64) {
    assert_organizer(cap, event);
    assert!(max_per_user > 0, E_MAX_PER_USER_ZERO);
    event.max_per_user = max_per_user;
    emit_updated(event);
}

public fun update_metadata(
    cap: &OrganizerCap,
    event: &mut Event,
    name: String,
    symbol: String,
    uri: String,
    clock: &Clock,
) {
    assert_organizer(cap, event);
    assert!(string::length(&name) > 0, E_EMPTY_NAME);
    assert!(string::length(&uri) > 0, E_EMPTY_URI);
    event.name = name;
    event.symbol = symbol;
    event.uri = uri;
    event.updated_at_ms = clock::timestamp_ms(clock);
    emit_updated(event);
}

// === Pricing (per coin type) ===

/// Enable/replace the price for coin type `T` (EVM `setTicketFees`). Paid events
/// only; price must be > 0.
public fun set_price<T>(cap: &OrganizerCap, event: &mut Event, price: u64) {
    assert_organizer(cap, event);
    assert!(!event.is_free, E_EVENT_IS_FREE);
    assert!(price > 0, E_ZERO_PRICE);
    let key = PriceKey<T> {};
    if (df::exists_with_type<PriceKey<T>, u64>(&event.id, key)) {
        *df::borrow_mut<PriceKey<T>, u64>(&mut event.id, key) = price;
    } else {
        df::add(&mut event.id, key, price);
    };
    event::emit(PriceSet {
        event_seq: event.event_seq,
        coin_type: type_name::with_defining_ids<T>().into_string(),
        price,
    });
}

public fun has_price<T>(event: &Event): bool {
    df::exists_with_type<PriceKey<T>, u64>(&event.id, PriceKey<T> {})
}

public(package) fun get_price<T>(event: &Event): u64 {
    let key = PriceKey<T> {};
    assert!(df::exists_with_type<PriceKey<T>, u64>(&event.id, key), E_PRICE_NOT_SET);
    *df::borrow<PriceKey<T>, u64>(&event.id, key)
}

// === Escrow (per coin type) — package-internal, driven by `market` ===

public(package) fun escrow_deposit<T>(event: &mut Event, b: Balance<T>) {
    let key = EscrowKey<T> {};
    if (df::exists_with_type<EscrowKey<T>, Balance<T>>(&event.id, key)) {
        balance::join(df::borrow_mut<EscrowKey<T>, Balance<T>>(&mut event.id, key), b);
    } else {
        df::add(&mut event.id, key, b);
    }
}

public(package) fun escrow_take<T>(event: &mut Event, amount: u64): Balance<T> {
    let key = EscrowKey<T> {};
    balance::split(df::borrow_mut<EscrowKey<T>, Balance<T>>(&mut event.id, key), amount)
}

public fun escrow_value<T>(event: &Event): u64 {
    let key = EscrowKey<T> {};
    if (df::exists_with_type<EscrowKey<T>, Balance<T>>(&event.id, key)) {
        balance::value(df::borrow<EscrowKey<T>, Balance<T>>(&event.id, key))
    } else { 0 }
}

// === Mint accounting — package-internal ===

public(package) fun next_serial(event: &mut Event): u64 {
    event.minted = event.minted + 1;
    event.minted
}

public(package) fun mint_count(event: &Event, who: address): u64 {
    if (table::contains(&event.mint_counts, who)) {
        *table::borrow(&event.mint_counts, who)
    } else { 0 }
}

public(package) fun inc_mint_count(event: &mut Event, who: address) {
    if (table::contains(&event.mint_counts, who)) {
        let c = table::borrow_mut(&mut event.mint_counts, who);
        *c = *c + 1;
    } else {
        table::add(&mut event.mint_counts, who, 1);
    }
}

// === Check-in signer management (OrganizerCap; revocable) ===

public fun add_checkin_signer(cap: &OrganizerCap, event: &mut Event, pubkey: vector<u8>) {
    assert_organizer(cap, event);
    // ed25519 pubkeys are 32 bytes; reject malformed/degenerate keys so a
    // misconfigured staff device can't register a forgeable voucher key.
    assert!(pubkey.length() == 32, E_INVALID_SIGNER_KEY);
    assert!(pubkey != ZERO_PUBKEY, E_INVALID_SIGNER_KEY);
    if (!vec_set::contains(&event.checkin_signers, &pubkey)) {
        vec_set::insert(&mut event.checkin_signers, pubkey);
    };
    event::emit(CheckinSignerAdded { event_seq: event.event_seq, pubkey });
}

public fun remove_checkin_signer(cap: &OrganizerCap, event: &mut Event, pubkey: vector<u8>) {
    assert_organizer(cap, event);
    // Abort on an unregistered key so a typo can't fire a false "key revoked"
    // signal while a compromised key stays live.
    assert!(vec_set::contains(&event.checkin_signers, &pubkey), E_SIGNER_NOT_FOUND);
    vec_set::remove(&mut event.checkin_signers, &pubkey);
    event::emit(CheckinSignerRemoved { event_seq: event.event_seq, pubkey });
}

public fun set_allow_self_checkin(cap: &OrganizerCap, event: &mut Event, allow: bool) {
    assert_organizer(cap, event);
    event.allow_self_checkin = allow;
}

public(package) fun is_checkin_signer(event: &Event, pubkey: &vector<u8>): bool {
    vec_set::contains(&event.checkin_signers, pubkey)
}

// === Check-in records — package-internal, driven by `checkin` ===

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

// === Authority ===

public(package) fun assert_organizer(cap: &OrganizerCap, event: &Event) {
    assert!(cap.event_id == object::id(event), E_WRONG_CAP);
}

public fun cap_event_id(cap: &OrganizerCap): ID { cap.event_id }

// === Reads ===

public fun event_seq(event: &Event): u64 { event.event_seq }
public fun organizer(event: &Event): address { event.organizer }
public fun start_ms(event: &Event): u64 { event.start_ms }
public fun end_ms(event: &Event): u64 { event.end_ms }
public fun purchase_start_ms(event: &Event): u64 { event.purchase_start_ms }
public fun max_tickets(event: &Event): u64 { event.max_tickets }
public fun minted(event: &Event): u64 { event.minted }
public fun max_per_user(event: &Event): u64 { event.max_per_user }
public fun is_free(event: &Event): bool { event.is_free }
public fun is_refundable(event: &Event): bool { event.is_refundable }
public fun allow_self_checkin(event: &Event): bool { event.allow_self_checkin }
public fun name(event: &Event): &String { &event.name }
public fun symbol(event: &Event): &String { &event.symbol }
public fun uri(event: &Event): &String { &event.uri }
/// Owned copies for stamping onto minted tickets.
public(package) fun name_clone(event: &Event): String { clone_string(&event.name) }
public(package) fun uri_clone(event: &Event): String { clone_string(&event.uri) }
public fun is_checked_in(event: &Event, who: address): bool {
    table::contains(&event.attendees, who)
}
public fun is_checked_in_for_day(event: &Event, day: u64, ticket_id: ID): bool {
    table::contains(&event.day_attendees, DayKey { day, ticket: ticket_id })
}
public fun day_ms(): u64 { DAY_MS }

// === Internal helpers ===

fun emit_updated(event: &Event) {
    event::emit(EventUpdated { event_seq: event.event_seq, organizer: event.organizer });
}

fun clone_string(s: &String): String {
    string::utf8(*string::as_bytes(s))
}
