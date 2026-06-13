// HostIt MemWal — "organizer memory" layer (Phase 1, GH#15).
//
// SERVER-ONLY module. It reads the Ed25519 DELEGATE private key from the
// environment, so it must never be bundled into client code. The `server-only`
// import below makes Next.js fail the build if this file is ever imported from a
// Client Component. The browser reaches this layer ONLY through the
// /api/memory/* route handlers.
//
// Architecture (forced by a single shared server-side delegate key): ONE HostIt
// MemWal account; per-organizer isolation via `namespace = org:<owner address>`.
// Routes receive the organizer `owner` Sui address from the client and map it to
// the namespace here, server-side.
//
// Mode: RELAYER ONLY. The relayer (a TEE host) does embedding + SEAL encryption +
// Walrus storage server-side, so this layer does NOT touch lib/walrus.ts or
// lib/seal.ts. We import ONLY the base entry of @mysten-incubation/memwal — never
// the '/manual', '/ai', or '/account' sub-paths (those pull in @mysten/walrus /
// ai / extra deps that are not installed).
//
// GRACEFUL DISABLE: if MEMWAL_DELEGATE_KEY or MEMWAL_ACCOUNT_ID is unset the layer
// no-ops with a clear "disabled" result instead of throwing — mirroring the
// copilot route's deterministic fallback. This is required today because Phase 0
// (creating the on-chain MemWalAccount) is not done yet, so MEMWAL_ACCOUNT_ID may
// be unset; the scaffold must still tsc + run.

import "server-only";
import { MemWal } from "@mysten-incubation/memwal";
import type {
  RememberAcceptedResult,
  RecallResult,
  RecallOptions,
  AnalyzeResult,
  AnalyzeOptions,
} from "@mysten-incubation/memwal";
import { MEMWAL_RELAYER_URL } from "@/lib/config";

/** A no-op result returned whenever the memory layer is disabled (missing env). */
export interface MemwalDisabled {
  disabled: true;
  reason: string;
}

export type RememberOutcome = RememberAcceptedResult | MemwalDisabled;
export type RecallOutcome = RecallResult | MemwalDisabled;
export type AnalyzeOutcome = AnalyzeResult | MemwalDisabled;

const DISABLED_REASON =
  "MemWal memory is disabled: set MEMWAL_DELEGATE_KEY and MEMWAL_ACCOUNT_ID (server-only).";

/**
 * True only when BOTH the delegate key AND the on-chain account id are set.
 * Read at call time (not module load) so env changes are picked up and import
 * never throws.
 */
export function memwalEnabled(): boolean {
  return (
    !!process.env.MEMWAL_DELEGATE_KEY && !!process.env.MEMWAL_ACCOUNT_ID
  );
}

function disabled(): MemwalDisabled {
  return { disabled: true, reason: DISABLED_REASON };
}

/** Map an organizer Sui address to its isolated memory namespace. */
function orgNamespace(owner: string): string {
  return `org:${owner}`;
}

/**
 * Lazily construct a MemWal relayer client. Throws only when called while the
 * layer is disabled — callers must gate on `memwalEnabled()` first (the helpers
 * below do). A fresh client is created per call; relayer mode is stateless aside
 * from the short-lived SEAL session the SDK builds internally.
 */
export function getMemWal(): MemWal {
  if (!memwalEnabled()) {
    // Defensive: callers gate on memwalEnabled() and never reach this.
    throw new Error(DISABLED_REASON);
  }
  return MemWal.create({
    key: process.env.MEMWAL_DELEGATE_KEY!,
    accountId: process.env.MEMWAL_ACCOUNT_ID!,
    // NOTE (unresolved): env MEMWAL_RELAYER_URL may differ from the SDK default
    // (`relayer.memwal.ai`). When unset we fall through to the SDK default. See
    // config.ts + .env.local.example for the host-mismatch flag.
    serverUrl: MEMWAL_RELAYER_URL || undefined,
  });
}

/**
 * Remember a single organizer fact (background job — returns once accepted).
 * No-ops with a disabled result when the layer is off.
 */
export async function rememberOrganizerFact(
  owner: string,
  text: string,
): Promise<RememberOutcome> {
  if (!memwalEnabled()) return disabled();
  const memwal = getMemWal();
  try {
    return await memwal.remember(text, orgNamespace(owner));
  } finally {
    memwal.destroy();
  }
}

/**
 * Recall organizer memories most similar to `query` within the organizer's
 * namespace. No-ops with a disabled result when the layer is off.
 */
export async function recallOrganizerMemory(
  owner: string,
  query: string,
  opts?: Omit<RecallOptions, "namespace">,
): Promise<RecallOutcome> {
  if (!memwalEnabled()) return disabled();
  const memwal = getMemWal();
  try {
    return await memwal.recall({
      query,
      ...opts,
      namespace: orgNamespace(owner),
    });
  } finally {
    memwal.destroy();
  }
}

/**
 * Analyze organizer conversation text — server-side LLM fact extraction, then
 * each fact embedded/encrypted/stored in the background. No-ops with a disabled
 * result when the layer is off.
 */
export async function analyzeOrganizerConversation(
  owner: string,
  text: string,
  opts?: Omit<AnalyzeOptions, "namespace">,
): Promise<AnalyzeOutcome> {
  if (!memwalEnabled()) return disabled();
  const memwal = getMemWal();
  try {
    return await memwal.analyze(text, {
      ...opts,
      namespace: orgNamespace(owner),
    });
  } finally {
    memwal.destroy();
  }
}

/** Narrowing helper for route handlers / callers. */
export function isMemwalDisabled(
  v: RememberOutcome | RecallOutcome | AnalyzeOutcome,
): v is MemwalDisabled {
  return (v as MemwalDisabled).disabled === true;
}
