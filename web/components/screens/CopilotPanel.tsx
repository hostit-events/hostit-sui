"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";

interface Msg {
  role: "user" | "assistant";
  content: string;
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

export function CopilotPanel({ event }: { event: any }) {
  const evName = event?.name ?? "your event";
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content: `Hi — I'm your **Event Co-pilot** for ${evName}. I'm grounded in your live numbers. Ask me to draft an announcement, analyze slow sales, suggest pricing, or polish your description.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setErr(null);
    const history = [...messages, { role: "user" as const, content }];
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
        }),
      });
      if (!res.ok) throw new Error(`Co-pilot request failed (${res.status})`);
      const j = (await res.json()) as { reply?: string; error?: string };
      const reply = (j.reply ?? "").trim();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply || "I couldn't generate a response. Try rephrasing." },
      ]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Something went wrong reaching the Co-pilot. Please try again." },
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
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={i} className="flex gap-2.5" style={{ alignItems: "flex-start" }}>
              <Sparkle />
              <div
                style={{
                  background: "var(--raise)",
                  border: "1px solid var(--hair)",
                  borderRadius: "4px 14px 14px 14px",
                  padding: "10px 13px",
                  maxWidth: "86%",
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: "var(--fg2)",
                }}
              >
                <Markdown content={m.content} />
              </div>
            </div>
          ) : (
            <div key={i} className="flex" style={{ justifyContent: "flex-end" }}>
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
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()} aria-label="Send">
          <Icon icon="ph:paper-plane-right-fill" size={16} />
        </button>
      </form>

      {err && (
        <div className="text-xs" style={{ padding: "0 18px 12px", color: "var(--color-danger)" }}>
          {err}
        </div>
      )}
    </div>
  );
}
