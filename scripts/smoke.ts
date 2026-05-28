/**
 * End-to-end smoke test for the sui_ticket::ticketing package on testnet.
 *
 * Flow:
 *   1. Register a fresh issuer (1 tx, returns IssuerCap + shared Issuer)
 *   2. Create a souvenir TicketKind<SUI> (1 tx) — needs IssuerCap + Issuer IDs from step 1
 *   3. Buy a ticket (composed PTB: split gas, buy, transfer)
 *   4. Use the ticket (souvenir kind → status flips to USED, ticket returned to holder)
 *   5. NEGATIVE: try to use the same ticket again — must abort with E_NOT_ISSUED
 *
 * The composability win is most visible in step 3 (split + buy + transfer atomically).
 * Steps 1 and 2 cannot be composed in a single PTB because the Issuer is *shared* by
 * step 1 — shared objects only become addressable in subsequent transactions, not
 * within the same PTB.
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { PACKAGE_ID, SUI_COIN_TYPE, REFUND_POLICY, TICKET_STATUS } from "../sdk/config.ts";
import {
  registerIssuer,
  createTicketKind,
  buyTicket,
  useTicket,
} from "../sdk/ticketing.ts";
import { loadCliKeypair } from "./keypair.ts";

const SENDER = "0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9";
const GAS_BUDGET = 100_000_000n; // 0.1 SUI; smoke tx are small

// --- helpers ---------------------------------------------------------------

const client = new SuiClient({ url: getFullnodeUrl("testnet") });
const kp = loadCliKeypair(SENDER);

function pickCreated(
  effects: any,
  predicate: (objectType: string) => boolean,
): string {
  const changes = effects?.objectChanges ?? [];
  for (const c of changes) {
    if (c.type === "created" && predicate(c.objectType)) return c.objectId;
  }
  throw new Error(`No created object matched. Effects: ${JSON.stringify(effects?.objectChanges)}`);
}

async function exec(tx: Transaction, label: string): Promise<{ digest: string; effects: any }> {
  tx.setSender(SENDER);
  tx.setGasBudget(GAS_BUDGET);
  const built = await tx.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: built });
  if (dry.effects.status.status !== "success") {
    throw new Error(`[${label}] dry-run failed: ${JSON.stringify(dry.effects.status)}`);
  }
  const g = dry.effects.gasUsed;
  console.log(`[${label}] dry-run OK; gas computation=${g.computationCost} storage=${g.storageCost} rebate=${g.storageRebate}`);

  const out = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: out.digest });
  if (out.effects?.status?.status !== "success") {
    throw new Error(`[${label}] execution failed: ${JSON.stringify(out.effects?.status)}`);
  }
  console.log(`[${label}] tx digest: ${out.digest}`);
  return { digest: out.digest, effects: out };
}

async function expectFailure(tx: Transaction, label: string, expectedSubstring: string): Promise<string> {
  tx.setSender(SENDER);
  tx.setGasBudget(GAS_BUDGET);
  const built = await tx.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: built });
  if (dry.effects.status.status === "success") {
    throw new Error(`[${label}] expected failure but dry-run succeeded`);
  }
  const errStr = JSON.stringify(dry.effects.status);
  if (!errStr.includes(expectedSubstring)) {
    throw new Error(`[${label}] failure didn't match. Expected substring '${expectedSubstring}' in: ${errStr}`);
  }
  console.log(`[${label}] dry-run aborted as expected (matched '${expectedSubstring}')`);
  return errStr;
}

// --- flow ------------------------------------------------------------------

async function main() {
  console.log(`Sender: ${kp.toSuiAddress()}`);
  console.log(`Package: ${PACKAGE_ID}`);
  console.log();

  // ── Step 1: register_issuer ────────────────────────────────────────────
  const tx1 = registerIssuer(
    { name: "Acme Smoke Tickets", metadata: new TextEncoder().encode("smoke=true") },
    SENDER,
  );
  const step1 = await exec(tx1, "1/register_issuer");
  const issuerId = pickCreated(step1.effects, (t) => t === `${PACKAGE_ID}::ticketing::Issuer`);
  const issuerCapId = pickCreated(step1.effects, (t) => t === `${PACKAGE_ID}::ticketing::IssuerCap`);
  console.log(`   Issuer:    ${issuerId}`);
  console.log(`   IssuerCap: ${issuerCapId}`);
  console.log();

  // ── Step 2: create_ticket_kind<SUI> ────────────────────────────────────
  // Use a wide validity window so the smoke can use the ticket immediately.
  const now = Date.now();
  const tx2 = createTicketKind({
    issuerCapId,
    issuerId,
    config: {
      name: "GA Pass — smoke",
      description: "Smoke test ticket; safe to ignore.",
      imageUrl: "https://placehold.co/600x400/png?text=Smoke+Ticket",
      supplyCap: 10n,
      priceMist: 1_000_000n, // 0.001 SUI
      validFromMs: BigInt(now - 60_000), // 1 min ago
      validUntilMs: BigInt(now + 24 * 3_600_000), // +24h
      refundPolicy: REFUND_POLICY.FULL_BEFORE_VALID_FROM,
      keepAsSouvenir: true, // we want to see the status flip
      currencyType: SUI_COIN_TYPE,
    },
  });
  const step2 = await exec(tx2, "2/create_ticket_kind");
  const kindId = pickCreated(step2.effects, (t) =>
    t.startsWith(`${PACKAGE_ID}::ticketing::TicketKind<`),
  );
  console.log(`   TicketKind: ${kindId}`);
  console.log();

  // ── Step 3: buy_ticket (composed PTB: split + buy + transfer) ──────────
  const tx3 = buyTicket(
    { kindId, currencyType: SUI_COIN_TYPE, priceMist: 1_000_000n },
    SENDER,
  );
  const step3 = await exec(tx3, "3/buy_ticket (composed)");
  const ticketId = pickCreated(step3.effects, (t) => t === `${PACKAGE_ID}::ticketing::Ticket`);
  console.log(`   Ticket: ${ticketId}`);
  console.log();

  // ── Step 4: use_ticket (souvenir → flip to USED, returned to holder) ──
  const tx4 = useTicket({ ticketId, kindId, currencyType: SUI_COIN_TYPE });
  const step4 = await exec(tx4, "4/use_ticket");

  // Verify on chain that the ticket came back with status=USED.
  const ticketAfter = await client.getObject({
    id: ticketId,
    options: { showContent: true },
  });
  const content = ticketAfter.data?.content as any;
  const status = content?.fields?.status;
  if (Number(status) !== TICKET_STATUS.USED) {
    throw new Error(`Ticket status should be USED (${TICKET_STATUS.USED}) but is ${status}`);
  }
  console.log(`   Ticket status after use: USED (${status}) ✓`);
  console.log();

  // ── Step 5 (NEGATIVE): use the same ticket again → must abort ─────────
  const tx5 = useTicket({ ticketId, kindId, currencyType: SUI_COIN_TYPE });
  await expectFailure(tx5, "5/double-use (NEGATIVE)", "MoveAbort");
  console.log();

  console.log("=== ALL STEPS PASSED ===");
  console.log("Summary:");
  console.log(`  register_issuer:      ${step1.digest}`);
  console.log(`  create_ticket_kind:   ${step2.digest}`);
  console.log(`  buy_ticket (composed): ${step3.digest}`);
  console.log(`  use_ticket:           ${step4.digest}`);
  console.log(`  Issuer:     ${issuerId}`);
  console.log(`  IssuerCap:  ${issuerCapId}`);
  console.log(`  TicketKind: ${kindId}`);
  console.log(`  Ticket:     ${ticketId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
