// Shared email canonicalization — imported IDENTICALLY by client and server.
// A mismatch between the two is the universal one-account-one-email bypass, so
// this is the SINGLE source of truth (server HMACs the result; client may
// pre-validate). It folds the trivial duplicates (case, gmail dots, +tags); it
// does NOT pretend to be sybil-proof (documented in the #96 issue).

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Canonicalize an email for hashing/uniqueness. Lowercases + trims, strips a
 * `+tag` (all providers), and folds gmail dots + googlemail→gmail. Returns ""
 * when the input isn't a usable address (caller treats "" as invalid).
 */
export function canonicalizeEmail(raw: string): string {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return ""; // need a local part and a domain
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain.includes("..") || domain.startsWith(".") || domain.endsWith(".") || !domain.includes("."))
    return "";
  // Strip a "+tag" suffix on the local part (sub-addressing).
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  // Gmail: dots in the local part are insignificant; googlemail.com == gmail.com.
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  if (!local) return "";
  return `${local}@${domain}`;
}

/** Cheap shape check (not RFC-complete) for input validation before canonicalizing. */
export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}
