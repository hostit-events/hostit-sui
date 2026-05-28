// Generated/maintained from .suiperpower/deploy-context.md
// Update these after each fresh testnet/mainnet deploy.

export const NETWORK = "testnet" as const;

export const PACKAGE_ID =
  "0xd1a0b7f45b355a6543d514e7e893e29b3b15df467bac90e8678de8fb82c960cb";

export const TRANSFER_POLICY_ID =
  "0x031b9e4f1e81aeb582e62fc624984dce98c3c20416d24fbacfd22dfa2259d5ab";

export const TRANSFER_POLICY_CAP_ID =
  "0xa45e2066b073f4935fa0c641cb7f9cc8e823559db7a1651fa2976470faf0d90b";

export const PUBLISHER_ID =
  "0xe0ca80b961108afbba747c1aaaf4abf12d7fe969b08faba5c835b0666ac13861";

export const DISPLAY_ID =
  "0xd962098c2c1a1af80e2e6765619c401508f2b1dc7cfacc525b3ff31f4ebced68";

// Well-known Sui shared Clock
export const CLOCK_ID = "0x6";

// Module and target helpers
export const MODULE = "ticketing";
export const target = (fn: string) => `${PACKAGE_ID}::${MODULE}::${fn}` as const;

// Currency phantom types (`C` in TicketKind<C>)
export const SUI_COIN_TYPE = "0x2::sui::SUI";

// Refund policy opcodes (mirror Move constants)
export const REFUND_POLICY = {
  NONE: 0,
  FULL_BEFORE_VALID_FROM: 1,
} as const;

// Ticket status opcodes (mirror Move constants)
export const TICKET_STATUS = {
  ISSUED: 0,
  USED: 1,
} as const;
