// HostIt MemWal — client-safe canonical auth challenge.
//
// NO `server-only` import and no heavy deps, so BOTH the browser
// (lib/memoryClient.ts) and the server (lib/memwalAuth.ts) can import the exact
// same byte-for-byte challenge builder. This MUST stay split out of the
// server-only memwalAuth.ts: pulling that module into the client bundle fails
// `next build` with a "server-only" webpack error. The server and client MUST
// agree byte-for-byte on the challenge, which is why it lives in one place.

/** Domain/intent tag for the personal-message challenge. Bump to invalidate. */
export const MEMORY_CHALLENGE_DOMAIN = "HostIt-MemWal:auth:v1";

/** Replay window: a signed challenge older than this is rejected (server-side). */
export const MEMORY_CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

/** Reject timestamps too far in the future (clock-skew tolerance). */
export const MEMORY_CHALLENGE_FUTURE_SKEW_MS = 60 * 1000; // 1 minute

/** The canonical challenge string a client signs as a personal message. */
export function buildMemoryChallenge(owner: string, tsMs: number): string {
  return `${MEMORY_CHALLENGE_DOMAIN}\nowner=${owner}\nts=${tsMs}`;
}
