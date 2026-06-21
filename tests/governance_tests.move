#[test_only]
module hostit_ticket::governance_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::clock;
use hostit_ticket::governance::{Self, GOVERNANCE, TreasuryRole, ConfigAdminRole};
use openzeppelin_access::access_control::{Self, AccessControl};

const ADMIN: address = @0xA1; // deployer / default admin
const USER: address = @0xB0B;
const USER2: address = @0xC0C;

/// Deploy the registry as ADMIN and advance to a fresh tx so `take_shared` works.
fun begin(): Scenario {
    let mut sc = ts::begin(ADMIN);
    governance::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    sc
}

// === init / bootstrap ===

#[test]
fun init_bootstraps_default_admin_and_roles() {
    let mut sc = begin();
    let registry = sc.take_shared<AccessControl<GOVERNANCE>>();
    // Deployer is the root/default admin and holds both operational roles.
    assert!(registry.default_admin() == option::some(ADMIN), 0);
    assert!(access_control::has_role<GOVERNANCE, TreasuryRole>(&registry, ADMIN), 1);
    assert!(access_control::has_role<GOVERNANCE, ConfigAdminRole>(&registry, ADMIN), 2);
    // A random address holds nothing.
    assert!(!access_control::has_role<GOVERNANCE, TreasuryRole>(&registry, USER), 3);
    ts::return_shared(registry);
    sc.end();
}

// === grant / revoke + auth gating ===

#[test]
fun grant_enables_auth_then_revoke_disables() {
    let mut sc = begin();
    // ADMIN (root) grants TreasuryRole to USER.
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        governance::grant_treasury(&mut registry, USER, sc.ctx());
        assert!(access_control::has_role<GOVERNANCE, TreasuryRole>(&registry, USER), 0);
        ts::return_shared(registry);
    };
    // USER can now mint a TreasuryRole auth bound to itself.
    sc.next_tx(USER);
    {
        let registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        let auth = governance::treasury_auth(&registry, sc.ctx());
        assert!(access_control::auth_addr(&auth) == USER, 1);
        ts::return_shared(registry); // `auth` (has drop) is discarded here
    };
    // ADMIN revokes; USER no longer holds the role.
    sc.next_tx(ADMIN);
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        governance::revoke_treasury(&mut registry, USER, sc.ctx());
        assert!(!access_control::has_role<GOVERNANCE, TreasuryRole>(&registry, USER), 2);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test, expected_failure(abort_code = openzeppelin_access::access_control::EUnauthorized)]
fun non_holder_cannot_mint_treasury_auth() {
    let mut sc = begin();
    sc.next_tx(USER);
    let registry = sc.take_shared<AccessControl<GOVERNANCE>>();
    let auth = governance::treasury_auth(&registry, sc.ctx()); // aborts
    // Unreachable; present only to satisfy the type checker on the bindings.
    let _ = access_control::auth_addr(&auth);
    ts::return_shared(registry);
    sc.end();
}

#[test, expected_failure(abort_code = openzeppelin_access::access_control::EUnauthorized)]
fun non_admin_cannot_grant_treasury() {
    let mut sc = begin();
    sc.next_tx(USER);
    let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
    governance::grant_treasury(&mut registry, USER2, sc.ctx()); // aborts
    ts::return_shared(registry);
    sc.end();
}

// === role-admin delegation (set_role_admin) ===

#[test]
fun set_role_admin_delegates_grant_authority() {
    let mut sc = begin();
    // Root grants ConfigAdminRole to USER and makes ConfigAdminRole the admin of
    // TreasuryRole, so a ConfigAdminRole holder can administer TreasuryRole.
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        governance::grant_config(&mut registry, USER, sc.ctx());
        access_control::set_role_admin<GOVERNANCE, TreasuryRole, ConfigAdminRole>(
            &mut registry,
            sc.ctx(),
        );
        ts::return_shared(registry);
    };
    // USER (not root, but holds ConfigAdminRole = admin of TreasuryRole) can grant.
    sc.next_tx(USER);
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        governance::grant_treasury(&mut registry, USER2, sc.ctx());
        assert!(access_control::has_role<GOVERNANCE, TreasuryRole>(&registry, USER2), 0);
        ts::return_shared(registry);
    };
    sc.end();
}

// === timelocked root-admin handoff ===

#[test]
fun timelocked_root_transfer_succeeds_after_delay() {
    let mut sc = begin();
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(0);
    // ADMIN schedules a transfer of the root role to USER.
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        access_control::begin_default_admin_transfer<GOVERNANCE>(
            &mut registry,
            USER,
            &clk,
            sc.ctx(),
        );
        assert!(registry.has_pending_default_admin_transfer(), 0);
        ts::return_shared(registry);
    };
    // After the delay elapses (default 1 day; advance well past it), USER accepts.
    sc.next_tx(USER);
    clk.set_for_testing(7 * 86_400_000);
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        access_control::accept_default_admin_transfer<GOVERNANCE>(&mut registry, &clk, sc.ctx());
        assert!(registry.default_admin() == option::some(USER), 1);
        assert!(!registry.has_pending_default_admin_transfer(), 2);
        ts::return_shared(registry);
    };
    clk.destroy_for_testing();
    sc.end();
}

#[test, expected_failure(abort_code = openzeppelin_access::access_control::EDelayNotElapsed)]
fun accept_root_transfer_before_delay_aborts() {
    let mut sc = begin();
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(0);
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        access_control::begin_default_admin_transfer<GOVERNANCE>(
            &mut registry,
            USER,
            &clk,
            sc.ctx(),
        );
        ts::return_shared(registry);
    };
    sc.next_tx(USER);
    // Same timestamp — delay has NOT elapsed.
    {
        let mut registry = sc.take_shared<AccessControl<GOVERNANCE>>();
        access_control::accept_default_admin_transfer<GOVERNANCE>(&mut registry, &clk, sc.ctx());
        ts::return_shared(registry);
    };
    clk.destroy_for_testing();
    sc.end();
}
