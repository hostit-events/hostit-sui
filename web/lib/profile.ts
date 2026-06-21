"use client";

// Account profile (GH#96): a small JSON envelope on Walrus, located by the
// non-sensitive `profile:<addr> → blobId` KV pointer (web/app/api/identity/
// profile-pointer). Holds the display username, avatar blob, and the email
// binding metadata (the email ciphertext itself is a separate Seal blob). Reads
// are cached + degrade to null (→ suiNS/identicon fallback) on any failure, so
// profiles never block rendering.

import { useQuery } from "@tanstack/react-query";
import { readJson, blobUrl } from "./walrus";
import { useSuiNSName } from "./suins";

export interface ProfileEnvelope {
  v: 1;
  username?: string;
  avatarBlobId?: string;
  location?: string;
  /** Walrus blob id of the Seal-encrypted email envelope (EMAIL_NS_TAG ‖ addr). */
  emailBlobId?: string;
  emailHashVersion?: number;
  emailSource?: "google" | "wallet";
  /** Opt-in: discoverable by an exact email-hash lookup (v2 search). */
  discoverableByEmail?: boolean;
}

async function fetchPointer(address: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/identity/profile-pointer?address=${encodeURIComponent(address)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { blobId?: string | null };
    return j.blobId ?? null;
  } catch {
    return null;
  }
}

/** Read an address's profile envelope (pointer → Walrus). null when none/failed. */
export function useProfile(address: string | null | undefined) {
  return useQuery<ProfileEnvelope | null, Error>({
    queryKey: ["profile", address],
    enabled: Boolean(address),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    queryFn: async () => {
      if (!address) return null;
      const blobId = await fetchPointer(address);
      if (!blobId) return null;
      try {
        const env = await readJson<ProfileEnvelope>(blobId);
        return env && env.v === 1 ? env : null;
      } catch {
        return null;
      }
    },
  });
}

/**
 * Display name precedence: a provided profile username → the suiNS reverse name →
 * null (caller shows truncated hex). `isSuiNS` distinguishes the *verified* suiNS
 * trust badge from a free-form (uncredentialed) username, which gets no tick.
 */
export function useDisplayName(address: string | null | undefined): {
  data: string | null;
  isLoading: boolean;
  isSuiNS: boolean;
} {
  const prof = useProfile(address);
  const suins = useSuiNSName(address);
  const username = prof.data?.username?.trim();
  if (username) return { data: username, isLoading: false, isSuiNS: false };
  return {
    data: suins.data ?? null,
    isLoading: suins.isLoading || prof.isLoading,
    isSuiNS: Boolean(suins.data),
  };
}

/**
 * Avatar URL for an address: an uploaded profile avatar (public Walrus blob) →
 * null (caller renders a deterministic seeded fallback). suiNS avatar records
 * are a v2 nicety (need an extra getNameRecord + NFT-image resolve).
 */
export function useProfilePicture(address: string | null | undefined): {
  url: string | null;
  isLoading: boolean;
} {
  const prof = useProfile(address);
  const blob = prof.data?.avatarBlobId;
  return { url: blob ? blobUrl(blob) : null, isLoading: prof.isLoading };
}
