// HostIt Co-pilot — Anthropic Claude grounded in the organizer's live event
// numbers. Falls back to a deterministic, data-aware answer when no API key is
// set, so the feature is functional out of the box.

export const dynamic = "force-dynamic";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

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

function systemPrompt(ev: EventCtx): string {
  return [
    "You are HostIt Co-pilot, an expert assistant for event organizers on the HostIt platform.",
    "You are grounded in this event's LIVE numbers. Never invent data beyond what is provided.",
    "Be practical, specific and actionable. Prefer short paragraphs and tight bullet lists. No emoji.",
    "",
    `EVENT CONTEXT: ${JSON.stringify(ev)}`,
  ].join("\n");
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
  return `Here's where ${ev.name ?? "your event"} stands: **${pct}% sold** (${sold.toLocaleString()}/${cap.toLocaleString()})${ev.revenue ? `, ${ev.revenue} gross` : ""}. Ask me to draft an announcement, analyze slow sales, suggest pricing, or polish your description.\n\n(Set ANTHROPIC_API_KEY for full AI answers.)`;
}

export async function POST(req: Request) {
  let body: { event?: EventCtx; messages?: Msg[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ev = body.event ?? {};
  const messages = (body.messages ?? []).slice(-12);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return Response.json({ reply: fallback(ev, messages), sourced: "fallback" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        system: systemPrompt(ev),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!r.ok) {
      return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: await r.text() });
    }
    const j = (await r.json()) as { content?: { type: string; text?: string }[] };
    const reply = (j.content ?? []).map((c) => c.text ?? "").join("").trim();
    return Response.json({ reply: reply || fallback(ev, messages), sourced: "claude" });
  } catch (e: unknown) {
    return Response.json({ reply: fallback(ev, messages), sourced: "fallback", error: String(e) });
  }
}
