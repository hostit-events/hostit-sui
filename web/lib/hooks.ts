"use client";

import { useMutation, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import {
  useCurrentAccount as useDAppKitAccount,
  useCurrentClient,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { sponsorAndExecute } from "./sponsor";
import { ENOKI_NETWORK } from "./auth";

export { useCurrentClient };

/**
 * Current account, unified across auth methods: a Google (Enoki zkLogin)
 * session takes precedence, otherwise the connected dapp-kit wallet. Consumers
 * only read `.address`, so we expose a minimal `{ address }` shape.
 */
export function useCurrentAccount(): { address: string } | null {
  const wallet = useDAppKitAccount();
  const zkAddress = useZkLogin().address;
  if (zkAddress) return { address: zkAddress };
  return wallet ? { address: wallet.address } : null;
}

/**
 * Mirror of the old `useSignAndExecuteTransaction` shape. For wallets it goes
 * through dapp-kit's signer; for a Google (zkLogin) session it signs with the
 * Enoki keypair and executes via the SuiClient. Throws on a failed transaction
 * so callers can read `.digest` / `.effects` on the result.
 */
export function useSignAndExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient() as unknown as SuiJsonRpcClient;
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();
  return useMutation({
    mutationFn: async (input: { transaction: Transaction }) => {
      if (zk.address) {
        const keypair = await enokiFlow.getKeypair({ network: ENOKI_NETWORK });
        input.transaction.setSenderIfNotSet(zk.address);
        return await client.signAndExecuteTransaction({
          transaction: input.transaction,
          signer: keypair,
          options: { showEffects: true, showEvents: true },
        });
      }
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
 * the user only signs. A Google (zkLogin) session signs the sponsored bytes
 * with the Enoki keypair; a wallet signs via dapp-kit. Throws if the user
 * hasn't signed in.
 */
export function useSponsorAndExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();
  return useMutation({
    mutationFn: async (input: { transaction: Transaction; sender: string }) => {
      return sponsorAndExecute({
        transaction: input.transaction,
        sender: input.sender,
        suiClient: client,
        signTransactionBytes: async (bytes) => {
          if (zk.address) {
            const keypair = await enokiFlow.getKeypair({ network: ENOKI_NETWORK });
            const { signature } = await keypair.signTransaction(bytes);
            return { signature };
          }
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
