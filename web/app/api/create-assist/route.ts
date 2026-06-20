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
    ctx?: unknown;
    owner?: string;
    message?: string;
    signature?: string;
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

  // Whitelist/sanitize ctx into a fresh object before it reaches the prompt.
  const ctx = sanitizeCtx(body.ctx);

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
