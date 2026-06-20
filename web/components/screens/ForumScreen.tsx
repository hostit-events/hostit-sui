"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useDAppKit } from "@mysten/dapp-kit-react";
import { CurrentAccountSigner } from "@mysten/dapp-kit-core";
import type { SessionKey } from "@mysten/seal";
import type {
  GetObjectParams,
  GetOwnedObjectsParams,
  PaginatedObjectsResponse,
  QueryEventsParams,
  PaginatedEvents,
  SuiObjectResponse,
} from "@mysten/sui/jsonRpc";
import { TICKET_TYPE, ORGANIZER_CAP_TYPE, ENOKI_ENABLED } from "@/lib/config";
import { getFields } from "@/lib/ticketing";
import {
  useCurrentAccount,
  useCurrentClient,
  useSignAndExecute,
  useSponsorAndExecute,
  useSuiQuery,
} from "@/lib/hooks";
import { humanizeError } from "@/lib/moveErrors";
import { createSessionKey } from "@/lib/seal";
import {
  FORUM_CHANNELS,
  EV_FORUM_POST,
  EV_FORUM_MODERATED,
  encryptForumMessage,
  forumPostTx,
  forumPostAsOrganizerTx,
  forumModerateTx,
  decryptForumMessage,
  foldModeration,
  MOD_HIDE,
  MOD_UNHIDE,
  MOD_PIN,
  MOD_UNPIN,
  type ForumCredential,
  type ModerationJson,
  type ModerationState,
} from "@/lib/forum";
import { AddressDisplay } from "@/components/AddressDisplay";
import { Icon } from "@/components/Icon";
import { TxLink } from "@/components/TxLink";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
  const regular = useSignAndExecute();
  const sponsored = useSponsorAndExecute();
  const posting = regular.isPending || sponsored.isPending;

  // --- Gate: does the wallet hold a ticket OR the organizer cap for THIS event? --
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

  const capsQ = useSuiQuery<
    "getOwnedObjects",
    GetOwnedObjectsParams,
    PaginatedObjectsResponse
  >(
    "getOwnedObjects",
    {
      owner: addr ?? "",
      filter: { StructType: ORGANIZER_CAP_TYPE },
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

  const myCapId = useMemo(() => {
    if (!capsQ.data) return null;
    for (const entry of capsQ.data.data) {
      const fields = getFields(entry);
      if (fields && String(fields.event_id) === id && entry.data?.objectId) {
        return entry.data.objectId;
      }
    }
    return null;
  }, [capsQ.data, id]);

  const isOrganizer = Boolean(myCapId);
  const gatedIn = Boolean(addr && (myTicketId || myCapId));

  // Credential used for decrypt + post. A ticket takes precedence (organizers who
  // also hold a ticket post as a normal member); otherwise the organizer cap.
  const cred = useMemo<ForumCredential | null>(
    () =>
      myTicketId
        ? { kind: "ticket", ticketId: myTicketId }
        : myCapId
          ? { kind: "organizer", capId: myCapId }
          : null,
    [myTicketId, myCapId],
  );

  // Event organizer address — to badge organizer-authored posts (for everyone).
  const eventQ = useSuiQuery<"getObject", GetObjectParams, SuiObjectResponse>(
    "getObject",
    { id, options: { showContent: true } },
    { enabled: gatedIn },
  );
  const organizerAddr = useMemo(() => {
    const f = getFields(eventQ.data ?? {});
    return f ? String(f.organizer) : null;
  }, [eventQ.data]);

  // --- Channels -------------------------------------------------------------
  const [channel, setChannel] = useState<string>(FORUM_CHANNELS[0]?.id ?? "general");

  // --- Posts (on-chain anchors) for this event ------------------------------
  const postsQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_FORUM_POST }, order: "descending", limit: 200 },
    { enabled: gatedIn, refetchInterval: gatedIn ? POLL_MS : false },
  );

  // --- Moderation tombstones (organizer hide/pin) ---------------------------
  const modQ = useSuiQuery<"queryEvents", QueryEventsParams, PaginatedEvents>(
    "queryEvents",
    { query: { MoveEventType: EV_FORUM_MODERATED }, order: "descending", limit: 200 },
    { enabled: gatedIn, refetchInterval: gatedIn ? POLL_MS : false },
  );

  const modState = useMemo<Map<string, ModerationState>>(() => {
    const rows = (modQ.data?.data ?? [])
      .map((ev) => ev.parsedJson as ModerationJson)
      .filter((m) => m && m.event_id === id);
    return foldModeration(rows);
  }, [modQ.data, id]);

  const channelPosts = useMemo<ForumPostJson[]>(() => {
    if (!postsQ.data) return [];
    return postsQ.data.data
      .map((ev) => ev.parsedJson as ForumPostJson)
      .filter((p) => p && p.event_id === id && p.channel === channel)
      .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms)); // oldest -> newest
  }, [postsQ.data, id, channel]);

  // Pinned posts surface to the top; the rest stay chronological.
  const orderedPosts = useMemo<ForumPostJson[]>(() => {
    const pinned = channelPosts.filter((p) => modState.get(p.blob_id)?.pinned);
    const rest = channelPosts.filter((p) => !modState.get(p.blob_id)?.pinned);
    return [...pinned, ...rest];
  }, [channelPosts, modState]);

  // --- Seal SessionKey (created lazily on first decrypt/post) ----------------
  const sessionRef = useRef<SessionKey | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [signing, setSigning] = useState(false);

  const ensureSession = useCallback(async (): Promise<SessionKey | null> => {
    if (sessionRef.current) return sessionRef.current;
    if (!addr) return null;
    setSigning(true);
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
      toast.error(humanizeError(e));
      return null;
    } finally {
      setSigning(false);
    }
  }, [addr, suiClient, dAppKit]);

  // --- Decrypted message cache (keyed by blob id) ---------------------------
  const [decoded, setDecoded] = useState<Record<string, DecodedMessage>>({});

  // Decrypt any posts we haven't decoded yet for the active channel.
  useEffect(() => {
    if (!gatedIn || !cred) return;
    const pending = channelPosts.filter(
      (p) => decoded[p.blob_id]?.text == null || decoded[p.blob_id] === undefined,
    );
    if (pending.length === 0) return;

    let alive = true;
    (async () => {
      // Only auto-decrypt if a session already exists; otherwise keep messages
      // "encrypted" until the user signs (no surprise wallet popups).
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
          const body = await decryptForumMessage(suiClient, sk, p.blob_id, cred, id);
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
  }, [channelPosts, gatedIn, cred, suiClient, id, sessionReady, decoded]);

  // Manual "decrypt / re-sign" action: create session then decode this channel.
  async function unlockMessages() {
    const sk = await ensureSession();
    if (!sk || !cred) return;
    for (const p of channelPosts) {
      const base: DecodedMessage = {
        blobId: p.blob_id,
        channel: p.channel,
        author: p.author,
        tsMs: Number(p.ts_ms),
        text: null,
      };
      try {
        const body = await decryptForumMessage(suiClient, sk, p.blob_id, cred, id);
        setDecoded((m) => ({ ...m, [p.blob_id]: { ...base, text: body.text } }));
      } catch {
        setDecoded((m) => ({ ...m, [p.blob_id]: base }));
      }
    }
  }

  // --- Composer -------------------------------------------------------------
  const [draft, setDraft] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  const MAX_MESSAGE_LEN = 1000;

  useEffect(() => {
    // keep the stream pinned to the newest message
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [orderedPosts.length, decoded]);

  async function sendMessage() {
    if (sendingRef.current) return;
    const text = draft.trim();
    if (!text || !addr || !cred) return;
    sendingRef.current = true;
    try {
      // Encrypt body to the event policy and pin it on Walrus.
      const blobId = await encryptForumMessage(suiClient, id, {
        text,
        author: addr,
        ts: Date.now(),
      });
      // Anchor the post on-chain — ticket holders via post, organizer via the cap.
      const tx =
        cred.kind === "ticket"
          ? forumPostTx(id, cred.ticketId, channel, blobId)
          : forumPostAsOrganizerTx(id, cred.capId, channel, blobId);
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success("Message posted", {
        description: <TxLink digest={out.digest} chars={10} />,
      });
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
      toast.error(humanizeError(e));
    } finally {
      sendingRef.current = false;
    }
  }

  // --- Moderation (organizer only) ------------------------------------------
  async function runModerate(blobId: string, action: number) {
    if (!myCapId || !addr) return;
    try {
      const tx = forumModerateTx(id, myCapId, blobId, action);
      const out = ENOKI_ENABLED
        ? await sponsored.mutateAsync({ transaction: tx, sender: addr })
        : await regular.mutateAsync({ transaction: tx });
      toast.success(
        action === MOD_HIDE
          ? "Post hidden"
          : action === MOD_UNHIDE
            ? "Post restored"
            : action === MOD_PIN
              ? "Post pinned"
              : "Post unpinned",
        { description: <TxLink digest={out.digest} chars={10} /> },
      );
      modQ.refetch();
    } catch (e: unknown) {
      toast.error(humanizeError(e));
    }
  }

  // --- Render: not connected ------------------------------------------------
  if (!addr) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Connect your wallet"
          body="Forums are private to an event's ticket holders and its organizer. Connect your wallet to join the conversation."
          cta="View event"
        />
      </ForumShell>
    );
  }

  // --- Render: gate (checking / error) --------------------------------------
  if (ownedQ.isLoading || capsQ.isLoading) {
    return (
      <ForumShell id={id}>
        <Card className="mono p-4">Checking your access…</Card>
      </ForumShell>
    );
  }

  if (ownedQ.isError && capsQ.isError) {
    return (
      <ForumShell id={id}>
        <Card className="flex flex-row flex-wrap items-center gap-2 p-4 text-destructive">
          Could not verify your access.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              ownedQ.refetch();
              capsQ.refetch();
            }}
          >
            Retry
          </Button>
        </Card>
      </ForumShell>
    );
  }

  if (!gatedIn) {
    return (
      <ForumShell id={id}>
        <LockOverlay
          id={id}
          title="Get a ticket to join"
          body="This is a private, end-to-end encrypted forum for ticket holders. Grab a ticket to unlock the channels, lineup chatter, ride-shares and the market. (Organizers get in with their event's organizer cap.)"
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
        className="grid gap-5 grid-cols-1 lg:grid-cols-[minmax(180px,220px)_1fr]"
        style={{ alignItems: "start" }}
      >
        {/* Left rail: channels */}
        <Card className="p-4" style={{ position: "sticky", top: 16 }}>
          <span className="section-label">Channels</span>
          <ToggleGroup
            type="single"
            value={channel}
            onValueChange={(v) => {
              if (v) setChannel(v);
            }}
            orientation="vertical"
            variant="outline"
            className="mt-3 w-full"
          >
            {FORUM_CHANNELS.map((c) => (
              <ToggleGroupItem
                key={c.id}
                value={c.id}
                aria-label={c.label}
                className="w-full justify-start"
              >
                <Icon icon={c.icon} size={16} /> {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {isOrganizer && (
            <Badge variant="secondary" className="mt-3">
              <Icon icon="streamline:star-badge-solid" size={11} /> Organizer
            </Badge>
          )}
          <div
            className="mono"
            style={{ marginTop: 16, fontSize: 11, color: "var(--fg3)", lineHeight: 1.5 }}
          >
            <Icon icon="ic:round-lock" size={12} /> Seal-encrypted ·{" "}
            {isOrganizer ? "organizer admin" : "ticket-gated"}
          </div>
        </Card>

        {/* Center: message stream + composer */}
        <Card className="flex flex-col gap-0 p-0" style={{ minHeight: 460 }}>
          <header
            className="flex items-center justify-between border-b"
            style={{ padding: "14px 18px" }}
          >
            <div className="flex items-center gap-2 font-semibold">
              <Icon icon={activeChannel?.icon ?? "ic:round-tag"} size={18} />
              {activeChannel?.label ?? channel}
            </div>
            <div className="flex items-center gap-2">
              {!sessionReady ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={signing}
                      onClick={unlockMessages}
                    >
                      <Icon icon="ic:round-lock-open" size={14} />
                      {signing ? "Signing…" : "Decrypt thread"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Sign a session message to decrypt the thread (valid ~10 min).
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Badge variant="secondary">
                  <Icon icon="ic:round-lock-open" size={11} /> Session active
                </Badge>
              )}
            </div>
          </header>

          <div
            ref={streamRef}
            className="grow flex flex-col gap-3"
            style={{ padding: 18, overflowY: "auto", maxHeight: 520 }}
          >
            {postsQ.isLoading && channelPosts.length === 0 ? (
              <div className="mono" style={{ color: "var(--fg3)" }}>
                Loading messages…
              </div>
            ) : postsQ.isError && channelPosts.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center grow text-center"
                style={{ color: "var(--color-danger)", gap: 8, padding: "40px 0" }}
              >
                <Icon icon="ic:round-error-outline" size={40} />
                <div className="font-semibold">Could not load messages</div>
                <Button variant="outline" size="sm" onClick={() => postsQ.refetch()}>
                  Retry
                </Button>
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
              orderedPosts.map((p) => (
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
                  isOrganizerPost={Boolean(organizerAddr && p.author === organizerAddr)}
                  mod={modState.get(p.blob_id)}
                  canModerate={isOrganizer}
                  onModerate={runModerate}
                  onResign={unlockMessages}
                  sessionReady={sessionReady}
                />
              ))
            )}
          </div>

          {/* Composer */}
          <div className="flex items-end gap-2 border-t" style={{ padding: 14 }}>
            <Textarea
              className="grow"
              style={{ minHeight: 52 }}
              placeholder={`Message #${activeChannel?.label ?? channel}…`}
              value={draft}
              maxLength={MAX_MESSAGE_LEN}
              disabled={posting}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (posting) return;
                  void sendMessage();
                }
              }}
            />
            <div className="flex flex-col items-end gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    disabled={posting || !draft.trim()}
                    onClick={() => void sendMessage()}
                  >
                    <Icon icon="ic:round-send" size={16} />
                    {posting ? "Posting…" : isOrganizer && !myTicketId ? "Send as organizer" : "Send"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Encrypts to the event policy, pins to Walrus, anchors on-chain.
                </TooltipContent>
              </Tooltip>
              <span
                className="mono"
                style={{ fontSize: 10, color: "var(--fg3)", whiteSpace: "nowrap" }}
              >
                {draft.length}/{MAX_MESSAGE_LEN} · ⌘/Ctrl+Enter
              </span>
            </div>
          </div>
        </Card>
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
          <Button asChild variant="outline" size="sm">
            <Link href={`/event/${id}`}>
              <Icon icon="ic:round-arrow-back" size={15} /> Back to event
            </Link>
          </Button>
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
    <Card className="relative gap-0 overflow-hidden p-0">
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
        <Button asChild size="lg" style={{ marginTop: 6 }}>
          <Link href={`/event/${id}`}>
            <Icon icon="ion:ticket" size={16} /> {cta}
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function MessageRow({
  msg,
  mine,
  isOrganizerPost,
  mod,
  canModerate,
  onModerate,
  onResign,
  sessionReady,
}: {
  msg: DecodedMessage;
  mine: boolean;
  isOrganizerPost: boolean;
  mod: ModerationState | undefined;
  canModerate: boolean;
  onModerate: (blobId: string, action: number) => void;
  onResign: () => void;
  sessionReady: boolean;
}) {
  const time = new Date(msg.tsMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hidden = Boolean(mod?.hidden);
  const pinned = Boolean(mod?.pinned);

  return (
    <div
      className="flex flex-col gap-1"
      style={{ alignItems: mine ? "flex-end" : "flex-start" }}
    >
      <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--fg3)" }}>
        {pinned && (
          <Badge variant="secondary">
            <Icon icon="ic:round-push-pin" size={11} /> pinned
          </Badge>
        )}
        {isOrganizerPost && (
          <Badge variant="secondary">
            <Icon icon="streamline:star-badge-solid" size={11} /> organizer
          </Badge>
        )}
        {mine ? (
          <Badge variant="default">you</Badge>
        ) : (
          <AddressDisplay address={msg.author} suffix={4} />
        )}
        <span className="mono">{time}</span>
        {canModerate && (
          <span className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={pinned ? "Unpin" : "Pin"}
                  onClick={() => onModerate(msg.blobId, pinned ? MOD_UNPIN : MOD_PIN)}
                >
                  <Icon icon={pinned ? "ic:round-push-pin" : "ic:outline-push-pin"} size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{pinned ? "Unpin" : "Pin"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={hidden ? "Unhide" : "Hide"}
                  onClick={() => onModerate(msg.blobId, hidden ? MOD_UNHIDE : MOD_HIDE)}
                >
                  <Icon icon={hidden ? "ic:round-visibility" : "ic:round-visibility-off"} size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{hidden ? "Unhide" : "Hide"}</TooltipContent>
            </Tooltip>
          </span>
        )}
      </div>

      {hidden ? (
        <Card className="bg-muted" style={{ padding: "10px 14px", maxWidth: "78%" }}>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
            <Icon icon="ic:round-visibility-off" size={13} /> Hidden by organizer
          </span>
        </Card>
      ) : (
        <Card
          className={mine ? "bg-primary/10" : "bg-muted"}
          style={{ padding: "10px 14px", maxWidth: "78%" }}
        >
          {msg.text != null ? (
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.text}</span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                  onClick={onResign}
                >
                  <Icon icon="ic:round-lock" size={13} />
                  [encrypted — re-sign session]
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {sessionReady ? "Decrypt failed — re-sign your session." : "Sign a session to decrypt."}
              </TooltipContent>
            </Tooltip>
          )}
        </Card>
      )}
    </div>
  );
}
