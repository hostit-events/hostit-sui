"use client";

import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { fromBase64, toBase64 } from "@mysten/sui/utils";

export interface SponsorAndExecuteArgs {
  transaction: Transaction;
  sender: string;
  /** A Sui client compatible with `Transaction.build({ client })`. */
  suiClient: ClientWithCoreApi;
  /** Wallet-side signer. Receives the sponsored tx bytes and returns the user's signature. */
  signTransactionBytes: (bytes: Uint8Array) => Promise<{ signature: string }>;
}

interface ApiErrorBody {
  error?: string;
  details?: unknown;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as ApiErrorBody;
    const detail = err.details ? ` (${JSON.stringify(err.details)})` : "";
    throw new Error(`${path} ${res.status}: ${err.error ?? res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

export async function sponsorAndExecute(
  args: SponsorAndExecuteArgs,
): Promise<{ digest: string }> {
  args.transaction.setSender(args.sender);
  const kindBytes = await args.transaction.build({
    client: args.suiClient,
    onlyTransactionKind: true,
  });

  const sponsored = await postJson<{ bytes: string; digest: string }>(
    "/api/sponsor",
    { transactionKindBytes: toBase64(kindBytes), sender: args.sender },
  );

  const { signature } = await args.signTransactionBytes(fromBase64(sponsored.bytes));

  const result = await postJson<{ digest: string }>("/api/sponsor/execute", {
    digest: sponsored.digest,
    signature,
  });
  return { digest: result.digest };
}
