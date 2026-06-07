// Server-only route. Holds the private Enoki API key.
// Receives a transaction-kind from the client, asks Enoki to sponsor, returns
// the sponsor-signed bytes + digest. The client signs the bytes locally and
// sends them to /api/sponsor/execute.

import { EnokiClient } from "@mysten/enoki";
import { NETWORK, PACKAGE_ID, PACKAGE_ID_LATEST } from "@/lib/config";

const ALLOWED_MOVE_CALL_TARGETS = [
  // hostit_ticket v3 entry points (onboarding + holder actions)
  `${PACKAGE_ID}::event::create_event`,
  `${PACKAGE_ID}::event::set_price`,
  // organizer admin actions (gas-sponsored so hosts never need SUI)
  `${PACKAGE_ID}::event::set_allow_self_checkin`,
  `${PACKAGE_ID}::event::add_checkin_signer`,
  `${PACKAGE_ID}::market::withdraw_event_balance`,
  `${PACKAGE_ID}::market::buy`,
  `${PACKAGE_ID}::market::buy_with_sui`,
  `${PACKAGE_ID}::market::claim_free`,
  `${PACKAGE_ID}::market::refund`,
  `${PACKAGE_ID}::checkin::self_check_in`,
  `${PACKAGE_ID}::checkin::check_in`,
  // prediction markets (parimutuel sellout bets, settled on-chain via event::minted)
  // NOTE: sponsoring speculative bets is a production money-decision to revisit.
  `${PACKAGE_ID_LATEST}::predict::create_sellout_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_yes`,
  `${PACKAGE_ID_LATEST}::predict::bet_no`,
  `${PACKAGE_ID_LATEST}::predict::settle`,
  `${PACKAGE_ID_LATEST}::predict::claim`,
  // range markets (parimutuel bucket bets over final minted count)
  `${PACKAGE_ID_LATEST}::predict::create_range_market`,
  `${PACKAGE_ID_LATEST}::predict::bet_bucket`,
  `${PACKAGE_ID_LATEST}::predict::settle_range`,
  `${PACKAGE_ID_LATEST}::predict::claim_range`,
  // 0x2 framework calls that the SDK's `coinWithBalance` intent may emit
  // during tx.build() when resolving payment coins.
  "0x2::coin::zero",
  "0x2::coin::redeem_funds",
  "0x2::coin::into_balance",
  "0x2::coin::send_funds",
  "0x2::coin::destroy_zero",
  "0x2::balance::zero",
  "0x2::balance::redeem_funds",
];

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const apiKey = process.env.ENOKI_PRIVATE_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error:
          "Server is missing ENOKI_PRIVATE_API_KEY. Add it to web/.env.local (do not prefix with NEXT_PUBLIC_).",
      },
      { status: 500 },
    );
  }

  let body: { transactionKindBytes?: string; sender?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { transactionKindBytes, sender } = body;
  if (!transactionKindBytes || !sender) {
    return Response.json(
      { error: "Missing transactionKindBytes or sender" },
      { status: 400 },
    );
  }

  const enokiNetwork = NETWORK === "localnet" ? "testnet" : NETWORK;
  const enoki = new EnokiClient({ apiKey });

  try {
    const sponsored = await enoki.createSponsoredTransaction({
      network: enokiNetwork,
      transactionKindBytes,
      sender,
      allowedMoveCallTargets: ALLOWED_MOVE_CALL_TARGETS,
    });
    return Response.json(sponsored);
  } catch (err: unknown) {
    const e = err as { message?: string; status?: number; errors?: unknown };
    return Response.json(
      {
        error: e.message ?? "Enoki createSponsoredTransaction failed",
        details: e.errors,
      },
      { status: e.status ?? 500 },
    );
  }
}
