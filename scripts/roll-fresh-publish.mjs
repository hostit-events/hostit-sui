#!/usr/bin/env bun
// Roll a FRESH publish through the repo. See DEPLOYING.md → "Fresh-publish procedure".
//
//   1) prep:    Published.toml [published.testnet] removed + Move.toml [addresses]=0x0
//   2) publish: sui client publish --gas-budget 2000000000 --json > /tmp/publish.json   (gated)
//   3) roll:    bun scripts/roll-fresh-publish.mjs /tmp/publish.json
//
// Step 3 (this script) reads the publish output, then string-replaces the CURRENT
// ids in web/lib/config.ts with the newly-published ones. The package model is a
// SINGLE id now (fresh-publish, no PACKAGE_ID_LATEST/PREDICT_*_PKG split), so one
// replace of PACKAGE_ID covers every interpolated type/event/target string. It
// also rolls HUB_ID, TRANSFER_POLICY_ID, and GOVERNANCE_REGISTRY_ID, and sets
// Move.toml [addresses]. Published.toml is rewritten by `sui client publish` itself.
// (There is no PoapRegistry anymore — POAP dedup is a flag on the Ticket.)
//
// Pure local file edits — not a chain action. Reversible with `git checkout`.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "web/lib/config.ts");
const MOVE_TOML = resolve(ROOT, "Move.toml");

const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error("usage: bun scripts/roll-fresh-publish.mjs <publish.json>");
  process.exit(1);
}

// --- parse `sui client publish --json` ---
const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
const changes = raw.objectChanges ?? raw.result?.objectChanges;
if (!Array.isArray(changes)) {
  console.error("Could not find objectChanges[] in the publish JSON. Did you pass --json output?");
  process.exit(1);
}

const published = changes.find((c) => c.type === "published");
const created = changes.filter((c) => c.type === "created");
const byTypeSuffix = (suffix) =>
  created.find((c) => typeof c.objectType === "string" && c.objectType.includes(suffix));
const byTypeBoth = (a, b) =>
  created.find(
    (c) => typeof c.objectType === "string" && c.objectType.includes(a) && c.objectType.includes(b),
  );

const newPkg = published?.packageId;
const newHub = byTypeSuffix("::hub::Hub")?.objectId;
// TransferPolicy<…::ticket::Ticket> — match the framework type + our Ticket param.
const newPolicy = byTypeBoth("::transfer_policy::TransferPolicy<", "::ticket::Ticket")?.objectId;
// AccessControl<…::governance::GOVERNANCE> — the protocol RBAC registry.
const newGov = byTypeBoth("::access_control::AccessControl<", "::governance::GOVERNANCE")?.objectId;
// identity::EmailRegistry — one-account-one-email registry (GH#96).
const newEmailReg = byTypeSuffix("::identity::EmailRegistry")?.objectId;
const newUpgradeCap = byTypeSuffix("::package::UpgradeCap")?.objectId;

const missing = Object.entries({ newPkg, newHub, newPolicy, newGov }).filter(([, v]) => !v);
if (missing.length) {
  console.error("Missing from publish JSON:", missing.map(([k]) => k).join(", "));
  console.error("objectChanges types seen:", [...new Set(changes.map((c) => c.type))].join(", "));
  process.exit(1);
}

// --- read CURRENT ids from config.ts (so this is reusable across publishes) ---
let config = readFileSync(CONFIG, "utf8");
const firstId = (constName) => {
  const m = config.match(new RegExp(`${constName}\\s*=[\\s\\S]*?"(0x[0-9a-fA-F]{64})"`));
  if (!m) {
    console.error(`Could not find current id for ${constName} in config.ts`);
    process.exit(1);
  }
  return m[1];
};
const oldPkg = firstId("PACKAGE_ID");
const oldHub = firstId("HUB_ID");
const oldPolicy = firstId("TRANSFER_POLICY_ID");
const oldGov = firstId("GOVERNANCE_REGISTRY_ID");

// --- patch config.ts (count replacements as a sanity check) ---
const replaceAllCount = (hay, from, to) => {
  if (from === to) return [hay, 0];
  const n = hay.split(from).length - 1;
  return [hay.split(from).join(to), n];
};
let n;
[config, n] = replaceAllCount(config, oldPkg, newPkg);
console.log(`config.ts: PACKAGE_ID ${oldPkg.slice(0, 10)}… → ${newPkg.slice(0, 10)}…  (${n} occurrences)`);
[config, n] = replaceAllCount(config, oldHub, newHub); console.log(`config.ts: HUB_ID (${n})`);
[config, n] = replaceAllCount(config, oldPolicy, newPolicy); console.log(`config.ts: TRANSFER_POLICY_ID (${n})`);
[config, n] = replaceAllCount(config, oldGov, newGov); console.log(`config.ts: GOVERNANCE_REGISTRY_ID (${n})`);
// EMAIL_REGISTRY_ID starts as `?? ""` (created only once identity ships) and is a
// 0x id on later publishes — handle both.
if (newEmailReg) {
  const emailM = config.match(/NEXT_PUBLIC_HOSTIT_EMAIL_REGISTRY_ID\s*\?\?\s*"(0x[0-9a-fA-F]{64}|)"/);
  if (emailM) {
    config = config.replace(emailM[0], emailM[0].replace(`"${emailM[1]}"`, `"${newEmailReg}"`));
    console.log(`config.ts: EMAIL_REGISTRY_ID → ${newEmailReg.slice(0, 10)}…`);
  } else {
    console.log("config.ts: EMAIL_REGISTRY_ID not found (skipped — set NEXT_PUBLIC_HOSTIT_EMAIL_REGISTRY_ID manually)");
  }
} else {
  console.log("publish JSON had no identity::EmailRegistry (identity module not in this publish?)");
}
writeFileSync(CONFIG, config);

// --- patch Move.toml [addresses] (NOT [dev-addresses], which is 0xCAFE) ---
let moveToml = readFileSync(MOVE_TOML, "utf8");
moveToml = moveToml.replace(/(\[addresses\][\s\S]*?hostit_ticket\s*=\s*)"0x[0-9a-fA-Fx]+"/, `$1"${newPkg}"`);
writeFileSync(MOVE_TOML, moveToml);
console.log(`Move.toml: [addresses] hostit_ticket → ${newPkg.slice(0, 10)}…`);

// --- summary + manual follow-ups ---
console.log("\n=== Rolled to fresh publish ===");
console.log(`package                 ${newPkg}`);
console.log(`Hub                     ${newHub}`);
console.log(`TransferPolicy<Ticket>  ${newPolicy}`);
console.log(`AccessControl<GOV>      ${newGov}`);
if (newEmailReg) console.log(`EmailRegistry           ${newEmailReg}`);
if (newUpgradeCap) console.log(`UpgradeCap              ${newUpgradeCap}`);
console.log("\nVercel env (Production) — update if these env overrides are set:");
console.log(`  NEXT_PUBLIC_HOSTIT_PACKAGE_ID=${newPkg}`);
console.log(`  NEXT_PUBLIC_HOSTIT_HUB_ID=${newHub}`);
console.log(`  NEXT_PUBLIC_HOSTIT_GOVERNANCE_ID=${newGov}`);
if (newEmailReg) console.log(`  NEXT_PUBLIC_HOSTIT_EMAIL_REGISTRY_ID=${newEmailReg}`);
console.log("\nNext: bunx tsc --noEmit (in web/) · update .suiperpower/deploy-context.md · re-attach policy_rules if resale is live · commit + push.");
