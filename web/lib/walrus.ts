// Walrus testnet blob storage (HTTP publisher/aggregator — no SDK needed).
// Used for event metadata JSON, cover images, and Seal-encrypted forum payloads.

import { WALRUS_PUBLISHER, WALRUS_AGGREGATOR, WALRUS_EPOCHS } from "./config";

interface StoreResp {
  newlyCreated?: { blobObject?: { blobId?: string } };
  alreadyCertified?: { blobId?: string };
}

export async function storeBlob(data: Uint8Array, epochs = WALRUS_EPOCHS): Promise<string> {
  const resp = await fetch(`${WALRUS_PUBLISHER}/v1/blobs?epochs=${epochs}`, {
    method: "PUT",
    body: data as BodyInit,
  });
  if (!resp.ok) throw new Error(`Walrus store failed: ${resp.status}`);
  const json = (await resp.json()) as StoreResp;
  const blobId = json.newlyCreated?.blobObject?.blobId ?? json.alreadyCertified?.blobId;
  if (!blobId) throw new Error("Walrus store: no blobId in response");
  return blobId;
}

export async function readBlob(blobId: string): Promise<Uint8Array> {
  const resp = await fetch(`${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`);
  if (!resp.ok) throw new Error(`Walrus read failed: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function storeJson(obj: unknown, epochs = WALRUS_EPOCHS): Promise<string> {
  return storeBlob(new TextEncoder().encode(JSON.stringify(obj)), epochs);
}

export async function readJson<T>(blobId: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await readBlob(blobId))) as T;
}

export async function storeFile(file: File, epochs = WALRUS_EPOCHS): Promise<string> {
  return storeBlob(new Uint8Array(await file.arrayBuffer()), epochs);
}

/** Public aggregator URL for a blob (use as an <img src>). */
export function blobUrl(blobId: string): string {
  return `${WALRUS_AGGREGATOR}/v1/blobs/${blobId}`;
}

/** Heuristic: a Walrus blob id (base64url, ~43 chars, no scheme/slash). */
export function isBlobId(s: string): boolean {
  return !!s && !/^https?:\/\//.test(s) && !s.includes("/") && !s.startsWith("0x") && s.length > 20;
}
