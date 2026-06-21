/// Protocol-level role-based access control, built on OpenZeppelin's
/// `openzeppelin_access::access_control` (RBAC for Sui). This replaces the
/// single `PlatformCap` (EVM `onlyOwner`) with revocable, role-scoped authority
/// and a timelocked root-admin handoff.
///
/// ### Why a separate module (not `hub`)
///
/// OZ's `AccessControl` registry must be minted from a One-Time Witness in
/// `init` at first publish (OZ Invariant 1: one registry per module, ever), and
/// per OZ Invariant 2 every role type must live in the *same module* as the root
/// role. `hub`'s OTW (`HUB`) is already consumed by `package::claim`, and a
/// module has exactly one OTW — so the registry's root role, and the protocol
/// roles, live here. `GOVERNANCE` is this module's OTW and doubles as the root
/// role; the deployer becomes the default admin at publish.
///
/// Because adopting AccessControl requires an `init` that runs at first publish,
/// this ships as a FRESH publish, not a `sui client upgrade` (see DEPLOYING.md).
///
/// ### Roles (replacing `PlatformCap`)
///
/// - `TreasuryRole`    — withdraw accrued platform fees (`hub::withdraw_platform_balance`).
/// - `ConfigAdminRole` — tune protocol params (`hub::set_fee_bps` / `set_royalty_bps` / `set_refund_period_ms`).
///
/// The root role (default admin) administers both: it can grant/revoke them and
/// hand off (or renounce) the root itself through OZ's timelocked transfer flow
/// (`begin_/accept_default_admin_transfer`, etc., called directly on the OZ
/// module with `<GOVERNANCE>`). Per-event admin stays the `event::OrganizerCap`
/// capability — RBAC is for protocol governance only; the platform stays
/// permissionless (anyone can create events).
///
/// ### Gating pattern
///
/// Mint a PTB-local `Auth<Role>` here, then pass `&Auth<Role>` to the gated
/// `hub` fn. `Auth` is unforgeable: its only constructor is OZ's `new_auth`,
/// which checks live role membership, so the gated fn needs no body checks.
#[allow(lint(share_owned))]
module hostit_ticket::governance;

use openzeppelin_access::access_control::{Self, AccessControl, Auth};

// === Root role (OTW) + protocol roles (same module, per OZ Invariant 2) ===

/// One-Time Witness; doubles as the registry's root role / default-admin role.
public struct GOVERNANCE has drop {}

/// Authority to withdraw accrued platform fees from the `Hub` treasury.
public struct TreasuryRole {}

/// Authority to tune protocol parameters (fee bps, royalty bps, refund period).
public struct ConfigAdminRole {}

// === Constants ===

/// Default timelock (ms) for root-admin transfer / renounce: 1 day. Tunable
/// post-deploy via OZ's delay-change flow (capped at 60 days by the library).
const DEFAULT_ADMIN_DELAY_MS: u64 = 86_400_000;

// === init ===

fun init(otw: GOVERNANCE, ctx: &mut TxContext) {
    // Sender (deployer) becomes the default admin (root role holder).
    let mut registry = access_control::new(otw, DEFAULT_ADMIN_DELAY_MS, ctx);
    // Bootstrap the deployer with both operational roles so the protocol is
    // immediately governable without a second transaction. The root admin can
    // later grant these to other addresses and revoke its own.
    registry.grant_role<_, TreasuryRole>(ctx.sender(), ctx);
    registry.grant_role<_, ConfigAdminRole>(ctx.sender(), ctx);
    transfer::public_share_object(registry);
}

// === Auth minting (PTB-local witnesses for the gated `hub` fns) ===

/// Mint a `TreasuryRole` auth for the caller. Aborts `access_control`
/// `EUnauthorized` (code 0) if the caller does not hold `TreasuryRole`.
public fun treasury_auth(
    registry: &AccessControl<GOVERNANCE>,
    ctx: &mut TxContext,
): Auth<TreasuryRole> {
    access_control::new_auth<GOVERNANCE, TreasuryRole>(registry, ctx)
}

/// Mint a `ConfigAdminRole` auth for the caller. Aborts `EUnauthorized` (code 0)
/// if the caller does not hold `ConfigAdminRole`.
public fun config_auth(
    registry: &AccessControl<GOVERNANCE>,
    ctx: &mut TxContext,
): Auth<ConfigAdminRole> {
    access_control::new_auth<GOVERNANCE, ConfigAdminRole>(registry, ctx)
}

// === Role administration (caller must hold the admin role — root by default) ===

public fun grant_treasury(
    registry: &mut AccessControl<GOVERNANCE>,
    account: address,
    ctx: &mut TxContext,
) {
    access_control::grant_role<GOVERNANCE, TreasuryRole>(registry, account, ctx)
}

public fun revoke_treasury(
    registry: &mut AccessControl<GOVERNANCE>,
    account: address,
    ctx: &mut TxContext,
) {
    access_control::revoke_role<GOVERNANCE, TreasuryRole>(registry, account, ctx)
}

public fun grant_config(
    registry: &mut AccessControl<GOVERNANCE>,
    account: address,
    ctx: &mut TxContext,
) {
    access_control::grant_role<GOVERNANCE, ConfigAdminRole>(registry, account, ctx)
}

public fun revoke_config(
    registry: &mut AccessControl<GOVERNANCE>,
    account: address,
    ctx: &mut TxContext,
) {
    access_control::revoke_role<GOVERNANCE, ConfigAdminRole>(registry, account, ctx)
}

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(GOVERNANCE {}, ctx);
}
