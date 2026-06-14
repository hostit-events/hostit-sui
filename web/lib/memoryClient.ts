"use client";

// HostIt MemWal — CLIENT caller for the /api/memory/* routes (GH#19).
//
// This is the missing browser half of the memory layer. The server routes
// (lib/memwalAuth.ts) require the caller to PROVE control of `owner` by signing
// a canonical challenge as a PERSONAL MESSAGE. This module:
//   1. builds the exact byte-for-byte challenge via buildMemoryChallenge (the
//      same builder the server re-parses — they MUST agree byte-for-byte),
//   2. signs the UTF-8 bytes with the CONNECTED account's key (zkLogin/Enoki or
//      an external wallet — mirrors lib/hooks.ts useSignAndExecute branching),
//   3. POSTs { owner, message, signature, ...payload } to recall / remember.
//
// SECURITY: no secret is ever handled here. The MemWal DELEGATE key is
// server-only (lib/memwal.ts). The client only ever signs with the USER's own
// key, proving ownership of their namespace — nothing more.
//
// GRACEFUL DISABLE: the routes return { disabled: true } when the server-side
// layer is off (missing MEMWAL_* env). Callers treat that as "memory off" and
// no-op. With no connected wallet we never sign or call at all.

import { useCallback, useEffect, useState } from "react";
import {
  useCurrentAccount as useDAppKitAccount,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import { useEnokiFlow, useZkLogin } from "@mysten/enoki/react";
import { buildMemoryChallenge } from "@/lib/memwalAuth";
import { ENOKI_NETWORK } from "@/lib/auth";

/** A single recalled organizer memory (mirrors the relayer's RecallMemory). */
export interface RecalledMemory {
  blob_id: string;
  text: string;
  distance: number;
}

/** Shape returned by /api/memory/recall when the layer is enabled. */
interface RecallResponse {
  results?: RecalledMemory[];
  total?: number;
}

/** Shape returned by any /api/memory/* route when the server layer is off. */
interface DisabledResponse {
  disabled: true;
  reason?: string;
}

function isDisabled(v: unknown): v is DisabledResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as DisabledResponse).disabled === true
  );
}

/**
 * The signed-request envelope every /api/memory/* route requires. `owner` is the
 * connected address; `message` is the canonical challenge; `signature` is the
 * personal-message signature over its UTF-8 bytes.
 */
interface SignedEnvelope {
  owner: string;
  message: string;
  signature: string;
}

// Cheap, UNSIGNED probe of whether the SERVER memory layer is configured
// (MEMWAL_* env present). Lets the UI avoid prompting for a signature when memory
// is off. Memoized so it runs at most once per page load, shared across hooks.
let serverEnabledPromise: Promise<boolean> | null = null;
function fetchServerEnabled(): Promise<boolean> {
  if (!serverEnabledPromise) {
    serverEnabledPromise = fetch("/api/memory/status")
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j) => !!(j as { enabled?: boolean }).enabled)
      .catch(() => false);
  }
  return serverEnabledPromise;
}

/**
 * Client hook for the organizer memory routes. Returns:
 *  - `enabled`: memory features are live — a wallet is connected AND the server
 *    layer is configured (unsigned /api/memory/status probe). Gating on this means
 *    the UI never prompts for a wasted signature (e.g. recall-on-open) when off.
 *  - `recall(query, limit?)`: sign + POST /api/memory/recall. Returns the recalled
 *    memories, or `null` when memory is off / no wallet / on error (callers treat
 *    null as "no memory available" and degrade gracefully).
 *  - `remember(text)`: sign + POST /api/memory/remember. Returns true on accept,
 *    false when off / no wallet, and throws on a hard error so the UI can show it.
 *
 * Each call signs ONE fresh challenge (Date.now() timestamp, ~5 min server replay
 * window). For zkLogin/Enoki sessions the signature is produced with the Enoki
 * keypair (no wallet popup); for external wallets it triggers the wallet's
 * personal-message prompt. This per-call signing is intentional for v1; a
 * session-token scheme to avoid re-signing is deferred (ties to KV work, GH#17).
 */
export function useOrganizerMemory() {
  const dAppKit = useDAppKit();
  const wallet = useDAppKitAccount();
  const enokiFlow = useEnokiFlow();
  const zk = useZkLogin();

  const owner = zk.address ?? wallet?.address ?? null;

  // `enabled` requires BOTH a connected wallet AND the server layer actually being
  // on (unsigned /api/memory/status probe) — so the UI (recall-on-open, "Remember")
  // never prompts the user for a signature when memory is disabled server-side.
  const [serverEnabled, setServerEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    fetchServerEnabled().then((e) => {
      if (live) setServerEnabled(e);
    });
    return () => {
      live = false;
    };
  }, []);
  const enabled = !!owner && serverEnabled;

  /**
   * Build + sign the canonical challenge for `owner`. Mirrors lib/hooks.ts:
   * zkLogin signs with the Enoki keypair; an external wallet signs via dapp-kit's
   * CurrentAccountSigner. Returns the full signed envelope.
   */
  const signEnvelope = useCallback(
    async (ownerAddr: string): Promise<SignedEnvelope> => {
      const message = buildMemoryChallenge(ownerAddr, Date.now());
      const bytes = new TextEncoder().encode(message);
      let signature: string;
      if (zk.address) {
        const keypair = await enokiFlow.getKeypair({ network: ENOKI_NETWORK });
        ({ signature } = await keypair.signPersonalMessage(bytes));
      } else {
        const signer = new CurrentAccountSigner(dAppKit);
        ({ signature } = await signer.signPersonalMessage(bytes));
      }
      return { owner: ownerAddr, message, signature };
    },
    [zk.address, enokiFlow, dAppKit],
  );

  const recall = useCallback(
    async (query: string, limit?: number): Promise<RecalledMemory[] | null> => {
      if (!owner) return null;
      const q = query.trim();
      if (!q) return null;
      try {
        const envelope = await signEnvelope(owner);
        const res = await fetch("/api/memory/recall", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...envelope, query: q, limit }),
        });
        if (!res.ok) return null; // 401/429/500 → degrade silently (no memory)
        const j = (await res.json()) as RecallResponse | DisabledResponse;
        if (isDisabled(j)) return null; // server layer off
        return j.results ?? [];
      } catch {
        // Signing rejected, network error, etc. — recall is best-effort grounding.
        return null;
      }
    },
    [owner, signEnvelope],
  );

  const remember = useCallback(
    async (text: string): Promise<boolean> => {
      if (!owner) return false;
      const t = text.trim();
      if (!t) return false;
      const envelope = await signEnvelope(owner);
      const res = await fetch("/api/memory/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...envelope, text: t }),
      });
      const j = (await res.json().catch(() => ({}))) as
        | DisabledResponse
        | { error?: string };
      if (isDisabled(j)) return false; // server layer off — treat as no-op
      if (!res.ok) {
        const msg =
          (j as { error?: string }).error ??
          `Could not save memory (${res.status}).`;
        throw new Error(msg);
      }
      return true;
    },
    [owner, signEnvelope],
  );

  return { enabled, owner, recall, remember };
}
