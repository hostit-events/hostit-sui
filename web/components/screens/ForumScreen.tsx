"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import type { SessionKey } from "@mysten/seal";
import type {
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  QueryEventsParams,
  PaginatedEvents,
} from "@mysten/sui/jsonRpc";
import { TICKET_TYPE, ENOKI_ENABLED } from "@/lib/config";
import { getFields } from "@/lib/ticketing";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { createSessionKey } from "@/lib/seal";
import {
  FORUM_CHANNELS,
  EV_FORUM_POST,
  encryptForumMessage,
  forumPostTx,
  decryptForumMessage,
} from "@/lib/forum";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";

// PostCreated event payload anchored on-chain by `forum::post`.
interface ForumPostJson {
  event_id: string;
  channel: string;
  blob_id: string;
  author: string;
  ts_ms: string | number;
}

// A message after (attempted) decryption.
interface DecodedMessage {
  blobId: string;
  channel: string;
  author: string;
  tsMs: number;
  text: string | null; // null => decrypt failed / not yet decrypted
}

const POLL_MS = 12_000;

export function ForumScreen({ id }: { id: string }) {
  const account = useCurrentAccount();
  const addr = account?.address ?? null;
  const suiClient = useCurrentClient();
  const dAppKit = useDAppKit();
  const { mutateAsync: signAndExecute, isPending: posting } = useSignAndExecute();

  // --- Gate: does the connected wallet own a ticket for THIS event? ---------
  const ownedQ = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: TICKET_TYPE },
      options: { showContent: true },
    },
    { enabled: Boolean(addr) },
  );

  const myTicketId = useMemo(() => {
    if (!ownedQ.data) return null;
    for (const entry of ownedQ.data.data) {
      const fields = getFields(entry);
      if (fields && String(fields.event_id) === id && entry.data?.objectId) {
        return entry.data.objectId;
      }
    }
    return null;
  }, [ownedQ.data, id]);

  const gatedIn = Boolean(addr && myTicketId);

  // --- Channels -------------------------------------------------------------
  const [channel, setChannel] = useState<string>(FORUM_CHANNELS[0]?.id ?? "general");

  // --- Posts (on-chain anchors) for this event ------------------------------
  const postsQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_FORUM_POST }, order: "descending", limit: 200 },
    { enabled: gatedIn, refetchInterval: gatedIn ? POLL_MS : false },
  );

  const channelPosts = useMemo<ForumPostJson[]>(() => {
    if (!postsQ.data) return [];
    return postsQ.data.data
      .map((ev) => ev.parsedJson as ForumPostJson)
      .filter((p) => p && p.event_id === id && p.channel === channel)
      .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms)); // oldest -> newest
  }, [postsQ.data, id, channel]);

  // --- Seal SessionKey (created lazily on first decrypt/post) ----------------
  const sessionRef = useRef<SessionKey | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const ensureSession = useCallback(async (): Promise<SessionKey | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (!addr) return null;
    setSigning(true);
    setSessionErr(null);
    try {
      const sk = await createSessionKey(suiClient, addr, async (message) => {
        const signer = new CurrentAccountSigner(dAppKit);
        const r = await signer.signPersonalMessage(message);
        return { signature: r.signature };
      });
      sessionRef.current = sk;
      setSessionReady(true);
      return sk;
    } catch (e: unknown) {
      setSessionErr(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setSigning(false);
    }
  }, [addr, suiClient, dAppKit]);

  // --- Decrypted message cache (keyed by blob id) ---------------------------
  const [decoded, setDecoded] = useState<Record<string, DecodedMessage>>({});

  // Decrypt any posts we haven't decoded yet for the active channel.
  useEffect(() => {
    if (!gatedIn || !myTicketId) return;
    const pending = channelPosts.filter(
      (p) => decoded[p.blob_id]?.text == null || decoded[p.blob_id] === undefined,
    );
    if (pending.length === 0) return;

    let alive = true;
    (async () => {
      // Only auto-create the session if it already exists; otherwise we keep
      // messages as "encrypted" until the user signs (no surprise wallet popups).
      const sk = sessionRef.current;
      for (const p of pending) {
        const base: DecodedMessage = {
          blobId: p.blob_id,
          channel: p.channel,
          author: p.author,
          tsMs: Number(p.ts_ms),
          text: null,
        };
        if (!sk) {
          if (alive) setDecoded((m) => ({ ...m, [p.blob_id]: m[p.blob_id] ?? base }));
          continue;
        }
        try {
          const body = await decryptForumMessage(
            suiClient,
            sk,
            p.blob_id,
            myTicketId,
            id,
          );
          if (alive)
            setDecoded((m) => ({ ...m, [p.blob_id]: { ...base, text: body.text } }));
        } catch {
          if (alive)
            setDecoded((m) => ({ ...m, [p.blob_id]: { ...base, text: null } }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [channelPosts, gatedIn, myTicketId, suiClient, id, sessionReady, decoded]);

  // Manual "decrypt / re-sign" action: create session then decode this channel.
  async function unlockMessages() {
    const sk = await ensureSession();
    if (!sk || !myTicketId) return;
    for (const p of channelPosts) {
      try {
        const body = await decryptForumMessage(suiClient, sk, p.blob_id, myTicketId, id);
        setDecoded((m) => ({
          ...m,
          [p.blob_id]: {
            blobId: p.blob_id,
            channel: p.channel,
            author: p.author,
            tsMs: Number(p.ts_ms),
            text: body.text,
          },
        }));
      } catch {
        setDecoded((m) => ({
          ...m,
          [p.blob_id]: {
            blobId: p.blob_id,
            channel: p.channel,
            author: p.author,
            tsMs: Number(p.ts_ms),
            text: null,
          },
        }));
      }
    }
  }

  // --- Composer -------------------------------------------------------------
  const [draft, setDraft] = useState("");
  const [postErr, setPostErr] = useState<string | null>(null);
  const [postDigest, setPostDigest] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // keep the stream pinned to the newest message
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channelPosts.length, decoded]);

  async function sendMessage() {
    const text = draft.trim();
    if (!text || !addr || !myTicketId) return;
    setPostErr(null);
    try {
      // Encrypt body to the event policy and pin it on Walrus.
      const blobId = await encryptForumMessage(suiClient, id, {
        text,
        author: addr,
        ts: Date.now(),
      });
      // Anchor the post on-chain (proves a valid ticket holder authored it).
      const tx = forumPostTx(id, myTicketId, channel, blobId);
      const out = await signAndExecute({ transaction: tx });
      setPostDigest(out.digest);
      setDraft("");
      // Optimistically show our own message immediately (we know the plaintext).
      setDecoded((m) => ({
        ...m,
        [blobId]: { blobId, channel, author: addr, tsMs: Date.now(), text },
      }));
      // Make sure a session exists so subsequent fetches can decrypt others'.
      void ensureSession();
      postsQ.refetch();
    } catch (e: unknown) {
      setPostErr(e instanceof Error ? e.message : String(e));
    }
  }

  // --- Render: not connected ------------------------------------------------
  if (!addr) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Connect your wallet"
          body="Forums are ticket-gated. Connect a wallet that holds a ticket for this event to join the conversation."
          cta="View event"
        />
      </ForumShell>
    );
  }

  // --- Render: gate (no ticket) ---------------------------------------------
  if (ownedQ.isLoading) {
    return (
      <ForumShell id={id}>
        <div className="card mono">Checking your tickets…</div>
      </ForumShell>
    );
  }

  if (!gatedIn) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Get a ticket to join"
          body="This is a private, end-to-end encrypted forum for ticket holders. Grab a ticket to unlock the channels, lineup chatter, ride-shares and the market."
          cta="Get a ticket"
        />
      </ForumShell>
    );
  }

  // --- Render: gated-in (rail + stream + composer) --------------------------
  const activeChannel = FORUM_CHANNELS.find((c) => c.id === channel);

  return (
    <ForumShell id={id}>
      <div
        className="grid gap-5"
        style={{ gridTemplateColumns: "minmax(180px, 220px) 1fr", alignItems: "start" }}
      >
        {/* Left rail: channels */}
        <aside className="card" style={{ position: "sticky", top: 16 }}>
          <span className="section-label">Channels</span>
          <div className="flex flex-col gap-1.5 mt-3">
            {FORUM_CHANNELS.map((c) => (
              <button
                key={c.id}
                className={`topnav-item ${channel === c.id ? "active" : ""}`}
                onClick={() => setChannel(c.id)}
                style={{ justifyContent: "flex-start", width: "100%" }}
              >
                <Icon icon={c.icon} size={16} /> {c.label}
              </button>
            ))}
          </div>
          <div
            className="mono"
            style={{ marginTop: 16, fontSize: 11, color: "var(--fg3)", lineHeight: 1.5 }}
          >
            <Icon icon="ic:round-lock" size={12} /> Seal-encrypted · ticket-gated
          </div>
        </aside>

        {/* Center: message stream + composer */}
        <section className="panel flex flex-col" style={{ minHeight: 460 }}>
          <header
            className="flex items-center justify-between"
            style={{ padding: "14px 18px", borderBottom: "1px solid var(--hair)" }}
          >
            <div className="flex items-center gap-2 font-semibold">
              <Icon icon={activeChannel?.icon ?? "ic:round-tag"} size={18} />
              {activeChannel?.label ?? channel}
            </div>
            <div className="flex items-center gap-2">
              {!sessionReady ? (
                <button
                  className="btn btn-sm"
                  disabled={signing}
                  onClick={unlockMessages}
                  title="Sign a session message to decrypt the thread (valid ~10 min)."
                >
                  <Icon icon="ic:round-lock-open" size={14} />
                  {signing ? "Signing…" : "Decrypt thread"}
                </button>
              ) : (
                <span className="badge badge-green">
                  <Icon icon="ic:round-lock-open" size={11} /> Session active
                </span>
              )}
            </div>
          </header>

          {sessionErr && (
            <div
              className="text-xs break-words"
              style={{ color: "var(--color-danger)", padding: "8px 18px" }}
            >
              {sessionErr}
            </div>
          )}

          <div
            ref={streamRef}
            className="grow flex flex-col gap-3"
            style={{ padding: 18, overflowY: "auto", maxHeight: 520 }}
          >
            {postsQ.isLoading && channelPosts.length === 0 ? (
              <div className="mono" style={{ color: "var(--fg3)" }}>
                Loading messages…
              </div>
            ) : channelPosts.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center grow text-center"
                style={{ color: "var(--fg3)", gap: 8, padding: "40px 0" }}
              >
                <Icon icon="ic:round-forum" size={40} />
                <div className="font-semibold" style={{ color: "var(--fg2)" }}>
                  No messages yet
                </div>
                <p className="text-sm">Be the first to post in #{activeChannel?.label}.</p>
              </div>
            ) : (
              channelPosts.map((p) => (
                <MessageRow
                  key={p.blob_id}
                  msg={
                    decoded[p.blob_id] ?? {
                      blobId: p.blob_id,
                      channel: p.channel,
                      author: p.author,
                      tsMs: Number(p.ts_ms),
                      text: null,
                    }
                  }
                  mine={p.author === addr}
                  onResign={unlockMessages}
                  sessionReady={sessionReady}
                />
              ))
            )}
          </div>

          {/* Composer */}
          <div
            className="flex items-end gap-2"
            style={{ padding: 14, borderTop: "1px solid var(--hair)" }}
          >
            <textarea
              className="textarea grow"
              style={{ minHeight: 52 }}
              placeholder={`Message #${activeChannel?.label ?? channel}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button
              className="btn btn-primary"
              disabled={posting || !draft.trim()}
              onClick={() => void sendMessage()}
              title="Encrypts to the event policy, pins to Walrus, anchors on-chain."
            >
              <Icon icon="ic:round-send" size={16} />
              {posting ? "Posting…" : "Send"}
            </button>
          </div>
          {postDigest && (
            <div className="text-xs" style={{ padding: "0 18px 12px" }}>
              <TxLink digest={postDigest} label="posted · tx" className="mono" style={{ color: "var(--color-success)" }} />
            </div>
          )}
          {postErr && (
            <div
              className="text-xs break-words"
              style={{ color: "var(--color-danger)", padding: "0 18px 12px" }}
            >
              {postErr}
            </div>
          )}
        </section>
      </div>
    </ForumShell>
  );
}

// ---------------------------------------------------------------------------
// Inline subcomponents
// ---------------------------------------------------------------------------

function ForumShell({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-6 screen-in">
      <header className="relative">
        <div
          className="glow"
          style={{
            width: 360,
            height: 360,
            background: "rgba(0,124,250,.4)",
            top: -150,
            right: -40,
            opacity: 0.2,
          }}
        />
        <span className="eyebrow">
          <Icon icon="ic:round-forum" size={14} /> Forum
        </span>
        <div className="flex items-center justify-between gap-3" style={{ marginTop: 12 }}>
          <h1 className="page-title" style={{ fontSize: 30 }}>
            Event chat
          </h1>
          <Link href={`/event/${id}`} className="btn btn-sm">
            <Icon icon="ic:round-arrow-back" size={15} /> Back to event
          </Link>
        </div>
        <p className="page-sub">
          Private, encrypted channels for ticket holders — powered by Walrus + Seal.
        </p>
      </header>
      {children}
    </div>
  );
}

function LockOverlay({
  id,
  title,
  body,
  cta,
}: {
  id: string;
  title: string;
  body: string;
  cta: string;
}) {
  return (
    <div className="card relative overflow-hidden" style={{ padding: 0 }}>
      <div className="poster" style={{ height: 140, ["--p1" as string]: "var(--hi-blue)", ["--p2" as string]: "var(--hi-magenta)" } as React.CSSProperties}>
        <div className="poster-noise" />
        <span className="poster-glyph">
          <Icon icon="ic:round-lock" size={72} />
        </span>
      </div>
      <div className="flex flex-col items-center text-center" style={{ padding: "28px 22px 30px", gap: 10 }}>
        <h2 className="page-title" style={{ fontSize: 22 }}>
          {title}
        </h2>
        <p className="page-sub" style={{ maxWidth: 460 }}>
          {body}
        </p>
        <Link href={`/event/${id}`} className="btn btn-primary btn-lg" style={{ marginTop: 6 }}>
          <Icon icon="ion:ticket" size={16} /> {cta}
        </Link>
      </div>
    </div>
  );
}

function MessageRow({
  msg,
  mine,
  onResign,
  sessionReady,
}: {
  msg: DecodedMessage;
  mine: boolean;
  onResign: () => void;
  sessionReady: boolean;
}) {
  const time = new Date(msg.tsMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div
      className="flex flex-col gap-1"
      style={{ alignItems: mine ? "flex-end" : "flex-start" }}
    >
      <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg3)" }}>
        {mine ? (
          <span className="badge badge-blue">you</span>
        ) : (
          <AddressDisplay address={msg.author} suffix={4} />
        )}
        <span className="mono">{time}</span>
      </div>
      <div
        className="card"
        style={{
          padding: "10px 14px",
          maxWidth: "78%",
          background: mine ? "rgba(0,124,250,.12)" : "var(--raise)",
          borderColor: mine ? "rgba(0,124,250,.32)" : "var(--hair)",
        }}
      >
        {msg.text != null ? (
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.text}</span>
        ) : (
          <button
            className="flex items-center gap-1.5 text-sm"
            style={{ color: "var(--hi-magenta)" }}
            onClick={onResign}
            title={sessionReady ? "Decrypt failed — re-sign your session." : "Sign a session to decrypt."}
          >
            <Icon icon="ic:round-lock" size={13} />
            [encrypted — re-sign session]
          </button>
        )}
      </div>
    </div>
  );
}
