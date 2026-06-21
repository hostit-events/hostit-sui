import "server-only";

import { PKPass } from "passkit-generator";
import { SignJWT, importPKCS8 } from "jose";
import { WALLET_ICON_PNG_BASE64 } from "./walletIcon";

// Server-only wallet-pass generation. Holds NO secrets in this module — every
// credential is read from process.env at call time (never NEXT_PUBLIC_*). Both
// providers are OPT-IN: absent credentials => that provider reports unavailable
// and the UI hides its button (the route returns 503 if called anyway).

export interface PassData {
  /** Bare on-chain ticket object id — the exact value the door QR encodes. */
  ticketId: string;
  /** Event name. */
  name: string;
  /** Human date/time line, e.g. "Sat, 12 Jul 2026 · 18:00". Optional. */
  dateText?: string;
  /** Venue/location line. Optional. */
  venue?: string;
  /** Ticket serial, shown as the barcode alt text. Optional. */
  serial?: string;
}

const env = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v : undefined;
};
const pem = (v: string) => v.replace(/\\n/g, "\n");

const APPLE_KEYS = [
  "APPLE_PASS_TYPE_ID",
  "APPLE_TEAM_ID",
  "APPLE_PASS_CERT",
  "APPLE_PASS_KEY",
  "APPLE_WWDR_CERT",
] as const;
const GOOGLE_KEYS = ["GOOGLE_WALLET_ISSUER_ID", "GOOGLE_WALLET_SA_EMAIL", "GOOGLE_WALLET_SA_KEY"] as const;

/** Which providers are configured (all required env vars present). */
export function walletCapabilities(): { apple: boolean; google: boolean } {
  return {
    apple: APPLE_KEYS.every((k) => env(k)),
    google: GOOGLE_KEYS.every((k) => env(k)),
  };
}

/** Build a signed Apple Wallet `.pkpass` (an eventTicket). Throws if unconfigured. */
export function buildApplePkpass(d: PassData): Buffer {
  if (!walletCapabilities().apple) throw new Error("Apple Wallet not configured");
  const icon = Buffer.from(WALLET_ICON_PNG_BASE64, "base64");

  const pass = new PKPass(
    { "icon.png": icon, "icon@2x.png": icon, "icon@3x.png": icon, "logo.png": icon },
    {
      wwdr: pem(env("APPLE_WWDR_CERT")!),
      signerCert: pem(env("APPLE_PASS_CERT")!),
      signerKey: pem(env("APPLE_PASS_KEY")!),
      signerKeyPassphrase: env("APPLE_PASS_KEY_PASSPHRASE"),
    },
    {
      passTypeIdentifier: env("APPLE_PASS_TYPE_ID")!,
      teamIdentifier: env("APPLE_TEAM_ID")!,
      organizationName: "HostIt",
      description: `HostIt ticket — ${d.name}`,
      serialNumber: d.ticketId,
      foregroundColor: "rgb(255, 255, 255)",
      backgroundColor: "rgb(12, 17, 43)",
      labelColor: "rgb(160, 180, 255)",
    },
  );

  pass.type = "eventTicket";
  pass.setBarcodes({
    message: d.ticketId,
    format: "PKBarcodeFormatQR",
    messageEncoding: "iso-8859-1",
    altText: d.serial ? `#${d.serial}` : undefined,
  });
  pass.primaryFields.push({ key: "event", label: "EVENT", value: d.name });
  if (d.dateText) pass.secondaryFields.push({ key: "date", label: "WHEN", value: d.dateText });
  if (d.venue) pass.secondaryFields.push({ key: "venue", label: "WHERE", value: d.venue });

  return pass.getAsBuffer();
}

/** Build a "Save to Google Wallet" URL (signed JWT, classes inlined). Throws if unconfigured. */
export async function buildGoogleSaveUrl(d: PassData): Promise<string> {
  if (!walletCapabilities().google) throw new Error("Google Wallet not configured");
  const issuerId = env("GOOGLE_WALLET_ISSUER_ID")!;
  const saEmail = env("GOOGLE_WALLET_SA_EMAIL")!;
  const saKey = pem(env("GOOGLE_WALLET_SA_KEY")!);
  const classId = env("GOOGLE_WALLET_CLASS_ID") || `${issuerId}.hostit_event`;
  // Object ids must match [a-zA-Z0-9._-]; a 0x-hex ticket id already qualifies.
  const objectId = `${issuerId}.${d.ticketId.replace(/[^a-zA-Z0-9._-]/g, "")}`;

  const genericObject: Record<string, unknown> = {
    id: objectId,
    classId,
    state: "ACTIVE",
    hexBackgroundColor: "#0C112B",
    cardTitle: { defaultValue: { language: "en-US", value: "HostIt" } },
    header: { defaultValue: { language: "en-US", value: d.name } },
    barcode: { type: "QR_CODE", value: d.ticketId, alternateText: d.serial ? `#${d.serial}` : undefined },
  };
  if (d.dateText)
    genericObject.subheader = { defaultValue: { language: "en-US", value: d.dateText } };
  if (d.venue)
    genericObject.textModulesData = [{ id: "venue", header: "Venue", body: d.venue }];

  const claims = {
    iss: saEmail,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    payload: { genericClasses: [{ id: classId }], genericObjects: [genericObject] },
  };

  const key = await importPKCS8(saKey, "RS256");
  const jwt = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", typ: "JWT" }).sign(key);
  return `https://pay.google.com/gp/v/save/${jwt}`;
}
