import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import type { Keypair } from "@mysten/sui/cryptography";

/**
 * Load the keypair for the active Sui CLI address. Supports ed25519, secp256k1,
 * and secp256r1 schemes (Sui type bytes 0, 1, 2 respectively).
 * Reads ~/.sui/sui_config/sui.keystore and matches by derived address. Never logs the secret.
 */
export function loadCliKeypair(expectedAddress: string): Keypair {
  const keystorePath = join(homedir(), ".sui", "sui_config", "sui.keystore");
  const raw = readFileSync(keystorePath, "utf8");
  const entries: string[] = JSON.parse(raw);

  for (const entry of entries) {
    const kp = entry.startsWith("suiprivkey")
      ? keypairFromBech32(entry)
      : keypairFromLegacyBase64(entry);
    if (kp && kp.toSuiAddress() === expectedAddress) return kp;
  }
  throw new Error(
    `No keystore entry derives to ${expectedAddress}. ` +
      `Check ~/.sui/sui_config/sui.keystore or run \`sui client active-address\`.`,
  );
}

function keypairFromBech32(entry: string): Keypair | null {
  const { secretKey, schema } = decodeSuiPrivateKey(entry);
  switch (schema) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(secretKey);
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(secretKey);
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(secretKey);
    default:
      return null;
  }
}

function keypairFromLegacyBase64(entry: string): Keypair | null {
  const bytes = Buffer.from(entry, "base64");
  const typeByte = bytes[0];
  const secret = bytes.subarray(1);
  switch (typeByte) {
    case 0:
      return Ed25519Keypair.fromSecretKey(secret);
    case 1:
      return Secp256k1Keypair.fromSecretKey(secret);
    case 2:
      return Secp256r1Keypair.fromSecretKey(secret);
    default:
      return null;
  }
}
