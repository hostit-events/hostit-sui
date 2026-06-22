"use client";

// Client orchestration for email binding (GH#96). Shared by EmailCaptureDialog
// (bind) and SettingsScreen (view/erase). The plaintext email never leaves the
// client unencrypted: it's Seal-encrypted under the user's EMAIL namespace and
// stored on Walrus; only the opaque server HMAC hash is registered on-chain.

import type { Transaction } from "@mysten/sui/transactions";
import { toBase64, fromBase64, toHex } from "@mysten/sui/utils";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { ENOKI_NETWORK } from "./auth";
import { PACKAGE_ID } from "./config";
import {
  makeSealClient,
  makeEmailSealId,
  createSessionKey,
  sealDecrypt,
  approveOwnEmail,
  approveAttendeeEmail,
} from "./seal";
import { storeBlob, readBlob, storeJson } from "./walrus";
import { registerEmailTx, unregisterEmailTx } from "./identity";
import { canonicalizeEmail } from "./emailCanonical";
import { emailBindMessage, profilePointerMessage } from "./accountMessages";
import { getTurnstileToken } from "./turnstileClient";
import type { ProfileEnvelope } from "./profile";

/** A personal-message signer that works for BOTH a wallet and a zkLogin session
 *  (zkLogin signs programmatically — no popup). */
export type SignPersonalMessage = (message: Uint8Array) => Promise<{ signature: string }>;

export function useSignPersonalMessage(): SignPersonalMessage {
  const dAppKit = useDAppKit();
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();
  return async (message: Uint8Array) => {
    if (zk.address) {
      const keypair = await enokiFlow.getKeypair({ network: ENOKI_NETWORK });
      const { signature } = await keypair.signPersonalMessage(message);
      return { signature };
    }
    const signed = await new CurrentAccountSigner(dAppKit).signPersonalMessage(message);
    return { signature: signed.signature };
  };
}

/** A tx submitter (sponsored or direct) — passed in by the calling component. */
export type SubmitTx = (tx: Transaction) => Promise<{ digest: string }>;

/** Seal-encrypt `{email}` under EMAIL_NS_TAG‖address, store as a {id,ct} envelope
 *  on Walrus (mirrors the forum envelope so decrypt can recover the Seal id). */
export async function encryptEmailEnvelope(
  suiClient: unknown,
  address: string,
  email: string,
): Promise<string> {
  const client = makeSealClient(suiClient);
  const id = makeEmailSealId(address);
  const { encryptedObject } = await client.encrypt({
    threshold: 1,
    packageId: PACKAGE_ID,
    id,
    data: new TextEncoder().encode(JSON.stringify({ email, ts: Date.now() })),
  });
  const envelope = JSON.stringify({ id, ct: toBase64(encryptedObject as unknown as Uint8Array) });
  return storeBlob(new TextEncoder().encode(envelope));
}

interface EmailEnvelopeBlob {
  id: string;
  ct: string;
}

async function readEnvelope(blobId: string): Promise<EmailEnvelopeBlob> {
  return JSON.parse(new TextDecoder().decode(await readBlob(blobId))) as EmailEnvelopeBlob;
}

/** Owner decrypts their own email (seal_approve_own_email). */
export async function decryptOwnEmail(
  suiClient: unknown,
  address: string,
  emailBlobId: string,
  sign: SignPersonalMessage,
): Promise<string> {
  const env = await readEnvelope(emailBlobId);
  const sk = await createSessionKey(suiClient, address, sign);
  const pt = await sealDecrypt(suiClient, sk, fromBase64(env.ct), (tx) => approveOwnEmail(tx, env.id));
  return (JSON.parse(new TextDecoder().decode(pt)) as { email: string }).email;
}

/** Organizer decrypts an opted-in attendee's email (seal_approve_attendee_email).
 *  Reuse a cached SessionKey across rows to avoid re-prompting. */
export async function decryptAttendeeEmail(
  suiClient: unknown,
  sessionKey: Awaited<ReturnType<typeof createSessionKey>>,
  emailBlobId: string,
  capId: string,
  eventId: string,
  grantId: string,
): Promise<string> {
  const env = await readEnvelope(emailBlobId);
  const pt = await sealDecrypt(suiClient, sessionKey, fromBase64(env.ct), (tx) =>
    approveAttendeeEmail(tx, env.id, capId, eventId, grantId),
  );
  return (JSON.parse(new TextDecoder().decode(pt)) as { email: string }).email;
}

/** Sign + PUT the non-sensitive profile pointer. */
export async function writeProfilePointer(
  address: string,
  blobId: string,
  sign: SignPersonalMessage,
): Promise<void> {
  const { signature } = await sign(new TextEncoder().encode(profilePointerMessage(address, blobId)));
  const r = await fetch("/api/identity/profile-pointer", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, blobId, signature }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || "Couldn't save your profile.");
  }
}

interface FinishArgs {
  suiClient: unknown;
  address: string;
  email: string; // display (raw) — encrypted for the owner
  hashBytes: number[]; // server-canonical HMAC — registered on-chain
  version: number;
  source: "google" | "wallet";
  sign: SignPersonalMessage;
  submitTx: SubmitTx;
  baseProfile?: ProfileEnvelope | null;
}

/** Shared bind tail: encrypt → register on-chain → write profile pointer. */
async function finishBind(a: FinishArgs): Promise<void> {
  const emailBlobId = await encryptEmailEnvelope(a.suiClient, a.address, a.email);
  await a.submitTx(registerEmailTx(a.hashBytes));
  const next: ProfileEnvelope = {
    ...(a.baseProfile ?? {}),
    v: 1,
    emailBlobId,
    emailHash: toHex(Uint8Array.from(a.hashBytes)),
    emailHashVersion: a.version,
    emailSource: a.source,
  };
  const blobId = await storeJson(next);
  await writeProfilePointer(a.address, blobId, a.sign);
}

/** Google/zkLogin: verify the id_token server-side, then bind. Popup-free. */
export async function bindGoogleEmail(args: {
  suiClient: unknown;
  address: string;
  jwt: string;
  sign: SignPersonalMessage;
  submitTx: SubmitTx;
  baseProfile?: ProfileEnvelope | null;
}): Promise<string> {
  const r = await fetch("/api/email/bind-google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: args.jwt }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    error?: string;
    hashBytes?: number[];
    version?: number;
    email?: string;
  };
  if (!r.ok || !j.hashBytes || !j.email) throw new Error(j.error || "Couldn't verify your Google email.");
  await finishBind({ ...args, email: j.email, hashBytes: j.hashBytes, version: j.version ?? 1, source: "google" });
  return j.email;
}

/** Wallet step 1: sign the binding message + request a one-time code by email. */
export async function startWalletEmail(args: {
  address: string;
  email: string;
  sign: SignPersonalMessage;
}): Promise<void> {
  const canonicalEmail = canonicalizeEmail(args.email);
  if (!canonicalEmail) throw new Error("Enter a valid email.");
  const nonce = crypto.randomUUID();
  const expiryMs = Date.now() + 10 * 60_000;
  const { signature } = await args.sign(
    new TextEncoder().encode(emailBindMessage({ address: args.address, canonicalEmail, nonce, expiryMs })),
  );
  // Proof-of-browser so the server bot-wall lets the send through. Acquired here
  // (like lib/sponsor.ts) rather than passed by the caller — a caller forgetting
  // it silently 403'd /api/email/start as "Bot check failed" (#96). null when
  // Turnstile is disabled → the server skips the check.
  const turnstileToken = await getTurnstileToken();
  const r = await fetch("/api/email/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: args.email,
      address: args.address,
      signature,
      nonce,
      expiryMs,
      turnstileToken,
    }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || "Couldn't send the code.");
  }
}

/** Wallet step 2: verify the code, then bind. */
export async function verifyWalletEmail(args: {
  suiClient: unknown;
  address: string;
  email: string;
  code: string;
  sign: SignPersonalMessage;
  submitTx: SubmitTx;
  baseProfile?: ProfileEnvelope | null;
}): Promise<void> {
  const r = await fetch("/api/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: args.address, code: args.code }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string; hashBytes?: number[]; version?: number };
  if (!r.ok || !j.hashBytes) throw new Error(j.error || "Incorrect or expired code.");
  await finishBind({
    suiClient: args.suiClient,
    address: args.address,
    email: args.email,
    hashBytes: j.hashBytes,
    version: j.version ?? 1,
    source: "wallet",
    sign: args.sign,
    submitTx: args.submitTx,
    baseProfile: args.baseProfile,
  });
}

/** Wallet-only: unbind the email (clear the registry row + drop the profile's
 *  email fields). Google sessions can't unbind (the email is the identity), but
 *  CAN erase via the same on-chain unregister + profile rewrite. */
export async function eraseEmail(args: {
  address: string;
  hashBytes: number[];
  sign: SignPersonalMessage;
  submitTx: SubmitTx;
  baseProfile: ProfileEnvelope | null;
}): Promise<string> {
  const { digest } = await args.submitTx(unregisterEmailTx(args.hashBytes));
  const next: ProfileEnvelope = { ...(args.baseProfile ?? {}), v: 1 };
  delete next.emailBlobId;
  delete next.emailHashVersion;
  delete next.emailSource;
  const blobId = await storeJson(next);
  await writeProfilePointer(args.address, blobId, args.sign);
  return digest;
}
