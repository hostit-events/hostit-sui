"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useOrganizerMemory } from "@/lib/memoryClient";

interface Msg {
  id: string;
  role: "user" | "assistant";
  content: string;
}

// Per-message "Remember this" status, keyed by stable message id.
type RememberState = "idle" | "saving" | "saved" | "error";

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${msgSeq}`;
}

// Live event context handed to the Co-pilot. Mirrors the EventCtx contract in
// app/api/copilot/route.ts — every field is optional and treated defensively.
export interface CopilotEvent {
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

const QUICK_PROMPTS: { label: string; icon: string; prompt: string }[] = [
  {
    label: "Announcement",
    icon: "ph:megaphone-fill",
    prompt: "Draft a punchy launch announcement for this event I can post to social.",
  },
  {
    label: "Why slow?",
    icon: "ph:trend-down-fill",
    prompt: "Why might sales be slow, and what should I do this week to fix it?",
  },
  {
    label: "Suggest pricing",
    icon: "ph:tag-fill",
    prompt: "Suggest a pricing strategy based on my current sales and capacity.",
  },
  {
    label: "Polish description",
    icon: "ph:magic-wand-fill",
    prompt: "Polish my event description to make it punchier and convert better.",
  },
];

// Minimal inline markdown: **bold** inline + bullet lines starting with "-" / "•".
// Returns React nodes; intentionally tiny (no external markdown dep).
function renderInline(text: string, keyBase: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={`${keyBase}-b-${i}`} style={{ color: "var(--fg1)", fontWeight: 700 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyBase}-t-${i}`}>{part}</span>;
  });
}

function Markdown({ content }: { content: string }) {
  const lines = content.split("\n");
  const out: React.ReactNode[] = [];
  let bullets: { text: string; idx: number }[] = [];

  const flush = (key: string) => {
    if (!bullets.length) return;
    out.push(
      <ul key={`ul-${key}`} style={{ margin: "4px 0 6px", paddingLeft: 18, listStyle: "disc" }}>
        {bullets.map((b) => (
          <li key={`li-${b.idx}`} style={{ margin: "2px 0" }}>
            {renderInline(b.text, `li-${b.idx}`)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const m = line.match(/^\s*(?:-|•|\*)\s+(.*)$/);
    if (m) {
      bullets.push({ text: m[1], idx: i });
      return;
    }
    flush(String(i));
    if (line.trim() === "") {
      out.push(<div key={`sp-${i}`} style={{ height: 6 }} />);
    } else {
      out.push(
        <p key={`p-${i}`} style={{ margin: "2px 0" }}>
          {renderInline(line, `p-${i}`)}
        </p>,
      );
    }
  });
  flush("end");

  return <div style={{ whiteSpace: "normal", wordBreak: "break-word" }}>{out}</div>;
}

function Sparkle({ size = 14 }: { size?: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        borderRadius: "50%",
        flexShrink: 0,
        background: "rgba(0,124,250,.16)",
        color: "var(--hi-blue)",
      }}
    >
      <Icon icon="ph:sparkle-fill" size={size} />
    </span>
  );
}

// Small, low-emphasis affordance under an assistant reply. Writes that fact to
// the organizer's memory only on click — never automatically. Signing prompt
// behaviour depends on the wallet (silent for zkLogin, popup for external).
function RememberButton({
  state,
  onClick,
}: {
  state: RememberState;
  onClick: () => void;
}) {
  const saving = state === "saving";
  const saved = state === "saved";
  const error = state === "error";
  const label = saving
    ? "Saving…"
    : saved
      ? "Remembered"
      : error
        ? "Retry remember"
        : "Remember this";
  const icon = saving
    ? "ph:circle-notch-bold"
    : saved
      ? "ph:check-bold"
      : error
        ? "ph:warning-circle-fill"
        : "ph:bookmark-simple-bold";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving || saved}
      title={
        saved
          ? "Saved to your private organizer memory"
          : "Save this to your private organizer memory (you'll sign to confirm)"
      }
      style={{
        alignSelf: "flex-start",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 7,
        border: "1px solid var(--hair)",
        background: "transparent",
        color: error ? "var(--color-danger)" : saved ? "var(--color-success)" : "var(--fg3)",
        fontSize: 11.5,
        fontWeight: 600,
        cursor: saving || saved ? "default" : "pointer",
        opacity: saving ? 0.7 : 1,
      }}
    >
      <Icon
        icon={icon}
        size={12}
        style={saving ? { animation: "hi-cp-spin .8s linear infinite" } : undefined}
      />
      {label}
      <style>{`@keyframes hi-cp-spin{to{transform:rotate(360deg)}}`}</style>
    </button>
  );
}

export function CopilotPanel({ event }: { event: CopilotEvent }) {
  const evName = event?.name ?? "your event";
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: nextMsgId(),
      role: "assistant",
      content: `Hi — I'm your **Event Co-pilot** for ${evName}. I'm grounded in your live numbers. Ask me to draft an announcement, analyze slow sales, suggest pricing, or polish your description.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Organizer memory (MemWal). Recalled once on open from the event context and
  // sent to /api/copilot as grounding "past context". No-ops cleanly when there
  // is no connected wallet or the server-side layer is disabled.
  const { enabled: memoryEnabled, recall, remember } = useOrganizerMemory();
  const [recalled, setRecalled] = useState<string[]>([]);
  const [rememberState, setRememberState] = useState<Record<string, RememberState>>({});

  // Recall a few relevant organizer memories once per open. The query is built
  // from the event's identity so hits are scoped to this kind of event/context.
  // Best-effort: failures (incl. a declined wallet signature) just leave memory
  // empty and the co-pilot behaves exactly as before.
  const recallRanRef = useRef(false);
  useEffect(() => {
    if (!memoryEnabled || recallRanRef.current) return;
    recallRanRef.current = true;
    const query = [event?.name, event?.category, event?.city, event?.venue]
      .filter(Boolean)
      .join(" ")
      .trim();
    let alive = true;
    (async () => {
      const hits = await recall(query || "event organizing", 5);
      if (!alive || !hits) return;
      setRecalled(hits.map((h) => h.text));
    })();
    return () => {
      alive = false;
    };
  }, [memoryEnabled, recall, event?.name, event?.category, event?.city, event?.venue]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Explicit "Remember this" — writes one assistant fact to the organizer's
  // memory. Never auto-fires; only on a user click.
  const onRemember = useCallback(
    async (m: Msg) => {
      if (!memoryEnabled) return;
      setRememberState((s) => ({ ...s, [m.id]: "saving" }));
      try {
        const ok = await remember(m.content);
        setRememberState((s) => ({ ...s, [m.id]: ok ? "saved" : "idle" }));
      } catch {
        setRememberState((s) => ({ ...s, [m.id]: "error" }));
      }
    },
    [memoryEnabled, remember],
  );

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setErr(null);
    const history = [...messages, { id: nextMsgId(), role: "user" as const, content }];
    setMessages(history);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only user/assistant turns go to the model; drop the local greeting.
        body: JSON.stringify({
          event,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          // Recalled organizer memory as grounding "past context" (may be empty).
          memory: recalled,
        }),
      });
      if (!res.ok) throw new Error(`Co-pilot request failed (${res.status})`);
      const j = (await res.json()) as { reply?: string; error?: string };
      const reply = (j.reply ?? "").trim();
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: "assistant", content: reply || "I couldn't generate a response. Try rephrasing." },
      ]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setMessages((prev) => [
        ...prev,
        { id: nextMsgId(), role: "assistant", content: "Something went wrong reaching the Co-pilot. Please try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel screen-in" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 480 }}>
      {/* Header */}
      <div
        className="flex items-center gap-2"
        style={{ padding: "14px 18px", borderBottom: "1px solid var(--hair)" }}
      >
        <Sparkle size={16} />
        <div>
          <div style={{ fontWeight: 700, color: "var(--fg1)", letterSpacing: "-.01em" }}>Event Co-pilot</div>
          <div className="mono" style={{ marginTop: 1 }}>
            Grounded in {evName}
          </div>
        </div>
        {busy && (
          <span className="badge badge-soft" style={{ marginLeft: "auto" }}>
            <Icon icon="ph:sparkle-fill" size={11} /> Thinking
          </span>
        )}
      </div>

      {/* Message stream */}
      <div ref={scrollRef} role="log" aria-live="polite" aria-label="Co-pilot conversation" style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={m.id} className="flex gap-2.5" style={{ alignItems: "flex-start" }}>
              <Sparkle />
              <div style={{ maxWidth: "86%", display: "flex", flexDirection: "column", gap: 4 }}>
                <div
                  style={{
                    background: "var(--raise)",
                    border: "1px solid var(--hair)",
                    borderRadius: "4px 14px 14px 14px",
                    padding: "10px 13px",
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: "var(--fg2)",
                  }}
                >
                  <Markdown content={m.content} />
                </div>
                {/* Explicit "Remember this" — only on real replies (not the
                    greeting) and only when a wallet is connected (memory on). */}
                {memoryEnabled && i > 0 && (
                  <RememberButton
                    state={rememberState[m.id] ?? "idle"}
                    onClick={() => onRemember(m)}
                  />
                )}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex" style={{ justifyContent: "flex-end" }}>
              <div
                style={{
                  background: "var(--hi-blue)",
                  color: "#fff",
                  borderRadius: "14px 4px 14px 14px",
                  padding: "10px 13px",
                  maxWidth: "86%",
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {m.content}
              </div>
            </div>
          ),
        )}

        {busy && (
          <div className="flex gap-2.5" style={{ alignItems: "flex-start" }}>
            <Sparkle />
            <div
              style={{
                background: "var(--raise)",
                border: "1px solid var(--hair)",
                borderRadius: "4px 14px 14px 14px",
                padding: "12px 14px",
                display: "inline-flex",
                gap: 4,
                alignItems: "center",
              }}
            >
              {[0, 1, 2].map((d) => (
                <span
                  key={d}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--fg3)",
                    display: "inline-block",
                    animation: "hi-cp-blink 1.2s infinite ease-in-out",
                    animationDelay: `${d * 0.18}s`,
                  }}
                />
              ))}
              <style>{`@keyframes hi-cp-blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}`}</style>
            </div>
          </div>
        )}
      </div>

      {/* Quick-prompt chips */}
      <div className="flex gap-2 overflow-x-auto" style={{ padding: "0 18px 10px" }}>
        {QUICK_PROMPTS.map((p) => (
          <button
            key={p.label}
            className="chip"
            disabled={busy}
            onClick={() => send(p.prompt)}
            style={{ flexShrink: 0 }}
          >
            <Icon icon={p.icon} size={13} /> {p.label}
          </button>
        ))}
      </div>

      {/* Input + send */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex gap-2 items-center"
        style={{ padding: "12px 18px", borderTop: "1px solid var(--hair)" }}
      >
        <input
          className="input grow"
          placeholder="Ask your Co-pilot…"
          aria-label="Ask your Co-pilot"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()} aria-label="Send">
          <Icon icon="ph:paper-plane-right-fill" size={16} />
        </button>
      </form>

      {err && (
        <div role="alert" className="text-xs" style={{ padding: "0 18px 12px", color: "var(--color-danger)" }}>
          {err}
        </div>
      )}
    </div>
  );
}
