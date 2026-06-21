// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";

// `server-only` throws when imported outside an RSC graph; neutralize it so the
// server lib can be unit-tested. (In the app it still guards client imports.)
vi.mock("server-only", () => ({}));

import { walletCapabilities, buildGoogleSaveUrl } from "../walletPass.server";

// Self-generated RSA key so we can sign AND verify a real Save-to-Google JWT
// without any external credentials — the only wallet path testable offline.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const WALLET_ENV = [
  "GOOGLE_WALLET_ISSUER_ID",
  "GOOGLE_WALLET_SA_EMAIL",
  "GOOGLE_WALLET_SA_KEY",
  "GOOGLE_WALLET_CLASS_ID",
  "APPLE_PASS_TYPE_ID",
  "APPLE_TEAM_ID",
  "APPLE_PASS_CERT",
  "APPLE_PASS_KEY",
  "APPLE_WWDR_CERT",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(WALLET_ENV.map((k) => [k, process.env[k]]));
  for (const k of WALLET_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of WALLET_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("walletCapabilities", () => {
  it("reports both providers off when env is absent", () => {
    expect(walletCapabilities()).toEqual({ apple: false, google: false });
  });

  it("turns google on only when ALL required vars are present", () => {
    process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000000000000";
    expect(walletCapabilities().google).toBe(false); // partial config stays off
    process.env.GOOGLE_WALLET_SA_EMAIL = "svc@hostit.iam.gserviceaccount.com";
    process.env.GOOGLE_WALLET_SA_KEY = privateKey;
    expect(walletCapabilities().google).toBe(true);
    expect(walletCapabilities().apple).toBe(false);
  });
});

describe("buildGoogleSaveUrl", () => {
  beforeEach(() => {
    process.env.GOOGLE_WALLET_ISSUER_ID = "3388000000000000000";
    process.env.GOOGLE_WALLET_SA_EMAIL = "svc@hostit.iam.gserviceaccount.com";
    process.env.GOOGLE_WALLET_SA_KEY = privateKey;
  });

  it("throws when unconfigured", async () => {
    delete process.env.GOOGLE_WALLET_SA_KEY;
    await expect(buildGoogleSaveUrl({ ticketId: "0xabc", name: "X" })).rejects.toThrow(/not configured/);
  });

  it("signs a valid JWT encoding the ticket id as the QR barcode", async () => {
    const ticketId = "0xabc123def456";
    const url = await buildGoogleSaveUrl({
      ticketId,
      name: "HostIt Demo",
      dateText: "Sat, 12 Jul 2026 · 18:00",
      venue: "Lagos",
      serial: "7",
    });
    expect(url.startsWith("https://pay.google.com/gp/v/save/")).toBe(true);

    const jwt = url.slice("https://pay.google.com/gp/v/save/".length);
    const { payload } = await jwtVerify(jwt, await importSPKI(publicKey, "RS256"));

    expect(payload.iss).toBe("svc@hostit.iam.gserviceaccount.com");
    expect(payload.aud).toBe("google");
    expect(payload.typ).toBe("savetowallet");

    const inner = payload.payload as {
      genericClasses: { id: string }[];
      genericObjects: { id: string; classId: string; barcode: { value: string } }[];
    };
    const obj = inner.genericObjects[0];
    expect(obj.barcode.value).toBe(ticketId); // door scanner reads the bare id
    expect(obj.classId).toBe("3388000000000000000.hostit_event");
    expect(obj.id).toBe(`3388000000000000000.${ticketId}`);
  });
});
