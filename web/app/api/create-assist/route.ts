// HostIt — "Draft with AI" for the create-event wizard (GH#19).
//
// Server-only route. Given the in-progress event form context (ctx), it returns
// ONE concise event description. When the organizer is signed in AND the memory
// layer is on, it grounds the draft in the organizer's recalled create-prefs
// (category/city/venue/price/capacity) so repeat hosts get on-brand copy.
//
// Mirrors /api/copilot exactly where it can:
//   - Groq (llama-3.3-70b-versatile) via the OpenAI-compatible API, model from
//     GROQ_MODEL, key GROQ_API_KEY.
//   - A deterministic, ctx-aware FALLBACK when no key is set, so the feature is
//     functional out of the box.
//   - Per-IP fixed-window rate limit + a raw-body byte cap (cost-amplification
//     surface: unauthenticated edge that fans out to an LLM).
//
// AUTH (optional, never blocking): the request MAY carry the SAME signed envelope
// /api/memory/recall uses { owner, message, signature } (buildMemoryChallenge).
// Memory is a READ-ONLY enrichment here, so any failure — memory disabled, no/bad
// envelope, auth error, or relayer error — is SWALLOWED and we proceed with no
// memories. The route ALWAYS returns a form-only draft rather than 4xx/5xx.

import {
  recallOrganizerMemory,
  memwalEnabled,
  isMemwalDisabled,
  type RecallOutcome,
} from "@/lib/memwal";
import { verifyMemoryCaller } from "@/lib/memwalAuth";
import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";
import { verifyTurnstile, blockedByTurnstile } from "@/lib/turnstile";
import { coerceSuggestion, pickFallback, SUGGEST_CATEGORIES } from "@/lib/suggest";

export const dynamic = "force-dynamic";

const MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

// The recall query for THIS route. Defined locally per spec (the create-wizard's
// CREATE_MEMORY_QUERY in lib/createMemory.ts targets structured suggestions; here
// we want free-text prefs to ground a description, so we keep our own phrasing).
const CREATE_ASSIST_QUERY =
  "event creation preferences and style: category, city, venue, pricing, capacity, tone";

/** The in-progress create-form context the client sends. All fields optional but name. */
interface CreateCtx {
  name: string;
  category?: string;
  venue?: string;
  city?: string;
  date?: string;
  tag?: string;
}

// --- limits (mirror /api/copilot) -------------------------------------------

// Per-IP rate limit before any LLM/relayer fan-out (429 + Retry-After on breach).
// Keyed on IP only since the signed identity is OPTIONAL on this route.
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
// Body byte cap: reject oversized payloads before parsing/LLM (413). The signed
// envelope (message + signature) dominates the body; 32 KB is generous.
const MAX_BODY_BYTES = 32 * 1024;

// ctx string fields truncated to bound prompt-injection blast radius.
const MAX_CTX_STR_LEN = 200;
// Cap injected memory so a large recall can't blow up the prompt / token cost.
const MAX_MEMORY_ITEMS = 6;
const MAX_MEMORY_ITEM_LEN = 500;

function clampStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.slice(0, MAX_CTX_STR_LEN).trim();
  return t || undefined;
}

// Coerce/whitelist the client-supplied ctx into a fresh object containing ONLY
// the known fields, so unknown keys / overlong values never reach the prompt.
// `name` falls back to a neutral placeholder so the draft never reads as blank.
function sanitizeCtx(raw: unknown): CreateCtx {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: CreateCtx = { name: clampStr(r.name) ?? "Your event" };
  const category = clampStr(r.category);
  if (category !== undefined) out.category = category;
  const venue = clampStr(r.venue);
  if (venue !== undefined) out.venue = venue;
  const city = clampStr(r.city);
  if (city !== undefined) out.city = city;
  const date = clampStr(r.date);
  if (date !== undefined) out.date = date;
  const tag = clampStr(r.tag);
  if (tag !== undefined) out.tag = tag;
  return out;
}

// --- prompt + fallback -------------------------------------------------------

function systemPrompt(ctx: CreateCtx, memory: string[]): string {
  const lines = [
    "You are HostIt's event copywriter. Write ONE compelling event description from",
    "the organizer's draft details. Constraints:",
    "- 60-90 words, a single flowing paragraph (no headings, no bullet lists).",
    "- Plain text only: NO markdown, NO emoji, NO hashtags, NO quotes around the text.",
    "- Ground every claim in the provided details; never invent a price, lineup,",
    "  speaker, time, or fact that is not given.",
    "- Lead with what the event is and who it's for; close with a light call to action.",
    "",
    `EVENT DRAFT: ${JSON.stringify(ctx)}`,
  ];
  if (memory.length) {
    lines.push(
      "",
      "ORGANIZER STYLE (preferences this organizer remembered from past events —",
      "use as background to match their tone/positioning; defer to EVENT DRAFT on",
      "any conflict, and do NOT copy past event names or specifics):",
      ...memory.map((m) => `- ${m}`),
    );
  }
  return lines.join("\n");
}

// Deterministic, ctx-aware draft used when GROQ_API_KEY is unset or Groq errors.
// Composes a sensible single-paragraph description from ctx, lightly seasoned by
// any recalled memory hints (kept generic so we never assert unverified facts).
function fallback(ctx: CreateCtx, memory: string[]): string {
  const kind = ctx.category ? ctx.category.toLowerCase() : "event";
  const where = [ctx.venue, ctx.city].filter(Boolean).join(", ");
  const when = ctx.date ? ` on ${ctx.date}` : "";
  const place = where ? ` at ${where}` : "";
  const hint = memory.length
    ? " Expect the thoughtful, well-run experience this organizer is known for."
    : "";
  const tag = ctx.tag ? ` ${ctx.tag.trim()}` : "";

  return (
    `${ctx.name} is a ${kind} happening${when}${place}.` +
    ` Join us for a memorable gathering built around great people and a shared moment worth showing up for.` +
    hint +
    ` Tickets are on-chain for instant, fraud-proof entry — secure your spot before it's gone.` +
    tag
  ).trim();
}

// Extract up to N plaintext memory lines from a recall outcome, defensively.
function memoryLinesFrom(result: RecallOutcome): string[] {
  if (isMemwalDisabled(result)) return [];
  const results = result.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((m) => m?.text)
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .slice(0, MAX_MEMORY_ITEMS)
    .map((t) => t.trim().slice(0, MAX_MEMORY_ITEM_LEN));
}

// --- "Suggest" mode (#93): invent a full FUNNY event concept --------------

const SUGGEST_SYSTEM = [
  "You are HostIt's mischievous event generator for a permissionless on-chain",
  "ticketing app. Invent ONE short, FUNNY, lightly SARCASTIC but plausible event.",
  "Rules:",
  `- category MUST be exactly one of: ${SUGGEST_CATEGORIES.join(", ")}.`,
  "- Humor = self-deprecating crypto / tech / event in-jokes. Clever, not crude.",
  "- NEVER reference real or identifiable people, companies, or brands. No slurs,",
  "  no NSFW, no harassment, no protected-class jokes, no politics, no real tragedies.",
  "- Invent a fun fake venue and a real-ish city. Keep numbers small and sane.",
  "- Return ONLY a JSON object (no prose, no markdown) with these keys:",
  '  name (string <=80 chars), category, tag (string <=24 chars, a funny label),',
  "  venue, city, description (1-2 sentences <=300 chars, plain text, no emoji/hashtags),",
  '  free (boolean), price (number, only if not free; small, 1-50), coin ("SUI" or "USDC"),',
  "  capacity (integer 20-500), maxPerUser (integer 1-10).",
].join("\n");

/** Parse a model reply into an object: strict JSON first, then a braces-extract fallback. */
function parseSuggestJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Generate a funny event concept. A blocked bot-check or any Groq failure returns
 * the FREE curated fallback (never the paid model), so the button always works.
 */
async function suggestResponse(token: string | undefined, ip: string): Promise<Response> {
  if (blockedByTurnstile(await verifyTurnstile(token, ip))) {
    return Response.json({ suggestion: pickFallback(), sourced: "fallback" });
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ suggestion: pickFallback(), sourced: "fallback" });
  }
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 320,
        temperature: 1.1, // a little wild — funnier, more varied on reroll
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SUGGEST_SYSTEM },
          { role: "user", content: "Generate the event now. Return ONLY the JSON object." },
        ],
      }),
    });
    if (!r.ok) return Response.json({ suggestion: pickFallback(), sourced: "fallback" });
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    // Coerce the UNTRUSTED model output to a safe, in-range shape; fall back if invalid.
    const coerced = coerceSuggestion(parseSuggestJson(j.choices?.[0]?.message?.content ?? ""));
    return Response.json(
      coerced
        ? { suggestion: coerced, sourced: "groq" }
        : { suggestion: pickFallback(), sourced: "fallback" },
    );
  } catch {
    return Response.json({ suggestion: pickFallback(), sourced: "fallback" });
  }
}

export async function POST(req: Request) {
  // Byte-cap the raw payload BEFORE parsing (413 on oversize). Content-Length
  // lets us short-circuit; otherwise measure the decoded body.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_BYTES} bytes` },
      { status: 413 },
    );
  }

  let body: {
    kind?: string;
    ctx?: unknown;
    owner?: string;
    message?: string;
    signature?: string;
    turnstileToken?: string;
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Per-IP rate limit before any LLM/relayer fan-out (429 + Retry-After).
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`create-assist:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // "Suggest" mode (#93) — invent a full funny event concept. No ctx/memory; the
  // same rate-limit + Turnstile bot-wall guard it as the description draft below.
  if (body.kind === "suggest") {
    return suggestResponse(body.turnstileToken, ip);
  }

  // Whitelist/sanitize ctx into a fresh object before it reaches the prompt.
  const ctx = sanitizeCtx(body.ctx);

  // Bot-wall: a failed Turnstile challenge gets the FREE local fallback (and
  // skips the memory recall below), never the paid Groq model. CF outage fails
  // OPEN to Groq. Enforced only when a secret is set. (#81)
  if (blockedByTurnstile(await verifyTurnstile(body.turnstileToken, ip))) {
    return Response.json({ description: fallback(ctx, []), sourced: "fallback" });
  }

  // OPTIONAL memory enrichment. Only attempt when a full signed envelope is
  // present AND the layer is on. ANY failure (auth, recall, relayer) is swallowed
  // — reading nothing is safe and must never block the draft.
  let memory: string[] = [];
  if (body.owner && body.message && body.signature && memwalEnabled()) {
    try {
      const owner = await verifyMemoryCaller({
        owner: body.owner,
        message: body.message,
        signature: body.signature,
      });
      const result = await recallOrganizerMemory(owner, CREATE_ASSIST_QUERY, {
        limit: MAX_MEMORY_ITEMS,
      });
      memory = memoryLinesFrom(result);
    } catch {
      // Swallow: never block the draft on a memory/auth failure.
      memory = [];
    }
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ description: fallback(ctx, memory), sourced: "fallback" });
  }

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [
          { role: "system", content: systemPrompt(ctx, memory) },
          {
            role: "user",
            content:
              "Write the event description now. Return ONLY the description text — " +
              "60-90 words, one paragraph, plain text, no markdown or quotes.",
          },
        ],
      }),
    });
    if (!r.ok) {
      return Response.json({ description: fallback(ctx, memory), sourced: "fallback" });
    }
    const j = (await r.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const out = (j.choices?.[0]?.message?.content ?? "").trim();
    return Response.json(
      out
        ? { description: out, sourced: "groq" }
        : { description: fallback(ctx, memory), sourced: "fallback" },
    );
  } catch {
    return Response.json({ description: fallback(ctx, memory), sourced: "fallback" });
  }
}
