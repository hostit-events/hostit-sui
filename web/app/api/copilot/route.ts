// HostIt Co-pilot — Groq (OpenAI-compatible API) grounded in the organizer's
// live event numbers. Falls back to a deterministic, data-aware answer when no
// API key is set, so the feature is functional out of the box.

import { rateLimit, clientIpFromHeaders } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

interface EventCtx {
  name?: string;
  status?: string;
  date?: string;
  city?: string;
  venue?: string;
  category?: string;
  sold?: number;
  cap?: number;
  pct?: number;
  revenue?: string;
  views?: number;
  priceLabel?: string;
}
interface Msg {
  role: "user" | "assistant";
  content: string;
}

function systemPrompt(ev: EventCtx, memory: string[]): string {
  const lines = [
    "You are HostIt Co-pilot, an expert assistant for event organizers on the HostIt platform.",
    "You are grounded in this event's LIVE numbers. Never invent data beyond what is provided.",
    "Be practical, specific and actionable. Prefer short paragraphs and tight bullet lists. No emoji.",
    "",
    `EVENT CONTEXT: ${JSON.stringify(ev)}`,
  ];
  if (memory.length) {
    lines.push(
      "",
      "PAST CONTEXT (facts this organizer chose to remember from earlier sessions —",
      "treat as helpful background, not as live event data; defer to EVENT CONTEXT on conflict):",
      ...memory.map((m) => `- ${m}`),
    );
  }
  return lines.join("\n");
}

function fallback(ev: EventCtx, messages: Msg[]): string {
  const q = (messages[messages.length - 1]?.content ?? "").toLowerCase();
  const sold = ev.sold ?? 0;
  const cap = ev.cap ?? 0;
  const pct = ev.pct ?? (cap ? Math.round((sold / cap) * 100) : 0);
  if (q.includes("announce")) {
    return `Here's a launch post for **${ev.name ?? "your event"}**:\n\n"${ev.name ?? "We're live"} — ${ev.date ?? "soon"} at ${ev.venue ?? "the venue"}. ${pct >= 60 ? "Going fast — over half gone." : "Early-bird pricing is live."} Grab your spot before it's gone."\n\nKeep it to 2 lines for social; lead with the date and a scarcity cue.`;
  }
  if (q.includes("slow") || q.includes("why")) {
    return `At ${pct}% sold (${sold.toLocaleString()}/${cap.toLocaleString()}), a few likely levers:\n\n- **Top of funnel** — ${ev.views ?? 0} page views; if low, push the shareable event link in 2-3 channels this week.\n- **Price anchor** — ${ev.priceLabel ?? "your price"} may need an early-bird tier to create urgency.\n- **Proof** — add lineup/agenda detail; concrete programming converts browsers to buyers.`;
  }
  if (q.includes("pric")) {
    return `With ${pct}% sold, consider:\n\n- Hold current price; add a **VIP tier (+60-120%)** for superfans.\n- If demand is hot (>70%), open a **second release** slightly above current price.\n- Keep a small **early-bird** allocation to seed momentum.`;
  }
  if (q.includes("describ") || q.includes("polish")) {
    return `Punchier description (<60 words):\n\n"${ev.name ?? "An unmissable night"} lands ${ev.date ?? "soon"} at ${ev.venue ?? "the venue"}${ev.city ? `, ${ev.city}` : ""}. ${ev.category ?? "A standout"} experience, on-chain tickets, instant entry. Limited capacity — secure yours."`;
  }
  return `Here's where ${ev.name ?? "your event"} stands: **${pct}% sold** (${sold.toLocaleString()}/${cap.toLocaleString()})${ev.revenue ? `, ${ev.revenue} gross` : ""}. Ask me to draft an announcement, analyze slow sales, suggest pricing, or polish your description.\n\n(Set GROQ_API_KEY for full AI answers.)`;
}

// Cap injected memory so a large recall can't blow up the prompt / token cost.
const MAX_MEMORY_ITEMS = 6;
const MAX_MEMORY_ITEM_LEN = 500;

// Per-IP rate limit (this route is unauthenticated and fans out to Groq's LLM,
// so it is a cost-amplification surface). Mirrors the /api/memory limiter usage,
// but keyed on IP only since there is no verified identity here.
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
// Body byte cap: reject oversized payloads before parsing/LLM (413). The prompt
// is dominated by the messages array + event context; 32 KB is generous for chat.
const MAX_BODY_BYTES = 32 * 1024;

// String fields on EventCtx are truncated to this length to bound prompt-injection
// blast radius (an attacker can't smuggle a long instruction via a context field).
const MAX_EV_STR_LEN = 200;

// Each chat message's content is clamped to bound the prompt-injection blast
// radius and token cost per turn (the event-context strings are clamped the
// same way via MAX_EV_STR_LEN). The 32 KB whole-body cap is a coarse outer
// bound; this is the per-message bound.
export const MAX_MSG_CONTENT_LEN = 2000;

// Stable, generic client-facing error code. Distinguishes a fallback caused by
// an upstream/runtime error from a fallback caused by no GROQ_API_KEY, WITHOUT
// leaking upstream detail. Detail is logged server-side only.
const ERR_UPSTREAM = "copilot_upstream_error";

function clampStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.slice(0, MAX_EV_STR_LEN);
}

// Whitelist each incoming chat turn into a fresh { role, content } object,
// dropping malformed entries and clamping content length. Mirrors the
// coerce-into-a-fresh-object posture of sanitizeEvent().
export function sanitizeMessages(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) return [];
  const out: Msg[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string") continue;
    out.push({ role, content: content.slice(0, MAX_MSG_CONTENT_LEN) });
  }
  return out;
}
function clampNum(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Coerce/whitelist the client-supplied event into a fresh object containing ONLY
// the known EventCtx fields, so unknown keys (and overlong/typed-wrong values)
// never reach systemPrompt(). Undefined fields are dropped to keep the prompt JSON
// tight.
function sanitizeEvent(raw: unknown): EventCtx {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: EventCtx = {};
  const name = clampStr(r.name);
  if (name !== undefined) out.name = name;
  const status = clampStr(r.status);
  if (status !== undefined) out.status = status;
  const date = clampStr(r.date);
  if (date !== undefined) out.date = date;
  const city = clampStr(r.city);
  if (city !== undefined) out.city = city;
  const venue = clampStr(r.venue);
  if (venue !== undefined) out.venue = venue;
  const category = clampStr(r.category);
  if (category !== undefined) out.category = category;
  const revenue = clampStr(r.revenue);
  if (revenue !== undefined) out.revenue = revenue;
  const priceLabel = clampStr(r.priceLabel);
  if (priceLabel !== undefined) out.priceLabel = priceLabel;
  const sold = clampNum(r.sold);
  if (sold !== undefined) out.sold = sold;
  const cap = clampNum(r.cap);
  if (cap !== undefined) out.cap = cap;
  const pct = clampNum(r.pct);
  if (pct !== undefined) out.pct = pct;
  const views = clampNum(r.views);
  if (views !== undefined) out.views = views;
  return out;
}

export async function POST(req: Request) {
  // Byte cap the raw payload BEFORE parsing (413 on oversize). A Content-Length
  // header lets us short-circuit; otherwise we measure the decoded body.
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

  let body: { event?: EventCtx; messages?: Msg[]; memory?: unknown };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Per-IP rate limit before any LLM fan-out (429 + Retry-After on breach).
  const ip = clientIpFromHeaders(req.headers);
  const rl = rateLimit(`copilot:ip:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  // Prompt-injection hardening: coerce/whitelist the client event into a fresh
  // object of ONLY the known EventCtx fields (numerics via Number(), strings
  // truncated) before it reaches systemPrompt().
  const ev = sanitizeEvent(body.event);
  const messages = sanitizeMessages(body.messages).slice(-12);
  // Recalled organizer memory passed by the client (already namespace-scoped &
  // signature-verified server-side at /api/memory/recall). Sanitize defensively.
  const memory = Array.isArray(body.memory)
    ? body.memory
        .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        .slice(0, MAX_MEMORY_ITEMS)
        .map((m) => m.trim().slice(0, MAX_MEMORY_ITEM_LEN))
    : [];
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) return Response.json({ reply: fallback(ev, messages), sourced: "fallback" });

  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        messages: [
          { role: "system", content: systemPrompt(ev, memory) },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error(`[copilot] groq upstream ${r.status}: ${detail.slice(0, 500)}`);
      return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: ERR_UPSTREAM });
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = (j.choices?.[0]?.message?.content ?? "").trim();
    return Response.json({ reply: reply || fallback(ev, messages), sourced: "groq" });
  } catch (e: unknown) {
    console.error("[copilot] groq request failed:", e);
    return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: ERR_UPSTREAM });
  }
}
