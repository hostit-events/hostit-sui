#[test_only]
module sui_ticket::ticketing_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::test_scenario::{Self as ts};
use sui::transfer;
use sui_ticket::ticketing::{Self, TicketKind, Ticket};

public struct TESTCOIN has drop {}

const DEPLOYER: address = @0xA;
const CREATOR: address = @0xB;
const OTHER: address = @0xE;
const BUYER: address = @0xC;

const PRICE: u64 = 1_000_000;
const SUPPLY: u64 = 10;
const VALID_FROM_MS: u64 = 1_000_000_000;
const VALID_UNTIL_MS: u64 = 2_000_000_000;

// === helpers ===

fun create_kind<C: drop>(
    scenario: &mut ts::Scenario,
    keep_as_souvenir: bool,
    refund_policy: u8,
) {
    ts::next_tx(scenario, CREATOR);
    ticketing::create_ticket_kind<C>(
        string::utf8(b"Acme Tickets"),
        string::utf8(b"GA Pass"),
        string::utf8(b"General admission"),
        string::utf8(b"https://img.example/ga.png"),
        SUPPLY,
        PRICE,
        VALID_FROM_MS,
        VALID_UNTIL_MS,
        refund_policy,
        keep_as_souvenir,
        ts::ctx(scenario),
    );
}

fun buy_one<C: drop>(scenario: &mut ts::Scenario, buyer: address, clock_ms: u64): ID {
    ts::next_tx(scenario, buyer);
    let mut kind = ts::take_shared<TicketKind<C>>(scenario);
    let mut clk = clock::create_for_testing(ts::ctx(scenario));
    clock::set_for_testing(&mut clk, clock_ms);

    let payment = coin::mint_for_testing<C>(PRICE, ts::ctx(scenario));
    let ticket = ticketing::buy_ticket<C>(&mut kind, payment, &clk, ts::ctx(scenario));
    let ticket_id = object::id(&ticket);
    transfer::public_transfer(ticket, buyer);

    clock::destroy_for_testing(clk);
    ts::return_shared(kind);
    ticket_id
}

// === happy paths ===

#[test]
fun test_create_ticket_kind_records_creator() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_none(),
    );

    ts::next_tx(&mut scenario, CREATOR);
    {
        let kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        assert!(ticketing::kind_creator(&kind) == CREATOR, 0);
        assert!(*ticketing::kind_creator_name(&kind) == string::utf8(b"Acme Tickets"), 0);
        assert!(ticketing::kind_supply_cap(&kind) == SUPPLY, 0);
        assert!(ticketing::kind_sold(&kind) == 0, 0);
        assert!(ticketing::kind_price(&kind) == PRICE, 0);
        assert!(ticketing::kind_keep_as_souvenir(&kind), 0);
        ts::return_shared(kind);
    };
    ts::end(scenario);
}

#[test]
fun test_buy_ticket_increments_counters_and_balance() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_full_before_valid_from(),
    );
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, BUYER);
    {
        let kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        assert!(ticketing::kind_sold(&kind) == 1, 0);
        assert!(ticketing::kind_outstanding(&kind) == 1, 0);
        assert!(ticketing::kind_balance(&kind) == PRICE, 0);
        ts::return_shared(kind);

        let ticket = ts::take_from_sender<Ticket>(&scenario);
        assert!(ticketing::ticket_status(&ticket) == ticketing::status_issued(), 0);
        ts::return_to_sender(&scenario, ticket);
    };
    ts::end(scenario);
}

#[test]
fun test_use_ticket_souvenir_flips_status() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_none(),
    );
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, BUYER);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        let ticket = ts::take_from_sender<Ticket>(&scenario);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, VALID_FROM_MS + 1);

        ticketing::use_ticket<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));

        clock::destroy_for_testing(clk);
        ts::return_shared(kind);
    };

    ts::next_tx(&mut scenario, BUYER);
    {
        let ticket = ts::take_from_sender<Ticket>(&scenario);
        assert!(ticketing::ticket_status(&ticket) == ticketing::status_used(), 0);
        ts::return_to_sender(&scenario, ticket);
    };
    ts::end(scenario);
}

#[test]
fun test_use_ticket_consumable_burns() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        false,
        ticketing::refund_policy_none(),
    );
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, BUYER);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        let ticket = ts::take_from_sender<Ticket>(&scenario);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, VALID_FROM_MS + 1);
        ticketing::use_ticket<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clk);
        ts::return_shared(kind);
    };

    ts::next_tx(&mut scenario, BUYER);
    {
        assert!(!ts::has_most_recent_for_sender<Ticket>(&scenario), 0);
        let kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        assert!(ticketing::kind_outstanding(&kind) == 0, 0);
        ts::return_shared(kind);
    };
    ts::end(scenario);
}

#[test]
fun test_refund_full_before_valid_from_returns_payment() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_full_before_valid_from(),
    );
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 100);

    ts::next_tx(&mut scenario, BUYER);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        let ticket = ts::take_from_sender<Ticket>(&scenario);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, VALID_FROM_MS - 10);

        let refunded = ticketing::refund<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));
        assert!(coin::value(&refunded) == PRICE, 0);
        transfer::public_transfer(refunded, BUYER);

        clock::destroy_for_testing(clk);
        ts::return_shared(kind);
    };
    ts::end(scenario);
}

#[test]
fun test_withdraw_revenue_succeeds_for_creator() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_none(),
    );
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, CREATOR);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        let out = ticketing::withdraw_revenue<TESTCOIN>(
            &mut kind, PRICE, ts::ctx(&mut scenario),
        );
        assert!(coin::value(&out) == PRICE, 0);
        transfer::public_transfer(out, CREATOR);
        ts::return_shared(kind);
    };
    ts::end(scenario);
}

#[test]
fun test_pause_and_resume_by_creator() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(
        &mut scenario,
        true,
        ticketing::refund_policy_none(),
    );

    ts::next_tx(&mut scenario, CREATOR);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        ticketing::pause_kind<TESTCOIN>(&mut kind, ts::ctx(&mut scenario));
        assert!(ticketing::kind_paused(&kind), 0);
        ticketing::resume_kind<TESTCOIN>(&mut kind, ts::ctx(&mut scenario));
        assert!(!ticketing::kind_paused(&kind), 0);
        ts::return_shared(kind);
    };
    ts::end(scenario);
}

// === failure paths ===

#[test]
#[expected_failure(abort_code = ticketing::E_INVALID_PAYMENT_AMOUNT)]
fun test_buy_wrong_payment_amount_aborts() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());

    ts::next_tx(&mut scenario, BUYER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, VALID_FROM_MS - 1);
    let bad_payment = coin::mint_for_testing<TESTCOIN>(PRICE - 1, ts::ctx(&mut scenario));
    let ticket = ticketing::buy_ticket<TESTCOIN>(
        &mut kind, bad_payment, &clk, ts::ctx(&mut scenario),
    );
    transfer::public_transfer(ticket, BUYER);
    clock::destroy_for_testing(clk);
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_KIND_PAUSED)]
fun test_buy_when_paused_aborts() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());

    ts::next_tx(&mut scenario, CREATOR);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        ticketing::pause_kind<TESTCOIN>(&mut kind, ts::ctx(&mut scenario));
        ts::return_shared(kind);
    };

    ts::next_tx(&mut scenario, BUYER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, VALID_FROM_MS - 1);
    let payment = coin::mint_for_testing<TESTCOIN>(PRICE, ts::ctx(&mut scenario));
    let ticket = ticketing::buy_ticket<TESTCOIN>(&mut kind, payment, &clk, ts::ctx(&mut scenario));
    transfer::public_transfer(ticket, BUYER);
    clock::destroy_for_testing(clk);
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_BEFORE_VALID_FROM)]
fun test_use_before_valid_from_aborts() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 100);

    ts::next_tx(&mut scenario, BUYER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let ticket = ts::take_from_sender<Ticket>(&scenario);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, VALID_FROM_MS - 1);
    ticketing::use_ticket<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));
    clock::destroy_for_testing(clk);
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_NOT_ISSUED)]
fun test_double_use_souvenir_aborts() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, BUYER);
    {
        let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
        let ticket = ts::take_from_sender<Ticket>(&scenario);
        let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
        clock::set_for_testing(&mut clk, VALID_FROM_MS + 1);
        ticketing::use_ticket<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clk);
        ts::return_shared(kind);
    };

    ts::next_tx(&mut scenario, BUYER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let ticket = ts::take_from_sender<Ticket>(&scenario);
    let mut clk = clock::create_for_testing(ts::ctx(&mut scenario));
    clock::set_for_testing(&mut clk, VALID_FROM_MS + 2);
    ticketing::use_ticket<TESTCOIN>(ticket, &mut kind, &clk, ts::ctx(&mut scenario));
    clock::destroy_for_testing(clk);
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_NOT_CREATOR)]
fun test_non_creator_cannot_pause() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());

    // OTHER (not the creator) tries to pause
    ts::next_tx(&mut scenario, OTHER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    ticketing::pause_kind<TESTCOIN>(&mut kind, ts::ctx(&mut scenario));
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_NOT_CREATOR)]
fun test_non_creator_cannot_withdraw() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());
    let _tid = buy_one<TESTCOIN>(&mut scenario, BUYER, VALID_FROM_MS - 1);

    ts::next_tx(&mut scenario, OTHER);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let out = ticketing::withdraw_revenue<TESTCOIN>(&mut kind, 1, ts::ctx(&mut scenario));
    transfer::public_transfer(out, OTHER);
    ts::return_shared(kind);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ticketing::E_WITHDRAW_EXCEEDS_BALANCE)]
fun test_withdraw_too_much_aborts() {
    let mut scenario = ts::begin(DEPLOYER);
    { ticketing::init_for_testing(ts::ctx(&mut scenario)); };
    create_kind<TESTCOIN>(&mut scenario, true, ticketing::refund_policy_none());

    ts::next_tx(&mut scenario, CREATOR);
    let mut kind = ts::take_shared<TicketKind<TESTCOIN>>(&scenario);
    let out = ticketing::withdraw_revenue<TESTCOIN>(&mut kind, 1, ts::ctx(&mut scenario));
    transfer::public_transfer(out, CREATOR);
    ts::return_shared(kind);
    ts::end(scenario);
}
