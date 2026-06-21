// Turn a raw MoveAbort / Enoki dry-run error into a human message.
// Aborts look like: MoveAbort(MoveLocation { module: ModuleId { ... name:
// Identifier("checkin") }, function: 1, ... }, 8) in command 0

const MAP: Record<string, Record<number, string>> = {
  checkin: {
    1: "This ticket isn't for this event.",
    2: "This ticket was refunded and can't be checked in.",
    3: "Check-in isn't open yet — the event hasn't started.",
    4: "The event has ended — check-in is closed.",
    5: "The check-in voucher has expired.",
    6: "That staff key isn't an authorized check-in signer.",
    7: "Invalid check-in voucher signature.",
    8: "Self check-in isn't enabled for this event — the organizer turns it on under Manage → Self check-in.",
    9: "Organizer check-in isn't enabled for this event.",
  },
  market: {
    1: "This is a free event — use Claim, not Buy.",
    2: "This event isn't free.",
    3: "Sales aren't open right now (outside the purchase window).",
    4: "Sold out.",
    5: "You've reached the per-wallet ticket limit for this event.",
    6: "No price is set for this coin yet.",
    7: "Insufficient payment.",
    8: "This event isn't refundable.",
    9: "This ticket isn't for this event.",
    10: "This ticket can't be refunded (already used or refunded).",
    11: "Wrong coin type for this ticket's refund.",
    12: "Refunds aren't open yet — the event hasn't ended.",
    13: "The refund window has closed.",
    14: "Revenue can't be withdrawn until the refund window closes.",
    15: "No balance to withdraw.",
    16: "This ticket price is too high to process (would overflow). Set a lower price.",
    17: "This event is cancelled — sales and withdrawals are closed.",
  },
  event: {
    1: "Name is required.",
    2: "Image/URI is required.",
    3: "Start must be in the future.",
    4: "End must be at least a day after start.",
    5: "Sales must open at least a day before start.",
    6: "Max tickets must be greater than zero.",
    7: "Max per attendee must be greater than zero.",
    8: "New max can't be below tickets already sold.",
    9: "You don't hold the organizer cap for this event.",
    10: "This event is free — there's no price to set.",
    11: "Price must be greater than zero.",
    12: "No price set for this coin.",
    13: "This ticket is already checked in for today.",
    14: "Invalid signer key — must be a 32-byte ed25519 public key.",
    15: "That key isn't a registered check-in signer — nothing to remove.",
    16: "Tickets have already been sold — this can't be changed now.",
    17: "This coin still holds escrow — withdraw it before removing the price.",
  },
  poap: {
    1: "This ticket isn't for this event.",
    2: "You can only claim a POAP after checking in.",
    3: "You've already claimed this POAP.",
    4: "POAP claiming is turned off for this event.",
  },
  forum: {
    1: "This ticket isn't for this event.",
    2: "Unknown moderation action.",
  },
  reviews: {
    1: "This POAP isn't for this event — you can only review events you attended.",
    2: "Rating must be between 1 and 5 stars.",
    3: "You've already reviewed this event.",
  },
  identity: {
    1: "That email is already linked to another account.",
    2: "You don't own this email or share grant.",
  },
  hub: { 1: "Insufficient balance.", 2: "No balance to withdraw.", 3: "Value too high." },
  predict: {
    1: "This market is already settled.",
    2: "Betting is still open — you can't settle until the deadline (doors) passes.",
    3: "This market is still open — betting hasn't closed yet.",
    4: "This event doesn't match the market's event.",
    5: "This market isn't settled yet — nothing to claim.",
    6: "You have no winning stake to claim here.",
    7: "Bucket cutoffs must be non-empty and strictly increasing.",
    8: "That bucket doesn't exist for this market.",
    9: "Your bet amount must be greater than zero.",
  },
  policy_rules: {
    1: "This ticket doesn't match the one being sold.",
    2: "This ticket has already been used (checked in) and can't be resold.",
    3: "Royalty rate is too high (must be 100% or less).",
    4: "Not enough to cover the resale royalty fee.",
    5: "The ticket must be locked into a kiosk to complete this sale.",
    6: "The ticket resale policy is already set up — its rules can't be re-attached.",
  },
  // OpenZeppelin access_control (RBAC) — protocol governance roles (GH#51).
  access_control: {
    0: "You don't hold the required protocol role for this action.",
    1: "The root admin role can only change via the timelocked transfer/renounce flow.",
    2: "There's no pending admin transfer or renounce.",
    3: "You're not the pending admin for this transfer.",
    4: "The admin-handoff timelock hasn't elapsed yet.",
    5: "Admin delay exceeds the maximum (60 days).",
    6: "Root role must be a one-time witness (internal — should not occur).",
    7: "That role isn't a protocol role (foreign role rejected).",
    8: "The pending action is a renounce, not a transfer.",
    9: "The pending action is a transfer, not a renounce.",
    10: "There's no pending admin-delay change.",
    11: "Can't use the zero address as a role holder or transfer target.",
    12: "Can't transfer the admin role to the current admin.",
  },
};

export function humanizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const modM = raw.match(/Identifier\(\\?"(\w+)\\?"\)/);
  const codeM = raw.match(/\}\s*,\s*(\d+)\)/);
  if (modM && codeM) {
    let code = Number(codeM[1]);
    // Move 2024 `#[error]` "clever errors" (e.g. OpenZeppelin `access_control`,
    // used by `governance`) don't abort with the bare code N — they abort with a
    // packed u64: bit 63 set, with N in bits 48..55. Decode it so the per-module
    // maps below still match. (Our own modules use plain `const E: u64` and are
    // unaffected — their codes are small.) TODO(#51): confirm the exact surfaced
    // shape with a real testnet dry-run once the governance registry is deployed.
    if (codeM[1].length >= 16) {
      try {
        const packed = BigInt(codeM[1]);
        if (packed >> 63n === 1n) code = Number((packed >> 48n) & 0xffn);
      } catch {
        /* not a parseable bigint — keep the raw numeric code */
      }
    }
    const msg = MAP[modM[1]]?.[code];
    if (msg) return msg;
    return `Transaction rejected on-chain (${modM[1]} code ${code}).`;
  }
  if (/rejected|userreject|cancelled|denied the/i.test(raw)) return "You cancelled the transaction.";
  if (/no valid gas coins/i.test(raw))
    return "Your wallet has no SUI to pay for gas on this action. Add testnet SUI from a faucet and try again.";
  // Payment-coin shortfall (incl. the SDK's "Insufficient balance of <type>" from
  // coinWithBalance) — NOT a gas problem. Coin-agnostic so it's correct for SUI
  // and USDC alike. Checked before the gas case so it isn't mislabeled as gas.
  if (/insufficient balance of|no valid coins|coinwithbalance|insufficient.*coin/i.test(raw))
    return "You don’t have enough of the selected coin to cover the price + 3% fee — add more of that coin and try again.";
  if (/insufficient.*gas|gasbalance/i.test(raw)) return "Not enough SUI for gas.";
  if (/\/api\/sponsor|dry_run_failed|enoki/i.test(raw))
    return "Couldn’t sponsor this transaction — please retry.";
  return raw.length > 220 ? raw.slice(0, 220) + "…" : raw;
}
