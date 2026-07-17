/**
 * Event-creation smoke — seeds testnet with a VARIED set of real events.
 *
 *   bun run smoke:events            # from web/  — create the full set
 *   bun run smoke:events 3          # create only the first 3 specs
 *
 * Self-paid (NOT sponsored): signs directly with the Sui CLI active keypair, so
 * it needs no Enoki key — just a funded testnet address. Reuses the EXACT
 * frontend tx builders (lib/ticketing) + metadata path (lib/metadata → Walrus),
 * so every event renders in Discover/event pages just like an app-created one.
 *
 * Pre-conditions:
 *   - `sui client active-address` is funded on testnet (the keystore key signs).
 *   - web/.env.local present (NEXT_PUBLIC_* ids); falls back to lib/config defaults.
 *
 * Varies across: category (all 7), free vs paid, SUI vs USDC pricing, refundable,
 * capacity, max-per-user, POAP/web3 flags, and DURATION (~1–2 days) with staggered
 * start leads (2h … 2 days).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Keypair } from "@mysten/sui/cryptography";
import { createEventTx, createEventWithPriceTx } from "../lib/ticketing";
import { putEventMetadata, type EventMetadata } from "../lib/metadata";
import { SUI_COIN_TYPE, USDC_COIN_TYPE, rpcUrl } from "../lib/config";

const SENDER =
  process.env.SMOKE_SENDER ??
  "0xc8567c14cbca1f54db22c4ba36e2e031bc782e29428ab08312e3fe3408d6c2d9";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SUI = (n: number) => BigInt(Math.round(n * 1e9)); // → MIST
const USDC = (n: number) => BigInt(Math.round(n * 1e6)); // 6 decimals

interface Spec {
  name: string;
  symbol: string;
  category: string; // music | web3 | tech | sports | arts | food | community
  tag: string;
  venue: string;
  city: string;
  description: string;
  leadMs: number; // start = now + leadMs
  durationMs: number; // end = start + durationMs  (≈ a day or two)
  maxTickets: number;
  maxPerUser: number;
  refundable: boolean;
  poap?: boolean;
  web3?: boolean;
  /** null = free; otherwise a priced event in SUI or USDC. */
  price: null | { coin: "SUI" | "USDC"; units: bigint };
}

const SPECS: Spec[] = [
  {
    name: "Sui Beats Festival", symbol: "SUIBEATS", category: "music", tag: "Festival",
    venue: "Lekki Conservation Centre", city: "Lagos",
    description: "Two days of live sets, DJs and food trucks. Mint your pass, check in at the gate, claim a POAP on the way out.",
    leadMs: 2 * HOUR, durationMs: 2 * DAY, maxTickets: 1000, maxPerUser: 4, refundable: true, poap: true, price: null,
  },
  {
    name: "Move Builders Summit", symbol: "MOVESUM", category: "web3", tag: "Conference",
    venue: "Eko Convention Centre", city: "Lagos",
    description: "The flagship Sui/Move builder gathering — talks, workshops and a partner expo across two days.",
    leadMs: 1 * DAY, durationMs: 2 * DAY, maxTickets: 300, maxPerUser: 2, refundable: false, web3: true,
    price: { coin: "SUI", units: SUI(10) },
  },
  {
    name: "zkLogin Workshop", symbol: "ZKWORK", category: "tech", tag: "Workshop",
    venue: "Workstation", city: "Yaba",
    description: "Hands-on, one-day deep dive into gasless onboarding with zkLogin and sponsored transactions.",
    leadMs: 6 * HOUR, durationMs: 1 * DAY, maxTickets: 80, maxPerUser: 1, refundable: true, web3: true,
    price: { coin: "USDC", units: USDC(15) },
  },
  {
    name: "Testnet Derby 5-a-side", symbol: "DERBY", category: "sports", tag: "Tournament",
    venue: "Teslim Balogun Stadium", city: "Lagos",
    description: "Community 5-a-side knockout. Free entry, bring your squad — up to five passes per wallet.",
    leadMs: 1 * DAY, durationMs: 1 * DAY, maxTickets: 120, maxPerUser: 5, refundable: false, price: null,
  },
  {
    name: "Generative Canvas", symbol: "GENCANV", category: "arts", tag: "Exhibition",
    venue: "Rele Gallery", city: "Lagos",
    description: "A day-and-a-half on-chain generative art exhibition with live mints and artist talks.",
    leadMs: 3 * HOUR, durationMs: Math.round(1.5 * DAY), maxTickets: 150, maxPerUser: 2, refundable: true,
    price: { coin: "SUI", units: SUI(3) },
  },
  {
    name: "Jollof & Jollof", symbol: "JOLLOF", category: "food", tag: "Festival",
    venue: "Muri Okunola Park", city: "Lagos",
    description: "The friendly jollof cook-off weekend. Free to attend, claim a commemorative POAP.",
    leadMs: 1 * DAY, durationMs: 2 * DAY, maxTickets: 600, maxPerUser: 4, refundable: false, poap: true, price: null,
  },
  {
    name: "DevRel Coffee Meetup", symbol: "DEVREL", category: "community", tag: "Meetup",
    venue: "Cafe Neo", city: "Victoria Island",
    description: "An intimate one-day developer-relations meetup. Small room, good coffee, refundable up to start.",
    leadMs: 12 * HOUR, durationMs: 1 * DAY, maxTickets: 60, maxPerUser: 2, refundable: true,
    price: { coin: "USDC", units: USDC(5) },
  },
  {
    name: "HostIt Mainnet Concert", symbol: "CONCERT", category: "music", tag: "Concert",
    venue: "Hard Rock Cafe", city: "Lagos",
    description: "A one-night headline concert to mark mainnet. Premium pass, up to six per wallet, non-refundable.",
    leadMs: 2 * DAY, durationMs: 1 * DAY, maxTickets: 800, maxPerUser: 6, refundable: false,
    price: { coin: "SUI", units: SUI(25) },
  },
  {
    name: "Sui Overflow Hackathon", symbol: "OVRFLOW", category: "tech", tag: "Hackathon",
    venue: "Zone Tech Park", city: "Gbagada",
    description: "48-hour build sprint. Free entry, one pass per builder, POAP for everyone who ships.",
    leadMs: 6 * HOUR, durationMs: 2 * DAY, maxTickets: 500, maxPerUser: 1, refundable: true, web3: true, poap: true, price: null,
  },
  {
    name: "Print & Pixel Fair", symbol: "PRNTPXL", category: "arts", tag: "Fair",
    venue: "Alliance Française", city: "Mike Adenuga Centre",
    description: "A one-day print + digital art fair. Low-cost entry, refundable, three passes per wallet.",
    leadMs: 1 * DAY, durationMs: 1 * DAY, maxTickets: 200, maxPerUser: 3, refundable: true,
    price: { coin: "SUI", units: SUI(1) },
  },
  {
    name: "Permissionless Summit", symbol: "PERMSUM", category: "web3", tag: "Summit",
    venue: "Landmark Centre", city: "Lagos",
    description: "Two days on permissionless infrastructure, identity and payments. Free, open to all.",
    leadMs: 1 * DAY, durationMs: 2 * DAY, maxTickets: 400, maxPerUser: 2, refundable: false, web3: true, price: null,
  },
  {
    name: "Walrus Cup Finals", symbol: "WALRUSCUP", category: "sports", tag: "Tournament",
    venue: "Mobolaji Johnson Arena", city: "Lagos",
    description: "The decentralized-storage league finals over a day and a half. USDC entry, non-refundable.",
    leadMs: 2 * DAY, durationMs: Math.round(1.5 * DAY), maxTickets: 250, maxPerUser: 4, refundable: false,
    price: { coin: "USDC", units: USDC(8) },
  },
];

function loadCliKeypair(expectedAddress: string): Keypair {
  const path = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const entries: string[] = JSON.parse(readFileSync(path, "utf8"));
  for (const e of entries) {
    let kp: Keypair | null = null;
    if (e.startsWith("suiprivkey")) {
      const { secretKey, scheme } = decodeSuiPrivateKey(e);
      if (scheme === "ED25519") kp = Ed25519Keypair.fromSecretKey(secretKey);
      else if (scheme === "Secp256k1") kp = Secp256k1Keypair.fromSecretKey(secretKey);
      else if (scheme === "Secp256r1") kp = Secp256r1Keypair.fromSecretKey(secretKey);
    } else {
      const bytes = Buffer.from(e, "base64");
      const secret = bytes.subarray(1);
      if (bytes[0] === 0) kp = Ed25519Keypair.fromSecretKey(secret);
      else if (bytes[0] === 1) kp = Secp256k1Keypair.fromSecretKey(secret);
      else if (bytes[0] === 2) kp = Secp256r1Keypair.fromSecretKey(secret);
    }
    if (kp && kp.toSuiAddress() === expectedAddress) return kp;
  }
  throw new Error(`No keystore entry derives to ${expectedAddress}`);
}

function eventIdFromResult(res: { objectChanges?: unknown }): string | null {
  const changes = (res.objectChanges ?? []) as {
    type?: string;
    objectType?: string;
    objectId?: string;
  }[];
  const ev = changes.find(
    (c) => c.type === "created" && c.objectType?.endsWith("::event::Event"),
  );
  return ev?.objectId ?? null;
}

async function main() {
  const limit = process.argv[2] ? Number(process.argv[2]) : SPECS.length;
  const specs = SPECS.slice(0, limit);
  const client = new SuiJsonRpcClient({
    url: rpcUrl("testnet"),
    network: "testnet",
  });
  const kp = loadCliKeypair(SENDER);

  console.log(`Sender:  ${SENDER}`);
  console.log(`Events:  ${specs.length}\n`);

  let ok = 0;
  for (const [i, s] of specs.entries()) {
    const tag = `[${i + 1}/${specs.length}] ${s.name}`;
    try {
      const meta: EventMetadata = {
        v: 1,
        category: s.category,
        description: s.description,
        tag: s.tag,
        venue: s.venue,
        city: s.city,
        refundable: s.refundable,
        ...(s.poap ? { poap: true } : {}),
        ...(s.web3 ? { web3: true } : {}),
      };
      const uri = await putEventMetadata(meta); // → Walrus blob id

      // Per-event clock read so a long run never drifts past start_ms >= now.
      const now = Date.now();
      const startMs = BigInt(now + s.leadMs);
      const endMs = BigInt(now + s.leadMs + s.durationMs);
      const purchaseStartMs = BigInt(now); // purchases open immediately (<= start)

      const tx = s.price
        ? createEventWithPriceTx(
            {
              name: s.name, symbol: s.symbol, uri,
              startMs, endMs, purchaseStartMs,
              maxTickets: BigInt(s.maxTickets), maxPerUser: BigInt(s.maxPerUser),
              isRefundable: s.refundable,
              coinType: s.price.coin === "SUI" ? SUI_COIN_TYPE : USDC_COIN_TYPE,
              price: s.price.units,
            },
            SENDER,
          )
        : createEventTx(
            {
              name: s.name, symbol: s.symbol, uri,
              startMs, endMs, purchaseStartMs,
              maxTickets: BigInt(s.maxTickets), maxPerUser: BigInt(s.maxPerUser),
              isFree: true, isRefundable: s.refundable,
            },
            SENDER,
          );
      tx.setSender(SENDER);

      const res = await client.signAndExecuteTransaction({
        transaction: tx,
        signer: kp,
        options: { showEffects: true, showObjectChanges: true },
      });
      await client.core.waitForTransaction({ digest: res.digest });

      const eventId = eventIdFromResult(res);
      const priceLabel = s.price
        ? `${s.price.coin === "SUI" ? Number(s.price.units) / 1e9 : Number(s.price.units) / 1e6} ${s.price.coin}`
        : "free";
      const days = (s.durationMs / DAY).toFixed(1);
      console.log(
        `${tag}\n` +
          `   ${s.category} · ${priceLabel} · ${days}d · cap ${s.maxTickets}/${s.maxPerUser} · ${s.refundable ? "refundable" : "non-refundable"}` +
          `${s.poap ? " · POAP" : ""}${s.web3 ? " · web3" : ""}\n` +
          `   event: ${eventId ?? "(id not found)"}\n` +
          `   tx:    https://suiscan.xyz/testnet/tx/${res.digest}\n`,
      );
      ok += 1;
    } catch (err: unknown) {
      const e = err as { message?: string; errors?: unknown };
      console.error(`${tag}\n   FAILED: ${e.message ?? String(err)}`);
      if (e.errors) console.error(`   ${JSON.stringify(e.errors)}`);
      console.error("");
    }
  }

  console.log(`Done: ${ok}/${specs.length} events created.`);
  if (ok < specs.length) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
