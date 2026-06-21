// PTB constructors for protocol governance (OpenZeppelin access_control RBAC,
// GH#51) — mirrors lib/ticketing.ts / lib/predict.ts.
//
// Replaces the single PlatformCap with role-scoped, revocable authority:
//   - TreasuryRole    → withdraw accrued platform fees (hub::withdraw_platform_balance)
//   - ConfigAdminRole → tune protocol params (hub::set_fee_bps / set_royalty_bps / set_refund_period_ms)
// plus a timelocked root-admin handoff (OZ begin/accept transfer).
//
// Gating uses a PTB-local Auth witness: mint `Auth<Role>` via our `governance`
// wrappers, then pass it to the gated `hub` fn in the same transaction.
//
// These are PROTOCOL-OWNER actions — intentionally NOT on the Enoki sponsor
// allowlist (the admin pays their own gas). They require GOVERNANCE_REGISTRY_ID
// to be set, which only happens after the GH#51 fresh publish lands (see
// DEPLOYING.md); until then `registry()` throws fast (an empty id would
// otherwise normalize to 0x0 and fail later with an opaque on-chain error).

import { Transaction } from "@mysten/sui/transactions";
import {
  CLOCK_ID,
  GOVERNANCE_REGISTRY_ID,
  GOVERNANCE_TYPE,
  HUB_ID,
  ozAccessTarget,
  target,
} from "./config";

/** The shared AccessControl registry id, or throw if it hasn't been deployed/set. */
function registry(): string {
  if (!GOVERNANCE_REGISTRY_ID)
    throw new Error(
      "GOVERNANCE_REGISTRY_ID is not set — set NEXT_PUBLIC_HOSTIT_GOVERNANCE_ID after the GH#51 fresh publish.",
    );
  return GOVERNANCE_REGISTRY_ID;
}

// === Role administration (caller must hold the admin role — root by default) ===

function roleTx(fn: "grant_treasury" | "revoke_treasury" | "grant_config" | "revoke_config", account: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("governance", fn),
    arguments: [tx.object(registry()), tx.pure.address(account)],
  });
  return tx;
}

export const grantTreasuryTx = (account: string) => roleTx("grant_treasury", account);
export const revokeTreasuryTx = (account: string) => roleTx("revoke_treasury", account);
export const grantConfigTx = (account: string) => roleTx("grant_config", account);
export const revokeConfigTx = (account: string) => roleTx("revoke_config", account);

// === Param tuning (ConfigAdminRole) ===

function configParamTx(
  fn: "set_fee_bps" | "set_royalty_bps" | "set_refund_period_ms",
  value: bigint | number,
): Transaction {
  const tx = new Transaction();
  const auth = tx.moveCall({
    target: target("governance", "config_auth"),
    arguments: [tx.object(registry())],
  });
  tx.moveCall({
    target: target("hub", fn),
    arguments: [tx.object(HUB_ID), auth, tx.pure.u64(value)],
  });
  return tx;
}

export const setFeeBpsTx = (bps: bigint | number) => configParamTx("set_fee_bps", bps);
export const setRoyaltyBpsTx = (bps: bigint | number) => configParamTx("set_royalty_bps", bps);
export const setRefundPeriodMsTx = (ms: bigint | number) => configParamTx("set_refund_period_ms", ms);

// === Treasury withdrawal (TreasuryRole) ===

/** Withdraw `amount` of platform fees in coin type `coinType` to `to`. */
export function withdrawPlatformBalanceTx(args: {
  coinType: string;
  amount: bigint | number;
  to: string;
}): Transaction {
  const tx = new Transaction();
  const auth = tx.moveCall({
    target: target("governance", "treasury_auth"),
    arguments: [tx.object(registry())],
  });
  const coin = tx.moveCall({
    target: target("hub", "withdraw_platform_balance"),
    typeArguments: [args.coinType],
    arguments: [tx.object(HUB_ID), auth, tx.pure.u64(args.amount), tx.pure.address(args.to)],
  });
  tx.transferObjects([coin], args.to);
  return tx;
}

// === Timelocked root-admin handoff (OZ access_control, type arg GOVERNANCE) ===

/** Schedule transfer of the root admin role to `newAdmin` (timelock starts). */
export function beginAdminTransferTx(newAdmin: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: ozAccessTarget("begin_default_admin_transfer"),
    typeArguments: [GOVERNANCE_TYPE],
    arguments: [tx.object(registry()), tx.pure.address(newAdmin), tx.object(CLOCK_ID)],
  });
  return tx;
}

/** Accept a pending root-admin transfer (must be past the timelock). */
export function acceptAdminTransferTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: ozAccessTarget("accept_default_admin_transfer"),
    typeArguments: [GOVERNANCE_TYPE],
    arguments: [tx.object(registry()), tx.object(CLOCK_ID)],
  });
  return tx;
}
