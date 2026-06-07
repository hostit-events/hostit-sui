"use client";

import { useMutation, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import {
  useCurrentAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import type { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sponsorAndExecute } from "./sponsor";

export { useCurrentAccount, useCurrentClient };

/**
 * Mirror of the old `useSignAndExecuteTransaction` shape via the v2 signer.
 * Unwraps the discriminated-union result and throws on failed transactions so
 * callers can just read `.digest` / `.effects` on the returned Transaction.
 */
export function useSignAndExecute() {
  const dAppKit = useDAppKit();
  return useMutation({
    mutationFn: async (input: { transaction: Transaction }) => {
      const result = await new CurrentAccountSigner(dAppKit).signAndExecuteTransaction({
        transaction: input.transaction,
      });
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          `Transaction failed: ${JSON.stringify(result.FailedTransaction?.status)}`,
        );
      }
      return result.Transaction;
    },
  });
}

/**
 * Sign-and-execute via the Enoki sponsored-transaction flow. Sponsor pays gas;
 * the user only signs the data. Use this hook for actions that match the
 * portal allowlist (register_issuer / buy_ticket / use_ticket). Throws if
 * Enoki is not configured or the user hasn't connected a wallet.
 */
export function useSponsorAndExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  return useMutation({
    mutationFn: async (input: { transaction: Transaction; sender: string }) => {
      return sponsorAndExecute({
        transaction: input.transaction,
        sender: input.sender,
        suiClient: client,
        signTransactionBytes: async (bytes) => {
          const signed = await dAppKit.signTransaction({
            transaction: toBase64(bytes),
          });
          return { signature: signed.signature };
        },
      });
    },
  });
}

/**
 * Thin wrapper that calls a method on the current SuiClient. Replaces the
 * v0/v1 `useSuiClientQuery` hook (removed in v2). Pass any client method name
 * and its args. Disable by setting `enabled: false`.
 */
export function useSuiQuery<TFn extends string, TArgs, TResult>(
  fn: TFn,
  args: TArgs,
  options?: Omit<UseQueryOptions<TResult, Error>, "queryKey" | "queryFn">,
) {
  const client = useCurrentClient() as unknown as Record<string, (a: TArgs) => Promise<TResult>>;
  return useQuery<TResult, Error>({
    queryKey: [fn, args],
    queryFn: () => client[fn](args),
    ...options,
  });
}
